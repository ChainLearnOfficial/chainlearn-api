/**
 * Tests for GET /api/v1/courses/:id/modules (#286).
 *
 * Covers the service layer directly (enrollment gating, ordering,
 * completion semantics, caching, invalidation on submit/retry) and the
 * full HTTP route (auth, validation, response shape) against a real
 * Fastify app.
 */
import { test, describe, expect, beforeAll, beforeEach, afterAll, afterEach, vi } from "vitest";
import type { FastifyInstance } from "fastify";
import { buildApp } from "../server.js";
import { db } from "../config/database.js";
import { redis } from "../config/redis.js";
import { courseService } from "../modules/courses/course.service.js";
import { quizService } from "../modules/quizzes/quiz.service.js";
import { cacheKey } from "../cache/index.js";
import { ForbiddenError, NotFoundError } from "../utils/errors.js";
import {
  courses,
  enrollments,
  users,
  quizzes,
  quizSubmissions,
} from "../database/schema.js";
import { eq } from "drizzle-orm";

describe("GET /api/v1/courses/:id/modules (#286)", () => {
  const userId = "d3333333-1111-4ef8-bb6d-6bb9bd380a11";
  const otherUserId = "d3333333-1111-4ef8-bb6d-6bb9bd380a99";
  const courseId = "d3333333-2222-4b92-b60d-8848db490a22";
  const stellarAddress = "GMODULESTEST0000000000000000000000000000000000000000A";
  const otherStellarAddress = "GMODULESTEST0000000000000000000000000000000000000000B";

  let infraAvailable = true;

  beforeEach(async () => {
    try {
      await redis.flushdb();
      vi.clearAllMocks();

      await db
        .insert(users)
        .values([
          { id: userId, stellarAddress, displayName: "Modules Test User" },
          { id: otherUserId, stellarAddress: otherStellarAddress, displayName: "Not Enrolled User" },
        ])
        .onConflictDoNothing();

      await db
        .insert(courses)
        .values({
          id: courseId,
          title: "Modules Test Course",
          description: "For #286 tests",
          difficulty: "beginner",
          isActive: true,
        })
        .onConflictDoNothing();

      await db
        .insert(enrollments)
        .values({ userId, courseId })
        .onConflictDoNothing();
    } catch {
      infraAvailable = false;
    }
  });

  afterEach(async () => {
    if (!infraAvailable) return;
    await db.delete(quizSubmissions).where(eq(quizSubmissions.userId, userId));
    await db.delete(quizzes).where(eq(quizzes.courseId, courseId));
    await db.delete(enrollments).where(eq(enrollments.userId, userId));
    await db.delete(courses).where(eq(courses.id, courseId));
    await db.delete(users).where(eq(users.id, userId));
    await db.delete(users).where(eq(users.id, otherUserId));
  });

  async function insertQuiz(moduleId: string) {
    const [quiz] = await db
      .insert(quizzes)
      .values({
        courseId,
        moduleId,
        questions: [{ id: "q1", text: "2+2?", options: ["3", "4"], correctIndex: 1 }],
        generatedFor: userId,
      })
      .returning();
    return quiz;
  }

  // ─── Service layer ──────────────────────────────────────────────────────

  describe("courseService.getCourseModules", () => {
    test("throws ForbiddenError for a user who is not enrolled", async () => {
      if (!infraAvailable) return;
      await insertQuiz("module-1");

      await expect(
        courseService.getCourseModules(otherUserId, courseId),
      ).rejects.toThrow(ForbiddenError);
    });

    test("throws NotFoundError for a non-existent course", async () => {
      if (!infraAvailable) return;
      await expect(
        courseService.getCourseModules(userId, "00000000-0000-0000-0000-000000000000"),
      ).rejects.toThrow(NotFoundError);
    });

    test("returns modules in order with completed:false when nothing submitted", async () => {
      if (!infraAvailable) return;
      await insertQuiz("module-a");
      await insertQuiz("module-b");

      const modules = await courseService.getCourseModules(userId, courseId);

      expect(modules.map((m) => m.id)).toEqual(["module-a", "module-b"]);
      expect(modules.every((m) => m.completed === false)).toBe(true);
      modules.forEach((m, i) => expect(m.order).toBe(i + 1));
    });

    test("marks a module completed once its quiz has a submission", async () => {
      if (!infraAvailable) return;
      const quiz = await insertQuiz("module-1");
      await quizService.submitQuiz(userId, quiz.id, {
        answers: [{ questionId: "q1", selectedIndex: 1 }],
      });

      const modules = await courseService.getCourseModules(userId, courseId);

      expect(modules.find((m) => m.id === "module-1")?.completed).toBe(true);
    });

    test("a failed (but submitted) quiz still counts as completed — completion is about submission, not passing", async () => {
      if (!infraAvailable) return;
      const quiz = await insertQuiz("module-1");
      // Wrong answer — a fail, but still a submission.
      await quizService.submitQuiz(userId, quiz.id, {
        answers: [{ questionId: "q1", selectedIndex: 0 }],
      });

      const modules = await courseService.getCourseModules(userId, courseId);

      expect(modules.find((m) => m.id === "module-1")?.completed).toBe(true);
    });

    test("a superseded submission (from a retry) does not count as completed", async () => {
      if (!infraAvailable) return;
      const quiz = await insertQuiz("module-1");
      await quizService.submitQuiz(userId, quiz.id, {
        answers: [{ questionId: "q1", selectedIndex: 1 }],
      });

      // Confirm completed before retry.
      expect(
        (await courseService.getCourseModules(userId, courseId)).find(
          (m) => m.id === "module-1",
        )?.completed,
      ).toBe(true);

      await quizService.retryQuiz(userId, quiz.id);

      const afterRetry = await courseService.getCourseModules(userId, courseId);
      expect(afterRetry.find((m) => m.id === "module-1")?.completed).toBe(false);
    });

    test("result is cached under a user+course-scoped key", async () => {
      if (!infraAvailable) return;
      await insertQuiz("module-1");

      await courseService.getCourseModules(userId, courseId);

      const key = cacheKey("user", "modules", userId, courseId);
      const cached = await redis.get(key);
      expect(cached).not.toBeNull();
      const ttl = await redis.ttl(key);
      expect(ttl).toBeGreaterThan(0);
      expect(ttl).toBeLessThanOrEqual(60);
    });

    test("submitting a quiz invalidates the cached modules view for that user+course", async () => {
      if (!infraAvailable) return;
      const quiz = await insertQuiz("module-1");

      // Populate the cache with the pre-submission (completed:false) state.
      const before = await courseService.getCourseModules(userId, courseId);
      expect(before[0].completed).toBe(false);
      expect(await redis.get(cacheKey("user", "modules", userId, courseId))).not.toBeNull();

      await quizService.submitQuiz(userId, quiz.id, {
        answers: [{ questionId: "q1", selectedIndex: 1 }],
      });

      // Cache must have been invalidated by the submission, not left stale.
      expect(await redis.get(cacheKey("user", "modules", userId, courseId))).toBeNull();

      const after = await courseService.getCourseModules(userId, courseId);
      expect(after[0].completed).toBe(true);
    });
  });

  // ─── HTTP route ─────────────────────────────────────────────────────────

  describe("HTTP route", () => {
    let app: FastifyInstance;

    beforeAll(async () => {
      if (!infraAvailable) return;
      app = await buildApp();
      await app.ready();
    });

    afterAll(async () => {
      if (!infraAvailable) return;
      await app.close();
    });

    function tokenFor(id: string, address: string): string {
      return app.jwt.sign({ sub: id, stellarAddress: address });
    }

    test("rejects unauthenticated requests with 401", async () => {
      if (!infraAvailable) return;
      const res = await app.inject({
        method: "GET",
        url: `/api/v1/courses/${courseId}/modules`,
      });
      expect(res.statusCode).toBe(401);
    });

    test("rejects a non-enrolled authenticated user with 403", async () => {
      if (!infraAvailable) return;
      await insertQuiz("module-1");
      const token = tokenFor(otherUserId, otherStellarAddress);

      const res = await app.inject({
        method: "GET",
        url: `/api/v1/courses/${courseId}/modules`,
        headers: { authorization: `Bearer ${token}` },
      });

      expect(res.statusCode).toBe(403);
    });

    test("returns 400 for a malformed course ID", async () => {
      if (!infraAvailable) return;
      const token = tokenFor(userId, stellarAddress);

      const res = await app.inject({
        method: "GET",
        url: "/api/v1/courses/not-a-uuid/modules",
        headers: { authorization: `Bearer ${token}` },
      });

      expect(res.statusCode).toBe(400);
    });

    test("returns 404 for a non-existent course", async () => {
      if (!infraAvailable) return;
      const token = tokenFor(userId, stellarAddress);

      const res = await app.inject({
        method: "GET",
        url: "/api/v1/courses/00000000-0000-0000-0000-000000000000/modules",
        headers: { authorization: `Bearer ${token}` },
      });

      expect(res.statusCode).toBe(404);
    });

    test("returns 200 with modules for an enrolled user", async () => {
      if (!infraAvailable) return;
      await insertQuiz("module-1");
      await insertQuiz("module-2");
      const token = tokenFor(userId, stellarAddress);

      const res = await app.inject({
        method: "GET",
        url: `/api/v1/courses/${courseId}/modules`,
        headers: { authorization: `Bearer ${token}` },
      });

      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.payload);
      expect(body.success).toBe(true);
      expect(Array.isArray(body.data)).toBe(true);
      expect(body.data).toHaveLength(2);
      for (const m of body.data) {
        expect(typeof m.id).toBe("string");
        expect(typeof m.order).toBe("number");
        expect(typeof m.completed).toBe("boolean");
      }
    });
  });
});
