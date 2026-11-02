import { randomUUID } from "node:crypto";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { inArray } from "drizzle-orm";
import { buildApp } from "../../src/server.js";
import { db } from "../../src/config/database.js";
import { redis } from "../../src/config/redis.js";
import { courses, quizzes } from "../../src/database/schema.js";

/**
 * E2E coverage for GET /api/v1/courses/:id/syllabus (closes #627).
 *
 * The syllabus endpoint is public, so these tests only need a persisted
 * course. They cover the authored `courseModules` path, the quiz-derived
 * fallback, module ordering, learning-objective derivation, and the empty
 * course case.
 */
describe("Course Syllabus API — GET /api/v1/courses/:id/syllabus (#627)", () => {
  let app: Awaited<ReturnType<typeof buildApp>>;

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
    await redis.flushdb();
  });

  afterAll(async () => {
    await app.close();
  });

  function trackCourse(id: string): string {
    createdCourseIds.push(id);
    return id;
  }

  async function seedCourse(
    overrides: Partial<typeof courses.$inferInsert> = {},
  ): Promise<typeof courses.$inferSelect> {
    const id = overrides.id ?? randomUUID();
    trackCourse(id);

    const [course] = await db
      .insert(courses)
      .values({
        id,
        title: "Syllabus Test Course",
        description: "A course used to exercise the syllabus endpoint.",
        difficulty: "intermediate",
        isActive: true,
        ...overrides,
      })
      .returning();

    return course;
  }

  async function seedQuiz(
    courseId: string,
    moduleId: string,
    questions: Array<{ prompt: string; options: string[]; correctIndex: number }>,
  ): Promise<void> {
    await db.insert(quizzes).values({
      courseId,
      moduleId,
      questions,
      generatedFor: null,
    });
  }

  it("rejects a malformed course id with 400", async () => {
    const response = await app.inject({
      method: "GET",
      url: "/api/v1/courses/not-a-uuid/syllabus",
    });

    expect(response.statusCode).toBe(400);
    expect(JSON.parse(response.payload).error).toContain("VALIDATION");
  });

  it("returns 404 for a course that does not exist", async () => {
    const response = await app.inject({
      method: "GET",
      url: `/api/v1/courses/${randomUUID()}/syllabus`,
    });

    expect(response.statusCode).toBe(404);
    const body = JSON.parse(response.payload);
    expect(body.error).toBe("NOT_FOUND");
  });

  it("returns 404 for an inactive course", async () => {
    const course = await seedCourse({ isActive: false });

    const response = await app.inject({
      method: "GET",
      url: `/api/v1/courses/${course.id}/syllabus`,
    });

    expect(response.statusCode).toBe(404);
  });

  it("returns authored modules in array order with metadata and learning objectives", async () => {
    const course = await seedCourse({
      courseModules: [
        {
          id: "module-zeta",
          title: "Zeta",
          description: "The final module.",
          estimatedDurationMinutes: 45,
        },
        {
          id: "module-alpha",
          title: "Alpha",
          description: "The first module.",
          estimatedDurationMinutes: 30,
        },
        {
          id: "module-mu",
          title: "Mu",
          estimatedDurationMinutes: 15,
        },
      ],
    });

    await seedQuiz(course.id, "module-alpha", [
      { prompt: "Explain the alpha concept", options: ["A", "B"], correctIndex: 0 },
      { prompt: "Apply the alpha concept", options: ["A", "B"], correctIndex: 1 },
    ]);
    await seedQuiz(course.id, "module-mu", [
      { prompt: "Describe mu", options: ["A", "B"], correctIndex: 0 },
    ]);

    const response = await app.inject({
      method: "GET",
      url: `/api/v1/courses/${course.id}/syllabus`,
    });

    expect(response.statusCode).toBe(200);
    const body = JSON.parse(response.payload);
    expect(body.success).toBe(true);

    const { data } = body;
    expect(data.courseId).toBe(course.id);
    expect(data.title).toBe(course.title);
    expect(data.difficulty).toBe("intermediate");
    expect(data.totalEstimatedDurationMinutes).toBe(90);
    expect(data.generatedAt).toBeDefined();

    // The array order is the authored order; `order` is 1-based.
    expect(data.modules.map((m: { id: string }) => m.id)).toEqual([
      "module-zeta",
      "module-alpha",
      "module-mu",
    ]);
    expect(data.modules.map((m: { order: number }) => m.order)).toEqual([1, 2, 3]);

    const alpha = data.modules[1];
    expect(alpha).toMatchObject({
      id: "module-alpha",
      title: "Alpha",
      description: "The first module.",
      estimatedDurationMinutes: 30,
      learningObjectives: [
        "Explain the alpha concept",
        "Apply the alpha concept",
      ],
    });

    const mu = data.modules[2];
    expect(mu.description).toBeNull();
    expect(mu.learningObjectives).toEqual(["Describe mu"]);

    // A module with no quizzes still appears, with an empty objective list.
    const zeta = data.modules[0];
    expect(zeta.estimatedDurationMinutes).toBe(45);
    expect(zeta.learningObjectives).toEqual([]);
  });

  it("derives modules from quizzes when no courseModules metadata exists", async () => {
    const course = await seedCourse({ courseModules: null });

    // Inserted out of alphabetical order on purpose: the fallback groups and
    // orders by module id, so the response must still be sorted.
    await seedQuiz(course.id, "module-zulu", [
      { prompt: "Zulu objective", options: ["A", "B"], correctIndex: 0 },
    ]);
    await seedQuiz(course.id, "module-alpha", [
      { prompt: "Alpha objective", options: ["A", "B"], correctIndex: 0 },
    ]);

    const response = await app.inject({
      method: "GET",
      url: `/api/v1/courses/${course.id}/syllabus`,
    });

    expect(response.statusCode).toBe(200);
    const { data } = JSON.parse(response.payload);

    expect(data.modules.map((m: { id: string }) => m.id)).toEqual([
      "module-alpha",
      "module-zulu",
    ]);
    expect(data.modules.map((m: { title: string }) => m.title)).toEqual([
      "module-alpha",
      "module-zulu",
    ]);
    expect(data.modules.map((m: { order: number }) => m.order)).toEqual([1, 2]);
    expect(data.modules[0]).toMatchObject({
      description: null,
      estimatedDurationMinutes: null,
      learningObjectives: ["Alpha objective"],
    });
    expect(data.totalEstimatedDurationMinutes).toBeNull();
  });

  it("returns an empty syllabus for a course with no authored modules or quizzes", async () => {
    const course = await seedCourse({ courseModules: null });

    const response = await app.inject({
      method: "GET",
      url: `/api/v1/courses/${course.id}/syllabus`,
    });

    expect(response.statusCode).toBe(200);
    const { data } = JSON.parse(response.payload);

    expect(data.courseId).toBe(course.id);
    expect(data.modules).toEqual([]);
    expect(data.totalEstimatedDurationMinutes).toBeNull();
  });

  it("never includes modules belonging to another course", async () => {
    const target = await seedCourse({
      courseModules: [
        { id: "target-module", title: "Target module", estimatedDurationMinutes: 10 },
      ],
    });
    const other = await seedCourse({
      courseModules: [
        { id: "other-module", title: "Other module", estimatedDurationMinutes: 99 },
      ],
    });

    await seedQuiz(other.id, "other-module", [
      { prompt: "Should not leak", options: ["A", "B"], correctIndex: 0 },
    ]);

    const response = await app.inject({
      method: "GET",
      url: `/api/v1/courses/${target.id}/syllabus`,
    });

    expect(response.statusCode).toBe(200);
    const { data } = JSON.parse(response.payload);
    expect(data.modules.map((m: { id: string }) => m.id)).toEqual(["target-module"]);
    expect(data.totalEstimatedDurationMinutes).toBe(10);
  });
});
