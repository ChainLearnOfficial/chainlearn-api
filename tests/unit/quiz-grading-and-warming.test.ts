import { test, describe, expect, beforeEach, afterEach, vi } from "vitest";
import { db } from "../../src/config/database.js";
import { redis } from "../../src/config/redis.js";
import { quizService } from "../../src/modules/quizzes/quiz.service.js";
import { PASSING_PERCENTAGE } from "../../src/modules/quizzes/quiz.types.js";
import { cacheKey } from "../../src/cache/index.js";
import { warmCourseCache } from "../../src/cache/warmer.js";
import { logger } from "../../src/utils/logger.js";
import {
  courses,
  enrollments,
  users,
  quizSubmissions,
  quizzes,
} from "../../src/database/schema.js";
import { eq } from "drizzle-orm";

describe("Quiz grading edge cases & cache warming (#143, #144, #145, #147)", () => {
  const mockUserId = "f1a2b3c4-1111-4ef8-bb6d-6bb9bd380a11";
  const mockCourseId = "f1a2b3c4-2222-4b92-b60d-8848db490a22";
  const mockModuleId = "module-1";

  let infraAvailable = true;

  beforeEach(async () => {
    try {
      await redis.flushdb();
      vi.clearAllMocks();

      await db
        .insert(users)
        .values({
          id: mockUserId,
          stellarAddress:
            "GBAXL3624V2V6R3E4W67ZXLN76K4E3U5V62M3X7A4P5R6S7T8U9V0W1B",
          displayName: "Grading Test User",
          credits: 0,
        })
        .onConflictDoNothing();

      await db
        .insert(courses)
        .values({
          id: mockCourseId,
          title: "Grading Test Course",
          description: "For grading edge case tests",
          difficulty: "beginner",
          isActive: true,
        })
        .onConflictDoNothing();

      await db
        .insert(enrollments)
        .values({ userId: mockUserId, courseId: mockCourseId })
        .onConflictDoNothing();
    } catch {
      infraAvailable = false;
    }
  });

  afterEach(async () => {
    if (!infraAvailable) return;
    await db.delete(quizSubmissions).where(eq(quizSubmissions.userId, mockUserId));
    await db.delete(quizzes).where(eq(quizzes.courseId, mockCourseId));
    await db.delete(enrollments).where(eq(enrollments.userId, mockUserId));
    await db.delete(courses).where(eq(courses.id, mockCourseId));
    await db.delete(users).where(eq(users.id, mockUserId));
  });

  test("PASSING_PERCENTAGE is a single shared constant (#143)", () => {
    expect(PASSING_PERCENTAGE).toBe(70);
  });

  test("an answer with an unrecognized questionId is skipped and logged, not silently ignored (#144)", async () => {
    if (!infraAvailable) return;

    const [quiz] = await db
      .insert(quizzes)
      .values({
        courseId: mockCourseId,
        moduleId: mockModuleId,
        questions: [
          { id: "q1", text: "2+2?", options: ["3", "4"], correctIndex: 1 },
        ],
        generatedFor: mockUserId,
      })
      .returning();

    const warnSpy = vi.spyOn(logger, "warn");

    const result = await quizService.submitQuiz(mockUserId, quiz.id, {
      answers: [
        { questionId: "q1", selectedIndex: 1 },
        { questionId: "does-not-exist", selectedIndex: 0 },
      ],
    });

    expect(result.score).toBe(1);
    expect(result.totalQuestions).toBe(1);
    expect(warnSpy).toHaveBeenCalledWith(
      expect.objectContaining({ questionId: "does-not-exist" }),
      expect.stringContaining("unrecognized questionId"),
    );
  });

  test("an out-of-range selectedIndex is treated as incorrect and logged, not accepted as valid (#145)", async () => {
    if (!infraAvailable) return;

    const [quiz] = await db
      .insert(quizzes)
      .values({
        courseId: mockCourseId,
        moduleId: mockModuleId,
        questions: [
          {
            id: "q1",
            text: "Pick the Stellar asset code length limit",
            options: ["4", "12"],
            correctIndex: 1,
          },
        ],
        generatedFor: mockUserId,
      })
      .returning();

    const warnSpy = vi.spyOn(logger, "warn");

    // Only 2 options (indices 0-1) exist, but the request schema allows up
    // to 20 — index 19 must not be scored as a legitimate wrong answer
    // without at least being flagged.
    const result = await quizService.submitQuiz(mockUserId, quiz.id, {
      answers: [{ questionId: "q1", selectedIndex: 19 }],
    });

    expect(result.score).toBe(0);
    expect(result.passed).toBe(false);
    expect(warnSpy).toHaveBeenCalledWith(
      expect.objectContaining({
        questionId: "q1",
        selectedIndex: 19,
        optionsCount: 2,
      }),
      expect.stringContaining("out of range"),
    );
  });

  test("warmCourseCache warms every page, not just page 1 (#147)", async () => {
    if (!infraAvailable) return;

    // Seed enough courses to require 2 pages at the warmer's page size (20).
    const extraCourseIds: string[] = [];
    for (let i = 0; i < 25; i++) {
      const [course] = await db
        .insert(courses)
        .values({
          title: `Warm Test Course ${i}`,
          description: "warming filler",
          difficulty: "beginner",
          isActive: true,
        })
        .returning();
      extraCourseIds.push(course.id);
    }

    try {
      const page1Key = cacheKey("courses", "list", "all", 1, 20);
      const page2Key = cacheKey("courses", "list", "all", 2, 20);

      expect(await redis.get(page1Key)).toBeNull();
      expect(await redis.get(page2Key)).toBeNull();

      await warmCourseCache();

      const page1Cached = await redis.get(page1Key);
      const page2Cached = await redis.get(page2Key);

      expect(page1Cached).not.toBeNull();
      expect(page2Cached).not.toBeNull();
    } finally {
      for (const id of extraCourseIds) {
        await db.delete(courses).where(eq(courses.id, id));
      }
    }
  });
});
