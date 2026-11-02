import { randomUUID } from "node:crypto";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { inArray } from "drizzle-orm";
import { buildApp } from "../../src/server.js";
import { db } from "../../src/config/database.js";
import { redis } from "../../src/config/redis.js";
import {
  courses,
  enrollments,
  quizzes,
  quizSubmissions,
  users,
} from "../../src/database/schema.js";

/**
 * E2E coverage for GET /api/v1/courses/:id/enrollment-status (closes #628).
 *
 * Covers the unauthenticated, unknown-course, not-enrolled, enrolled,
 * completed, module-completion, and quiz-aggregate paths against a real
 * Fastify app and the test database.
 */
describe("Course Enrollment Status API — GET /api/v1/courses/:id/enrollment-status (#628)", () => {
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
        displayName: "Enrollment Status Test User",
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
        title: "Enrollment Status Test Course",
        description: "A course used to exercise enrollment status.",
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

  async function enroll(
    userId: string,
    courseId: string,
    overrides: Partial<typeof enrollments.$inferInsert> = {},
  ): Promise<void> {
    await db.insert(enrollments).values({ userId, courseId, ...overrides });
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
  ): Promise<void> {
    await db.insert(quizSubmissions).values({
      quizId,
      userId,
      answers: [],
      score: 1,
      ...overrides,
    });
  }

  function tokenFor(user: typeof users.$inferSelect): string {
    return app.jwt.sign({ sub: user.id, stellarAddress: user.stellarAddress });
  }

  it("rejects unauthenticated requests with 401", async () => {
    const response = await app.inject({
      method: "GET",
      url: `/api/v1/courses/${randomUUID()}/enrollment-status`,
    });

    expect(response.statusCode).toBe(401);
    expect(JSON.parse(response.payload).error).toBe("UNAUTHORIZED");
  });

  it("rejects a malformed course id with 400", async () => {
    const user = await seedUser();

    const response = await app.inject({
      method: "GET",
      url: "/api/v1/courses/not-a-uuid/enrollment-status",
      headers: { authorization: `Bearer ${tokenFor(user)}` },
    });

    expect(response.statusCode).toBe(400);
    expect(JSON.parse(response.payload).error).toContain("VALIDATION");
  });

  it("returns 404 for a course that does not exist", async () => {
    const user = await seedUser();

    const response = await app.inject({
      method: "GET",
      url: `/api/v1/courses/${randomUUID()}/enrollment-status`,
      headers: { authorization: `Bearer ${tokenFor(user)}` },
    });

    expect(response.statusCode).toBe(404);
  });

  it("returns 404 for an inactive course", async () => {
    const user = await seedUser();
    const course = await seedCourse({ isActive: false });

    const response = await app.inject({
      method: "GET",
      url: `/api/v1/courses/${course.id}/enrollment-status`,
      headers: { authorization: `Bearer ${tokenFor(user)}` },
    });

    expect(response.statusCode).toBe(404);
  });

  it("reports the not-enrolled state without inventing progress", async () => {
    const user = await seedUser();
    const course = await seedCourse();

    const response = await app.inject({
      method: "GET",
      url: `/api/v1/courses/${course.id}/enrollment-status`,
      headers: { authorization: `Bearer ${tokenFor(user)}` },
    });

    expect(response.statusCode).toBe(200);
    const { data } = JSON.parse(response.payload);

    expect(data).toMatchObject({
      courseId: course.id,
      isEnrolled: false,
      enrolledAt: null,
      completedAt: null,
      quizCount: 0,
      averageScore: null,
    });
    expect(data.moduleProgress).toEqual([
      { moduleId: "module-1", title: "Module One", completed: false },
      { moduleId: "module-2", title: "Module Two", completed: false },
    ]);
  });

  it("reports an enrolled but incomplete course with the enrollment timestamp", async () => {
    const user = await seedUser();
    const course = await seedCourse();
    const enrolledAt = new Date("2026-01-02T10:00:00.000Z");
    await enroll(user.id, course.id, { enrolledAt });

    const response = await app.inject({
      method: "GET",
      url: `/api/v1/courses/${course.id}/enrollment-status`,
      headers: { authorization: `Bearer ${tokenFor(user)}` },
    });

    expect(response.statusCode).toBe(200);
    const { data } = JSON.parse(response.payload);
    expect(data.isEnrolled).toBe(true);
    expect(data.enrolledAt).toBe(enrolledAt.toISOString());
    expect(data.completedAt).toBeNull();
  });

  it("reports completedAt once the enrollment has been completed", async () => {
    const user = await seedUser();
    const course = await seedCourse();
    const enrolledAt = new Date("2026-01-02T10:00:00.000Z");
    const completedAt = new Date("2026-01-05T18:30:00.000Z");
    await enroll(user.id, course.id, { enrolledAt, completedAt });

    const response = await app.inject({
      method: "GET",
      url: `/api/v1/courses/${course.id}/enrollment-status`,
      headers: { authorization: `Bearer ${tokenFor(user)}` },
    });

    expect(response.statusCode).toBe(200);
    const { data } = JSON.parse(response.payload);
    expect(data.isEnrolled).toBe(true);
    expect(data.completedAt).toBe(completedAt.toISOString());
  });

  it("tracks module completion and quiz aggregates from the caller's non-superseded submissions only", async () => {
    const user = await seedUser();
    const otherUser = await seedUser();
    const course = await seedCourse();
    await enroll(user.id, course.id);

    const moduleOneQuiz = await seedQuiz(course.id, "module-1", 4);
    const moduleTwoQuiz = await seedQuiz(course.id, "module-2", 4);

    // The caller completed module 1 with a score of 3.
    await submit(moduleOneQuiz, user.id, { score: 3 });
    // A later, superseded module 2 attempt must not mark module 2 complete.
    await submit(moduleTwoQuiz, user.id, { score: 1, superseded: true });
    // Another learner's submission must not contribute to this user's stats.
    await submit(moduleOneQuiz, otherUser.id, { score: 4 });

    const response = await app.inject({
      method: "GET",
      url: `/api/v1/courses/${course.id}/enrollment-status`,
      headers: { authorization: `Bearer ${tokenFor(user)}` },
    });

    expect(response.statusCode).toBe(200);
    const { data } = JSON.parse(response.payload);

    expect(data.moduleProgress).toEqual([
      { moduleId: "module-1", title: "Module One", completed: true },
      { moduleId: "module-2", title: "Module Two", completed: false },
    ]);
    expect(data.quizCount).toBe(1);
    expect(data.averageScore).toBe(3);
  });

  it("aggregates every non-superseded submission into quizCount and averageScore", async () => {
    const user = await seedUser();
    const course = await seedCourse();
    await enroll(user.id, course.id);

    const firstQuiz = await seedQuiz(course.id, "module-1", 4);
    const secondQuiz = await seedQuiz(course.id, "module-1", 4);
    const supersededQuiz = await seedQuiz(course.id, "module-2", 4);

    await submit(firstQuiz, user.id, { score: 1 });
    await submit(secondQuiz, user.id, { score: 3 });
    await submit(supersededQuiz, user.id, { score: 4, superseded: true });

    const response = await app.inject({
      method: "GET",
      url: `/api/v1/courses/${course.id}/enrollment-status`,
      headers: { authorization: `Bearer ${tokenFor(user)}` },
    });

    expect(response.statusCode).toBe(200);
    const { data } = JSON.parse(response.payload);
    expect(data.quizCount).toBe(2);
    // Raw score average: (1 + 3) / 2, not a percentage.
    expect(data.averageScore).toBe(2);
  });

  it("falls back to quiz-derived module ids when the course has no authored modules", async () => {
    const user = await seedUser();
    const course = await seedCourse({ modules: [], courseModules: null });
    await enroll(user.id, course.id);

    await seedQuiz(course.id, "module-b", 2);
    const moduleAQuiz = await seedQuiz(course.id, "module-a", 2);
    await submit(moduleAQuiz, user.id, { score: 2 });

    const response = await app.inject({
      method: "GET",
      url: `/api/v1/courses/${course.id}/enrollment-status`,
      headers: { authorization: `Bearer ${tokenFor(user)}` },
    });

    expect(response.statusCode).toBe(200);
    const { data } = JSON.parse(response.payload);
    expect(data.moduleProgress).toEqual([
      { moduleId: "module-a", title: null, completed: true },
      { moduleId: "module-b", title: null, completed: false },
    ]);
  });
});
