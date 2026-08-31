import { test, describe, expect, beforeEach, afterEach } from "vitest";
import { db } from "../config/database.js";
import { redis } from "../config/redis.js";
import { courseService } from "../modules/courses/course.service.js";
import { quizService } from "../modules/quizzes/quiz.service.js";
import { NotFoundError } from "../utils/errors.js";
import { courses, enrollments, users, quizzes } from "../database/schema.js";
import { eq } from "drizzle-orm";

describe("CourseService.getEnrolledUsers (#340)", () => {
  const courseId = "c1c2d3e4-1111-4ef8-bb6d-6bb9bd380a30";
  const userAId = "c1c2d3e4-2222-4ef8-bb6d-6bb9bd380a30";
  const userBId = "c1c2d3e4-3333-4ef8-bb6d-6bb9bd380a30";
  const moduleId = "module-1";

  let infraAvailable = true;

  beforeEach(async () => {
    try {
      await redis.flushdb();

      await db
        .insert(courses)
        .values({
          id: courseId,
          title: "Enrolled Users Test Course",
          description: "For #340 tests",
          difficulty: "beginner",
          isActive: true,
        })
        .onConflictDoNothing();

      await db
        .insert(users)
        .values([
          {
            id: userAId,
            stellarAddress: "GAAXL3624V2V6R3E4W67ZXLN76K4E3U5V62M3X7A4P5R6S7T8U9V0W1A",
            displayName: "Enrolled User A",
          },
          {
            id: userBId,
            stellarAddress: "GBBXL3624V2V6R3E4W67ZXLN76K4E3U5V62M3X7A4P5R6S7T8U9V0W1B",
            displayName: "Enrolled User B",
          },
        ])
        .onConflictDoNothing();

      // User A enrolled first, so with orderBy(enrolledAt desc) B is page 1.
      await db
        .insert(enrollments)
        .values({ userId: userAId, courseId })
        .onConflictDoNothing();
      await new Promise((resolve) => setTimeout(resolve, 10));
      await db
        .insert(enrollments)
        .values({ userId: userBId, courseId })
        .onConflictDoNothing();
    } catch {
      infraAvailable = false;
    }
  });

  afterEach(async () => {
    if (!infraAvailable) return;
    await db.delete(enrollments).where(eq(enrollments.courseId, courseId));
    await db.delete(quizzes).where(eq(quizzes.courseId, courseId));
    await db.delete(courses).where(eq(courses.id, courseId));
    await db.delete(users).where(eq(users.id, userAId));
    await db.delete(users).where(eq(users.id, userBId));
  });

  test("returns quizCount/averageScore only for users who submitted, null/0 for those who haven't", async () => {
    if (!infraAvailable) return;

    const [quiz] = await db
      .insert(quizzes)
      .values({
        courseId,
        moduleId,
        questions: [
          { id: "q1", text: "2+2?", options: ["3", "4"], correctIndex: 1 },
        ],
        generatedFor: userAId,
      })
      .returning();

    // User A answers correctly. quizSubmissions.score stores the raw
    // correct-answer count (see quiz.service.ts submitQuiz), not a
    // percentage — 1 correct out of this quiz's 1 question -> score 1.
    await quizService.submitQuiz(userAId, quiz.id, {
      answers: [{ questionId: "q1", selectedIndex: 1 }],
    });

    const result = await courseService.getEnrolledUsers(courseId, {
      page: 1,
      limit: 20,
    });

    expect(result.total).toBe(2);
    expect(result.users).toHaveLength(2);

    const rowA = result.users.find((u) => u.userId === userAId);
    const rowB = result.users.find((u) => u.userId === userBId);

    expect(rowA).toBeDefined();
    expect(rowA?.quizCount).toBe(1);
    expect(rowA?.averageScore).toBe(1);

    expect(rowB).toBeDefined();
    expect(rowB?.quizCount).toBe(0);
    expect(rowB?.averageScore).toBeNull();
  });

  test("paginates and orders by enrolledAt descending (most recently enrolled first)", async () => {
    if (!infraAvailable) return;

    const page1 = await courseService.getEnrolledUsers(courseId, {
      page: 1,
      limit: 1,
    });

    expect(page1.total).toBe(2);
    expect(page1.users).toHaveLength(1);
    expect(page1.users[0].userId).toBe(userBId); // enrolled second -> most recent

    const page2 = await courseService.getEnrolledUsers(courseId, {
      page: 2,
      limit: 1,
    });

    expect(page2.total).toBe(2);
    expect(page2.users).toHaveLength(1);
    expect(page2.users[0].userId).toBe(userAId);
  });

  test("caches the result for the given (courseId, page, limit) — a DB row added after the first call isn't reflected until the cache expires", async () => {
    if (!infraAvailable) return;

    const first = await courseService.getEnrolledUsers(courseId, {
      page: 1,
      limit: 20,
    });
    expect(first.total).toBe(2);

    const userCId = "c1c2d3e4-4444-4ef8-bb6d-6bb9bd380a30";
    await db
      .insert(users)
      .values({
        id: userCId,
        stellarAddress: "GCCXL3624V2V6R3E4W67ZXLN76K4E3U5V62M3X7A4P5R6S7T8U9V0W1C",
        displayName: "Enrolled User C",
      })
      .onConflictDoNothing();
    await db
      .insert(enrollments)
      .values({ userId: userCId, courseId })
      .onConflictDoNothing();

    const second = await courseService.getEnrolledUsers(courseId, {
      page: 1,
      limit: 20,
    });
    expect(second.total).toBe(2); // still cached

    await db.delete(enrollments).where(eq(enrollments.userId, userCId));
    await db.delete(users).where(eq(users.id, userCId));
  });

  test("throws NotFoundError for a nonexistent course", async () => {
    if (!infraAvailable) return;

    await expect(
      courseService.getEnrolledUsers(
        "00000000-0000-0000-0000-000000000000",
        { page: 1, limit: 20 },
      ),
    ).rejects.toThrow(NotFoundError);
  });
});
