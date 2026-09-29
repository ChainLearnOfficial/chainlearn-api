import { test, describe, expect, beforeEach, afterEach } from "vitest";
import { db } from "../config/database.js";
import { redis } from "../config/redis.js";
import { quizService } from "../modules/quizzes/quiz.service.js";
import { MAX_QUIZ_GENERATIONS_PER_MODULE_PER_HOUR } from "../modules/quizzes/quiz.types.js";
import { RateLimitError } from "../utils/errors.js";
import { courses, enrollments, users, quizzes } from "../database/schema.js";
import { eq } from "drizzle-orm";

describe("Quiz generation rate limiting (#291)", () => {
  const mockUserId = "e1a2d3e4-1111-4ef8-bb6d-6bb9bd380a55";
  const otherModuleUserId = "e1a2d3e4-1111-4ef8-bb6d-6bb9bd380a56";
  const mockCourseId = "e1a2d3e4-2222-4b92-b60d-8848db490a66";
  const mockModuleId = "rate-limit-module-1";
  const otherModuleId = "rate-limit-module-2";

  let infraAvailable = true;

  beforeEach(async () => {
    try {
      await redis.flushdb();

      await db
        .insert(users)
        .values({
          id: mockUserId,
          stellarAddress:
            "GRATELIMIT000000000000000000000000000000000000000000001",
          displayName: "Rate Limit Test User",
          credits: 0,
        })
        .onConflictDoNothing();

      await db
        .insert(courses)
        .values({
          id: mockCourseId,
          title: "Rate Limit Test Course",
          description: "For quiz generation rate limit tests",
          difficulty: "beginner",
          isActive: true,
        })
        .onConflictDoNothing();

      await db
        .insert(enrollments)
        .values({ userId: mockUserId, courseId: mockCourseId })
        .onConflictDoNothing();

      // Pre-seed a quiz for mockModuleId so generateQuiz takes the
      // existing-quiz short-circuit (no AI service call needed) — the rate
      // limit check runs before that lookup, so it's still exercised.
      await db
        .insert(quizzes)
        .values({
          courseId: mockCourseId,
          moduleId: mockModuleId,
          questions: [
            { id: "q1", text: "2+2?", options: ["3", "4"], correctIndex: 1 },
          ],
          generatedFor: mockUserId,
        })
        .onConflictDoNothing();
    } catch {
      infraAvailable = false;
    }
  });

  afterEach(async () => {
    if (!infraAvailable) return;
    await db.delete(quizzes).where(eq(quizzes.courseId, mockCourseId));
    await db.delete(enrollments).where(eq(enrollments.userId, mockUserId));
    await db.delete(courses).where(eq(courses.id, mockCourseId));
    await db.delete(users).where(eq(users.id, mockUserId));
  });

  test(`allows up to ${MAX_QUIZ_GENERATIONS_PER_MODULE_PER_HOUR} generations per user per module per hour`, async () => {
    if (!infraAvailable) return;

    for (let i = 0; i < MAX_QUIZ_GENERATIONS_PER_MODULE_PER_HOUR; i++) {
      const quiz = await quizService.generateQuiz(mockUserId, {
        courseId: mockCourseId,
        moduleId: mockModuleId,
      });
      expect(quiz.moduleId).toBe(mockModuleId);
    }
  });

  test(`rejects the (${MAX_QUIZ_GENERATIONS_PER_MODULE_PER_HOUR + 1})th generation with RateLimitError carrying a positive retryAfterSeconds`, async () => {
    if (!infraAvailable) return;

    for (let i = 0; i < MAX_QUIZ_GENERATIONS_PER_MODULE_PER_HOUR; i++) {
      await quizService.generateQuiz(mockUserId, {
        courseId: mockCourseId,
        moduleId: mockModuleId,
      });
    }

    await expect(
      quizService.generateQuiz(mockUserId, {
        courseId: mockCourseId,
        moduleId: mockModuleId,
      }),
    ).rejects.toThrow(RateLimitError);

    try {
      await quizService.generateQuiz(mockUserId, {
        courseId: mockCourseId,
        moduleId: mockModuleId,
      });
      expect.fail("expected RateLimitError to be thrown");
    } catch (err) {
      expect(err).toBeInstanceOf(RateLimitError);
      const rateLimitErr = err as RateLimitError;
      expect(rateLimitErr.statusCode).toBe(429);
      expect(rateLimitErr.retryAfterSeconds).toBeGreaterThan(0);
      expect(rateLimitErr.retryAfterSeconds).toBeLessThanOrEqual(60 * 60);
    }
  });

  test("rate limit is scoped per module — a different module for the same user is unaffected", async () => {
    if (!infraAvailable) return;

    await db
      .insert(users)
      .values({
        id: otherModuleUserId,
        stellarAddress:
          "GRATELIMIT000000000000000000000000000000000000000000002",
        displayName: "Rate Limit Test User 2",
        credits: 0,
      })
      .onConflictDoNothing();
    await db
      .insert(enrollments)
      .values({ userId: otherModuleUserId, courseId: mockCourseId })
      .onConflictDoNothing();

    for (let i = 0; i < MAX_QUIZ_GENERATIONS_PER_MODULE_PER_HOUR; i++) {
      await quizService.generateQuiz(mockUserId, {
        courseId: mockCourseId,
        moduleId: mockModuleId,
      });
    }
    await expect(
      quizService.generateQuiz(mockUserId, {
        courseId: mockCourseId,
        moduleId: mockModuleId,
      }),
    ).rejects.toThrow(RateLimitError);

    // Same user, different module — pre-seed a quiz there too so this stays
    // on the existing-quiz short-circuit rather than calling the AI service.
    await db
      .insert(quizzes)
      .values({
        courseId: mockCourseId,
        moduleId: otherModuleId,
        questions: [
          { id: "q1", text: "2+2?", options: ["3", "4"], correctIndex: 1 },
        ],
        generatedFor: mockUserId,
      })
      .onConflictDoNothing();

    const quiz = await quizService.generateQuiz(mockUserId, {
      courseId: mockCourseId,
      moduleId: otherModuleId,
    });
    expect(quiz.moduleId).toBe(otherModuleId);

    await db
      .delete(users)
      .where(eq(users.id, otherModuleUserId));
  });

  test("rate limit is scoped per user — a different user for the same module is unaffected", async () => {
    if (!infraAvailable) return;

    await db
      .insert(users)
      .values({
        id: otherModuleUserId,
        stellarAddress:
          "GRATELIMIT000000000000000000000000000000000000000000003",
        displayName: "Rate Limit Test User 3",
        credits: 0,
      })
      .onConflictDoNothing();
    await db
      .insert(enrollments)
      .values({ userId: otherModuleUserId, courseId: mockCourseId })
      .onConflictDoNothing();

    for (let i = 0; i < MAX_QUIZ_GENERATIONS_PER_MODULE_PER_HOUR; i++) {
      await quizService.generateQuiz(mockUserId, {
        courseId: mockCourseId,
        moduleId: mockModuleId,
      });
    }
    await expect(
      quizService.generateQuiz(mockUserId, {
        courseId: mockCourseId,
        moduleId: mockModuleId,
      }),
    ).rejects.toThrow(RateLimitError);

    // Different user, same module + course, same pre-seeded quiz's module —
    // but generatedFor is scoped to mockUserId, so this user has no
    // existing quiz for this module and would call the AI service. Instead
    // assert only that this user's own counter is unaffected by asserting
    // no RateLimitError is thrown before the AI-service call is reached
    // (which itself is allowed to fail/fall back — that's not what's under
    // test here).
    await expect(
      quizService.generateQuiz(otherModuleUserId, {
        courseId: mockCourseId,
        moduleId: mockModuleId,
      }),
    ).resolves.toBeDefined();

    // generateQuiz for this user/module had no pre-seeded quiz, so it went
    // through the (unreachable AI service -> placeholder fallback) path and
    // inserted its own quiz row — clean that up before the user FK.
    await db.delete(quizzes).where(eq(quizzes.generatedFor, otherModuleUserId));
    await db.delete(users).where(eq(users.id, otherModuleUserId));
  });
});
