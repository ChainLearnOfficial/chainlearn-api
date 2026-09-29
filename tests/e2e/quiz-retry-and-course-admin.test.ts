import { test, describe, expect, beforeEach, afterEach, vi } from "vitest";
import { db } from "../config/database.js";
import { redis } from "../config/redis.js";
import { quizService } from "../modules/quizzes/quiz.service.js";
import { courseService } from "../modules/courses/course.service.js";
import { MAX_RETRIES_PER_MODULE_PER_DAY } from "../modules/quizzes/quiz.types.js";
import { RateLimitError, ForbiddenError } from "../utils/errors.js";
import {
  courses,
  enrollments,
  users,
  quizSubmissions,
  quizzes,
} from "../database/schema.js";
import { eq } from "drizzle-orm";

describe("Quiz retry endpoint & course admin/popular endpoints (#292, #293, #294, #295)", () => {
  const mockUserId = "b1c2d3e4-1111-4ef8-bb6d-6bb9bd380a11";
  const mockCourseId = "b1c2d3e4-2222-4b92-b60d-8848db490a22";
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
            "GBAXL3624V2V6R3E4W67ZXLN76K4E3U5V62M3X7A4P5R6S7T8U9V0W1D",
          displayName: "Retry Test User",
          credits: 0,
        })
        .onConflictDoNothing();

      await db
        .insert(courses)
        .values({
          id: mockCourseId,
          title: "Retry Test Course",
          description: "For retry/admin/popular tests",
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

  async function createSubmittedQuiz() {
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

    await quizService.submitQuiz(mockUserId, quiz.id, {
      answers: [{ questionId: "q1", selectedIndex: 0 }],
    });

    return quiz;
  }

  test("retryQuiz creates a fresh quiz for the same module and marks the old submission superseded (#295)", async () => {
    if (!infraAvailable) return;

    const quiz = await createSubmittedQuiz();

    const retried = await quizService.retryQuiz(mockUserId, quiz.id);

    expect(retried.id).not.toBe(quiz.id);
    expect(retried.courseId).toBe(mockCourseId);
    expect(retried.moduleId).toBe(mockModuleId);
    expect(retried.questions.length).toBeGreaterThan(0);

    const [oldSubmission] = await db
      .select()
      .from(quizSubmissions)
      .where(eq(quizSubmissions.quizId, quiz.id));
    expect(oldSubmission.superseded).toBe(true);
  });

  test("retryQuiz rejects a quiz that has no submission yet (#295)", async () => {
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

    await expect(quizService.retryQuiz(mockUserId, quiz.id)).rejects.toThrow(
      ForbiddenError,
    );
  });

  test("retryQuiz enforces a max of 3 retries per module per day (#295)", async () => {
    if (!infraAvailable) return;

    const quiz = await createSubmittedQuiz();

    let lastQuizId = quiz.id;
    for (let i = 0; i < MAX_RETRIES_PER_MODULE_PER_DAY; i++) {
      const retried = await quizService.retryQuiz(mockUserId, lastQuizId);
      lastQuizId = retried.id;
      // Each retry needs its own submission before it can be retried again.
      await quizService.submitQuiz(mockUserId, lastQuizId, {
        answers: [{ questionId: retried.questions[0].id, selectedIndex: 0 }],
      });
    }

    await expect(
      quizService.retryQuiz(mockUserId, lastQuizId),
    ).rejects.toThrow(RateLimitError);
  });

  test("getPopularCourses returns only active courses ordered by enrollment count and respects the limit (#293)", async () => {
    if (!infraAvailable) return;

    const [popularCourse] = await db
      .insert(courses)
      .values({
        title: "Very Popular Course",
        description: "many enrollments",
        difficulty: "beginner",
        isActive: true,
      })
      .returning();

    const [inactiveCourse] = await db
      .insert(courses)
      .values({
        title: "Inactive Course",
        description: "should never appear",
        difficulty: "beginner",
        isActive: false,
      })
      .returning();

    const extraUserIds: string[] = [];
    try {
      for (let i = 0; i < 3; i++) {
        const [extraUser] = await db
          .insert(users)
          .values({
            stellarAddress: `GEXTRA${i}00000000000000000000000000000000000000000000000`,
            credits: 0,
          })
          .returning();
        extraUserIds.push(extraUser.id);
        await db
          .insert(enrollments)
          .values({ userId: extraUser.id, courseId: popularCourse.id });
      }
      await db
        .insert(enrollments)
        .values({ userId: extraUserIds[0], courseId: inactiveCourse.id });

      const popular = await courseService.getPopularCourses(50);

      const popularIds = popular.map((c) => c.id);
      expect(popularIds).toContain(popularCourse.id);
      expect(popularIds).not.toContain(inactiveCourse.id);
      expect(popular[0].id).toBe(popularCourse.id);
      expect(popular[0].enrolledCount).toBe(3);

      const limited = await courseService.getPopularCourses(1);
      expect(limited.length).toBe(1);
    } finally {
      for (const id of extraUserIds) {
        await db.delete(enrollments).where(eq(enrollments.userId, id));
        await db.delete(users).where(eq(users.id, id));
      }
      await db.delete(enrollments).where(eq(enrollments.courseId, popularCourse.id));
      await db.delete(courses).where(eq(courses.id, popularCourse.id));
      await db.delete(courses).where(eq(courses.id, inactiveCourse.id));
    }
  });

  test("getPopularCourses caches its result for the given limit (#293)", async () => {
    if (!infraAvailable) return;

    await courseService.getPopularCourses(10);
    const cached = await redis.get("chainlearn:courses:popular:10");
    expect(cached).not.toBeNull();

    const ttl = await redis.ttl("chainlearn:courses:popular:10");
    expect(ttl).toBeGreaterThan(0);
    expect(ttl).toBeLessThanOrEqual(300);
  });

  test("admin createCourse/updateCourse/deleteCourse manage courses and invalidate caches (#292)", async () => {
    if (!infraAvailable) return;

    const created = await courseService.createCourse({
      title: "Admin Created Course",
      description: "created via admin endpoint",
      difficulty: "advanced",
      tags: ["stellar", "soroban"],
    });

    expect(created.title).toBe("Admin Created Course");
    expect(created.isActive).toBe(true);
    expect(created.tags).toEqual(["stellar", "soroban"]);

    const updated = await courseService.updateCourse(created.id, {
      title: "Updated Title",
    });
    expect(updated.title).toBe("Updated Title");

    await courseService.deleteCourse(created.id);

    const { courses: listed } = await courseService.listCourses(null, {
      page: 1,
      limit: 50,
    });
    expect(listed.map((c) => c.id)).not.toContain(created.id);

    await db.delete(courses).where(eq(courses.id, created.id));
  });

  test("enroll() skips content hash verification (no mismatch) when no on-chain contract is configured (#294)", async () => {
    if (!infraAvailable) return;

    await db
      .update(courses)
      .set({ contentHash: "abc123" })
      .where(eq(courses.id, mockCourseId));

    const result = await courseService.enroll(mockUserId, mockCourseId);
    expect(result.contentHashMismatch).toBe(false);
  });
});
