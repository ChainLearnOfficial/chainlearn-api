import { randomUUID } from "node:crypto";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { inArray } from "drizzle-orm";
import { buildApp } from "../../src/server.js";
import { db } from "../../src/config/database.js";
import { redis } from "../../src/config/redis.js";
import {
  courses,
  quizzes,
  quizSubmissions,
  users,
} from "../../src/database/schema.js";

/**
 * E2E coverage for GET /api/v1/courses/:id/modules/:moduleId/quiz-attempts
 * (closes #629). The endpoint returns the authenticated learner's attempts
 * for one module, oldest-first, with attempt numbers, pass/fail state, and
 * the superseded flag left intact for history.
 */
describe("Quiz Attempts API — GET /api/v1/courses/:id/modules/:moduleId/quiz-attempts (#629)", () => {
  let app: Awaited<ReturnType<typeof buildApp>>;

  const createdUserIds: string[] = [];
  const createdCourseIds: string[] = [];

  beforeAll(async () => {
    app = await buildApp();
    await app.ready();
  });

  afterEach(async () => {
    if (createdCourseIds.length > 0) {
      await db.delete(courses).where(inArray(courses.id, createdCourseIds));
      createdCourseIds.length = 0;
    }
    if (createdUserIds.length > 0) {
      await db.delete(users).where(inArray(users.id, createdUserIds));
      createdUserIds.length = 0;
    }
    await redis.flushdb();
  });

  afterAll(async () => {
    await app.close();
  });

  function stellarAddress(): string {
    return `G${randomUUID().replace(/-/g, "").toUpperCase().padEnd(55, "A").slice(0, 55)}`;
  }

  async function seedUser(): Promise<typeof users.$inferSelect> {
    const id = randomUUID();
    createdUserIds.push(id);

    const [user] = await db
      .insert(users)
      .values({
        id,
        stellarAddress: stellarAddress(),
        displayName: "Quiz Attempts Test User",
      })
      .returning();
    return user;
  }

  async function seedCourse(
    overrides: Partial<typeof courses.$inferInsert> = {},
  ): Promise<typeof courses.$inferSelect> {
    const id = overrides.id ?? randomUUID();
    createdCourseIds.push(id);

    const [course] = await db
      .insert(courses)
      .values({
        id,
        title: "Quiz Attempts Test Course",
        description: "A course used to exercise quiz attempt history.",
        difficulty: "beginner",
        isActive: true,
        modules: [
          { id: "module-1", title: "Module One", description: "First", order: 1 },
          { id: "module-2", title: "Module Two", description: "Second", order: 2 },
        ],
        ...overrides,
      })
      .returning();
    return course;
  }

  async function seedQuiz(
    courseId: string,
    moduleId: string,
    questionCount = 2,
  ): Promise<string> {
    const [quiz] = await db
      .insert(quizzes)
      .values({
        courseId,
        moduleId,
        questions: Array.from({ length: questionCount }, (_, i) => ({
          prompt: `Question ${i + 1}`,
          options: ["A", "B"],
          correctIndex: 0,
        })),
      })
      .returning({ id: quizzes.id });
    return quiz.id;
  }

  async function submit(
    quizId: string,
    userId: string,
    overrides: Partial<typeof quizSubmissions.$inferInsert> = {},
  ): Promise<typeof quizSubmissions.$inferSelect> {
    const [submission] = await db
      .insert(quizSubmissions)
      .values({
        quizId,
        userId,
        answers: [],
        score: 1,
        ...overrides,
      })
      .returning();
    return submission;
  }

  function tokenFor(user: typeof users.$inferSelect): string {
    return app.jwt.sign({ sub: user.id, stellarAddress: user.stellarAddress });
  }

  it("rejects unauthenticated requests with 401", async () => {
    const response = await app.inject({
      method: "GET",
      url: `/api/v1/courses/${randomUUID()}/modules/module-1/quiz-attempts`,
    });

    expect(response.statusCode).toBe(401);
    expect(JSON.parse(response.payload).error).toBe("UNAUTHORIZED");
  });

  it("rejects a malformed course id with 400", async () => {
    const user = await seedUser();

    const response = await app.inject({
      method: "GET",
      url: "/api/v1/courses/not-a-uuid/modules/module-1/quiz-attempts",
      headers: { authorization: `Bearer ${tokenFor(user)}` },
    });

    expect(response.statusCode).toBe(400);
    expect(JSON.parse(response.payload).error).toContain("VALIDATION");
  });

  it("returns 404 for a course that does not exist", async () => {
    const user = await seedUser();

    const response = await app.inject({
      method: "GET",
      url: `/api/v1/courses/${randomUUID()}/modules/module-1/quiz-attempts`,
      headers: { authorization: `Bearer ${tokenFor(user)}` },
    });

    expect(response.statusCode).toBe(404);
  });

  it("returns 404 for an inactive course", async () => {
    const user = await seedUser();
    const course = await seedCourse({ isActive: false });

    const response = await app.inject({
      method: "GET",
      url: `/api/v1/courses/${course.id}/modules/module-1/quiz-attempts`,
      headers: { authorization: `Bearer ${tokenFor(user)}` },
    });

    expect(response.statusCode).toBe(404);
  });

  it("returns an empty attempt history for a learner with no submissions", async () => {
    const user = await seedUser();
    const course = await seedCourse();
    await seedQuiz(course.id, "module-1");

    const response = await app.inject({
      method: "GET",
      url: `/api/v1/courses/${course.id}/modules/module-1/quiz-attempts`,
      headers: { authorization: `Bearer ${tokenFor(user)}` },
    });

    expect(response.statusCode).toBe(200);
    const body = JSON.parse(response.payload);
    expect(body.success).toBe(true);
    expect(body.data).toMatchObject({
      courseId: course.id,
      moduleId: "module-1",
      attempts: [],
      totalAttempts: 0,
    });
  });

  it("returns only the caller's attempts for the requested module, oldest-first", async () => {
    const user = await seedUser();
    const otherUser = await seedUser();
    const course = await seedCourse();

    const firstQuiz = await seedQuiz(course.id, "module-1");
    const secondQuiz = await seedQuiz(course.id, "module-1");
    const otherModuleQuiz = await seedQuiz(course.id, "module-2");

    const first = await submit(firstQuiz, user.id, {
      score: 1,
      submittedAt: new Date("2026-01-01T09:00:00.000Z"),
    });
    const second = await submit(secondQuiz, user.id, {
      score: 2,
      submittedAt: new Date("2026-01-02T09:00:00.000Z"),
    });
    // Same quiz can be taken by another learner, and must not leak in.
    await submit(firstQuiz, otherUser.id, {
      score: 2,
      submittedAt: new Date("2026-01-03T09:00:00.000Z"),
    });
    // Attempts in other modules must not leak in either.
    await submit(otherModuleQuiz, user.id, {
      score: 2,
      submittedAt: new Date("2026-01-04T09:00:00.000Z"),
    });

    const response = await app.inject({
      method: "GET",
      url: `/api/v1/courses/${course.id}/modules/module-1/quiz-attempts`,
      headers: { authorization: `Bearer ${tokenFor(user)}` },
    });

    expect(response.statusCode).toBe(200);
    const { data } = JSON.parse(response.payload);

    expect(data.totalAttempts).toBe(2);
    expect(data.attempts.map((a: { submissionId: string }) => a.submissionId)).toEqual([
      first.id,
      second.id,
    ]);
    expect(data.attempts.map((a: { attemptNumber: number }) => a.attemptNumber)).toEqual([
      1, 2,
    ]);
    expect(data.attempts.map((a: { date: string }) => new Date(a.date).toISOString())).toEqual([
      "2026-01-01T09:00:00.000Z",
      "2026-01-02T09:00:00.000Z",
    ]);
  });

  it("exposes passed, failed, superseded, and unscored attempt states", async () => {
    const user = await seedUser();
    const course = await seedCourse();

    const passedQuiz = await seedQuiz(course.id, "module-1", 2);
    const failedQuiz = await seedQuiz(course.id, "module-1", 3);
    const supersededQuiz = await seedQuiz(course.id, "module-1", 2);
    const unscoredQuiz = await seedQuiz(course.id, "module-1", 2);

    await submit(passedQuiz, user.id, {
      score: 2,
      submittedAt: new Date("2026-02-01T09:00:00.000Z"),
    });
    await submit(failedQuiz, user.id, {
      score: 1,
      submittedAt: new Date("2026-02-02T09:00:00.000Z"),
    });
    await submit(supersededQuiz, user.id, {
      score: 2,
      superseded: true,
      submittedAt: new Date("2026-02-03T09:00:00.000Z"),
    });
    await submit(unscoredQuiz, user.id, {
      score: null,
      submittedAt: new Date("2026-02-04T09:00:00.000Z"),
    });

    const response = await app.inject({
      method: "GET",
      url: `/api/v1/courses/${course.id}/modules/module-1/quiz-attempts`,
      headers: { authorization: `Bearer ${tokenFor(user)}` },
    });

    expect(response.statusCode).toBe(200);
    const { data } = JSON.parse(response.payload);
    expect(data.totalAttempts).toBe(4);

    const [passed, failed, superseded, unscored] = data.attempts;
    expect(passed).toMatchObject({
      attemptNumber: 1,
      score: 2,
      percentage: 100,
      passed: true,
      superseded: false,
    });

    // 1 correct out of 3 = 33%, below the 70% pass threshold.
    expect(failed).toMatchObject({
      attemptNumber: 2,
      score: 1,
      percentage: 33,
      passed: false,
      superseded: false,
    });

    // Superseded attempts remain in history and keep their original result.
    expect(superseded).toMatchObject({
      attemptNumber: 3,
      score: 2,
      percentage: 100,
      passed: true,
      superseded: true,
    });

    // An attempt with no score cannot be marked as passed.
    expect(unscored).toMatchObject({
      attemptNumber: 4,
      score: null,
      percentage: null,
      passed: false,
      superseded: false,
    });
  });
});
