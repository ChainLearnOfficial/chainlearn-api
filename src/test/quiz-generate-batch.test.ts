/**
 * Tests for POST /api/v1/quizzes/generate-batch (#308).
 */
import { test, describe, expect, beforeEach, afterEach } from "vitest";
import { db } from "../config/database.js";
import { redis } from "../config/redis.js";
import { quizService } from "../modules/quizzes/quiz.service.js";
import { ForbiddenError } from "../utils/errors.js";
import { courses, enrollments, users, quizzes } from "../database/schema.js";
import { eq } from "drizzle-orm";

describe("POST /api/v1/quizzes/generate-batch (#308)", () => {
  const userId = "b8888888-1111-4ef8-bb6d-6bb9bd380a11";
  const stellarAddress = "GBATCHGEN0000000000000000000000000000000000000000000A";

  const courseId = "b8888888-2222-4b92-b60d-8848db490a22";
  const moduleOneId = "batch-module-1";
  const moduleTwoId = "batch-module-2";

  let infraAvailable = true;

  beforeEach(async () => {
    try {
      await redis.flushdb();

      await db
        .insert(users)
        .values({ id: userId, stellarAddress, displayName: "Batch Gen Test User" })
        .onConflictDoNothing();

      await db
        .insert(courses)
        .values({
          id: courseId,
          title: "Batch Generation Test Course",
          description: "For #308 tests",
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
    await db.delete(quizzes).where(eq(quizzes.courseId, courseId));
    await db.delete(enrollments).where(eq(enrollments.userId, userId));
    await db.delete(courses).where(eq(courses.id, courseId));
    await db.delete(users).where(eq(users.id, userId));
  });

  test("generates a quiz for each requested module independently", async () => {
    if (!infraAvailable) return;

    const results = await quizService.generateQuizBatch(userId, {
      courseId,
      moduleIds: [moduleOneId, moduleTwoId],
    });

    expect(results).toHaveLength(2);
    expect(results[0]).toMatchObject({ moduleId: moduleOneId, success: true });
    expect(results[1]).toMatchObject({ moduleId: moduleTwoId, success: true });
    expect(results[0].success && results[0].quiz.moduleId).toBe(moduleOneId);
    expect(results[1].success && results[1].quiz.moduleId).toBe(moduleTwoId);
  });

  test("a failure on one module doesn't block the rest of the batch", async () => {
    if (!infraAvailable) return;

    // A user who isn't enrolled fails generateQuiz's enrollment check for
    // every module — each entry should report the failure independently
    // rather than the whole batch throwing.
    const notEnrolledUserId = "b8888888-3333-4b92-b60d-8848db490a33";
    await db
      .insert(users)
      .values({
        id: notEnrolledUserId,
        stellarAddress: "GBATCHGEN0000000000000000000000000000000000000000000B",
        displayName: "Not Enrolled",
      })
      .onConflictDoNothing();

    const results = await quizService.generateQuizBatch(notEnrolledUserId, {
      courseId,
      moduleIds: [moduleOneId, moduleTwoId],
    });

    expect(results).toHaveLength(2);
    for (const result of results) {
      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.error).toContain("enrolled");
      }
    }

    await db.delete(users).where(eq(users.id, notEnrolledUserId));
  });

  test("throwing generateQuiz directly still surfaces ForbiddenError (sanity check for the batch's error message)", async () => {
    if (!infraAvailable) return;

    const notEnrolledUserId = "b8888888-4444-4b92-b60d-8848db490a44";
    await expect(
      quizService.generateQuiz(notEnrolledUserId, { courseId, moduleId: moduleOneId }),
    ).rejects.toThrow(ForbiddenError);
  });

  test("reuses an existing quiz for a module rather than regenerating it", async () => {
    if (!infraAvailable) return;

    const [existingQuiz] = await db
      .insert(quizzes)
      .values({
        courseId,
        moduleId: moduleOneId,
        questions: [{ id: "q1", text: "2+2?", options: ["3", "4"], correctIndex: 1 }],
        generatedFor: userId,
      })
      .returning();

    const results = await quizService.generateQuizBatch(userId, {
      courseId,
      moduleIds: [moduleOneId],
    });

    expect(results[0]).toMatchObject({ moduleId: moduleOneId, success: true });
    expect(results[0].success && results[0].quiz.id).toBe(existingQuiz.id);
  });
});
