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
 * E2E coverage for GET /api/v1/users/me/courses/:courseId/progress
 * (closes #626).
 *
 * Covers the unauthenticated, unknown-course, no-activity, partially
 * complete, module-ordering, quiz-score, average-score, completion-percent,
 * time-spent, and quiz-derived fallback paths.
 */
describe("Course Progress API — GET /api/v1/users/me/courses/:courseId/progress (#626)", () => {
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
        displayName: "Course Progress Test User",
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
        title: "Course Progress Test Course",
        description: "A course used to exercise learner progress.",
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
      url: `/api/v1/users/me/courses/${randomUUID()}/progress`,
    });

    expect(response.statusCode).toBe(401);
    expect(JSON.parse(response.payload).error).toBe("UNAUTHORIZED");
  });

  it("rejects a malformed course id with 400", async () => {
    const user = await seedUser();

    const response = await app.inject({
      method: "GET",
      url: "/api/v1/users/me/courses/not-a-uuid/progress",
      headers: { authorization: `Bearer ${tokenFor(user)}` },
    });

    expect(response.statusCode).toBe(400);
    expect(JSON.parse(response.payload).error).toContain("VALIDATION");
  });

  it("returns 404 for a course that does not exist", async () => {
    const user = await seedUser();

    const response = await app.inject({
      method: "GET",
      url: `/api/v1/users/me/courses/${randomUUID()}/progress`,
      headers: { authorization: `Bearer ${tokenFor(user)}` },
    });

    expect(response.statusCode).toBe(404);
  });

  it("returns 404 for an inactive course", async () => {
    const user = await seedUser();
    const course = await seedCourse({ isActive: false });

    const response = await app.inject({
      method: "GET",
      url: `/api/v1/users/me/courses/${course.id}/progress`,
      headers: { authorization: `Bearer ${tokenFor(user)}` },
    });

    expect(response.statusCode).toBe(404);
  });

  it("returns zeroed progress for a learner with no activity", async () => {
    const user = await seedUser();
    const course = await seedCourse();

    const response = await app.inject({
      method: "GET",
      url: `/api/v1/users/me/courses/${course.id}/progress`,
      headers: { authorization: `Bearer ${tokenFor(user)}` },
    });

    expect(response.statusCode).toBe(200);
    const { data } = JSON.parse(response.payload);

    expect(data).toMatchObject({
      courseId: course.id,
      courseTitle: course.title,
      modulesCompleted: 0,
      quizzesTaken: 0,
      quizScores: [],
      averageScore: null,
      completionPercentage: 0,
      timeSpentMinutes: 0,
    });
    expect(data.modules).toEqual([
      { moduleId: "module-1", title: "Module One", status: "not_started" },
      { moduleId: "module-2", title: "Module Two", status: "not_started" },
    ]);
  });

  it("sorts modules by order and reports partial completion, quiz scores, averages, and time spent", async () => {
    const user = await seedUser();
    const otherUser = await seedUser();

    // Deliberately out of order: the endpoint must sort by `order`.
    const course = await seedCourse({
      modules: [
        { id: "module-3", title: "Module Three", description: "Third", order: 3 },
        { id: "module-1", title: "Module One", description: "First", order: 1 },
        { id: "module-2", title: "Module Two", description: "Second", order: 2 },
      ],
      courseModules: [
        { id: "module-1", title: "Module One", estimatedDurationMinutes: 30 },
        { id: "module-2", title: "Module Two", estimatedDurationMinutes: 45 },
        { id: "module-3", title: "Module Three", estimatedDurationMinutes: 20 },
      ],
    });

    const moduleOneQuiz = await seedQuiz(course.id, "module-1", 4);
    const moduleTwoQuiz = await seedQuiz(course.id, "module-2", 4);
    const supersededQuiz = await seedQuiz(course.id, "module-3", 4);

    await submit(moduleOneQuiz, user.id, {
      score: 2,
      submittedAt: new Date("2026-03-01T09:00:00.000Z"),
    });
    await submit(moduleTwoQuiz, user.id, {
      score: 3,
      submittedAt: new Date("2026-03-02T09:00:00.000Z"),
    });
    // A superseded attempt must not complete module 3 or affect the average.
    await submit(supersededQuiz, user.id, {
      score: 4,
      superseded: true,
      submittedAt: new Date("2026-03-03T09:00:00.000Z"),
    });
    // Another learner's score must not affect this learner's progress.
    await submit(moduleOneQuiz, otherUser.id, {
      score: 4,
      submittedAt: new Date("2026-03-04T09:00:00.000Z"),
    });

    const response = await app.inject({
      method: "GET",
      url: `/api/v1/users/me/courses/${course.id}/progress`,
      headers: { authorization: `Bearer ${tokenFor(user)}` },
    });

    expect(response.statusCode).toBe(200);
    const { data } = JSON.parse(response.payload);

    expect(data.modules).toEqual([
      { moduleId: "module-1", title: "Module One", status: "completed" },
      { moduleId: "module-2", title: "Module Two", status: "completed" },
      { moduleId: "module-3", title: "Module Three", status: "not_started" },
    ]);
    expect(data.modulesCompleted).toBe(2);
    expect(data.quizzesTaken).toBe(2);
    expect(data.completionPercentage).toBe(67);
    // (50% + 75%) / 2
    expect(data.averageScore).toBe(62.5);
    // 30 minutes for module 1 + 45 minutes for module 2.
    expect(data.timeSpentMinutes).toBe(75);

    // Quiz scores are newest-first and carry both raw score and percentage.
    expect(data.quizScores).toHaveLength(2);
    expect(data.quizScores[0]).toMatchObject({
      quizId: moduleTwoQuiz,
      moduleId: "module-2",
      score: 3,
      totalQuestions: 4,
      percentage: 75,
    });
    expect(data.quizScores[1]).toMatchObject({
      quizId: moduleOneQuiz,
      moduleId: "module-1",
      score: 2,
      totalQuestions: 4,
      percentage: 50,
    });
    expect(new Date(data.quizScores[0].submittedAt).toISOString()).toBe(
      "2026-03-02T09:00:00.000Z",
    );
  });

  it("falls back to quiz-derived modules and five minutes per quiz without course metadata", async () => {
    const user = await seedUser();
    const course = await seedCourse({ modules: [], courseModules: null });

    const moduleAQuiz = await seedQuiz(course.id, "module-a", 2);
    const moduleBQuiz = await seedQuiz(course.id, "module-b", 2);
    await submit(moduleBQuiz, user.id, { score: 1 });

    const response = await app.inject({
      method: "GET",
      url: `/api/v1/users/me/courses/${course.id}/progress`,
      headers: { authorization: `Bearer ${tokenFor(user)}` },
    });

    expect(response.statusCode).toBe(200);
    const { data } = JSON.parse(response.payload);

    expect(data.modules).toEqual([
      { moduleId: "module-a", title: null, status: "not_started" },
      { moduleId: "module-b", title: null, status: "completed" },
    ]);
    expect(data.modulesCompleted).toBe(1);
    expect(data.quizzesTaken).toBe(1);
    expect(data.completionPercentage).toBe(50);
    expect(data.averageScore).toBe(50);
    // No duration metadata: five minutes per quiz taken.
    expect(data.timeSpentMinutes).toBe(5);
    expect(data.quizScores).toHaveLength(1);
    expect(data.quizScores[0]).toMatchObject({
      quizId: moduleBQuiz,
      moduleId: "module-b",
      percentage: 50,
    });
    // The unused quiz must not appear as taken.
    expect(data.quizScores.some((q: { quizId: string }) => q.quizId === moduleAQuiz)).toBe(
      false,
    );
  });
});
