import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { eq } from "drizzle-orm";
import { buildApp } from "../../src/server.js";
import { db } from "../../src/config/database.js";
import { courses, quizzes, users } from "../../src/database/schema.js";

describe("Admin course drafts E2E API (#660)", () => {
  let app: FastifyInstance;

  const adminUserId = "a6600000-0000-4000-8000-000000000001";
  const adminAddress = "GADMINDRAFTS000000000000000000000000000000000000000000".slice(0, 56);
  const learnerUserId = "a6600000-0000-4000-8000-000000000002";
  const learnerAddress = "GUSERDRAFTS00000000000000000000000000000000000000000000".slice(0, 56);
  const moduleId = "draft-module-1";
  const courseIds: string[] = [];

  beforeAll(async () => {
    app = await buildApp();
    await app.ready();
    await db.insert(users).values({ id: adminUserId, stellarAddress: adminAddress, displayName: "Draft Admin", isAdmin: true }).onConflictDoNothing();
    await db.insert(users).values({ id: learnerUserId, stellarAddress: learnerAddress, displayName: "Draft Learner", isAdmin: false }).onConflictDoNothing();
  });

  afterAll(async () => {
    for (const id of courseIds) {
      await db.delete(quizzes).where(eq(quizzes.courseId, id));
      await db.delete(courses).where(eq(courses.id, id));
    }
    await db.delete(users).where(eq(users.id, adminUserId));
    await db.delete(users).where(eq(users.id, learnerUserId));
    await app.close();
  });

  const adminHeaders = () => ({ authorization: `Bearer ${app.jwt.sign({ sub: adminUserId, stellarAddress: adminAddress })}` });
  const learnerHeaders = () => ({ authorization: `Bearer ${app.jwt.sign({ sub: learnerUserId, stellarAddress: learnerAddress })}` });

  it("allows an admin to save a draft while keeping it hidden from learners", async () => {
    const [course] = await db.insert(courses).values({
      title: "Draft before save",
      description: "Initial course description",
      difficulty: "beginner",
      modules: [{ id: moduleId, title: "First Module", description: "Learn the basics", order: 0 }],
      courseModules: [{ id: moduleId, title: "First Module", description: "Learn the basics" }],
      isDraft: true,
      isActive: false,
    }).returning();
    courseIds.push(course!.id);

    await db.insert(quizzes).values({
      courseId: course!.id,
      moduleId,
      questions: [{ id: "q1", text: "What is Stellar?", options: ["A network", "A database"], correctIndex: 0 }],
    });

    const unauthenticated = await app.inject({ method: "POST", url: `/api/v1/admin/courses/${course!.id}/draft`, payload: { title: "Saved Draft" } });
    expect(unauthenticated.statusCode).toBe(401);

    const forbidden = await app.inject({ method: "POST", url: `/api/v1/admin/courses/${course!.id}/draft`, headers: learnerHeaders(), payload: { title: "Saved Draft" } });
    expect(forbidden.statusCode).toBe(403);

    const saved = await app.inject({
      method: "POST",
      url: `/api/v1/admin/courses/${course!.id}/draft`,
      headers: adminHeaders(),
      payload: { title: "Saved Draft", description: "Updated draft content" },
    });
    expect(saved.statusCode).toBe(200);
    expect(saved.json().data).toMatchObject({ title: "Saved Draft", description: "Updated draft content", isDraft: true, isActive: false });

    const publicList = await app.inject({ method: "GET", url: "/api/v1/courses" });
    expect(publicList.statusCode).toBe(200);
    expect(publicList.json().data.courses.some((item: { id: string }) => item.id === course!.id)).toBe(false);
  });

  it("publishes the saved draft and exposes it in the public course list", async () => {
    const [course] = await db.insert(courses).values({
      title: "Publishable Draft",
      description: "A complete course ready to publish",
      difficulty: "beginner",
      modules: [{ id: moduleId, title: "Module One", description: "Course material", order: 0 }],
      courseModules: [{ id: moduleId, title: "Module One", description: "Course material" }],
      isDraft: true,
      isActive: false,
    }).returning();
    courseIds.push(course!.id);
    await db.insert(quizzes).values({
      courseId: course!.id,
      moduleId,
      questions: [{ id: "q1", text: "What is Stellar?", options: ["A network", "A database"], correctIndex: 0 }],
    });

    const saved = await app.inject({
      method: "POST",
      url: `/api/v1/admin/courses/${course!.id}/draft`,
      headers: adminHeaders(),
      payload: { description: "Reviewed and ready to publish" },
    });
    expect(saved.statusCode).toBe(200);
    expect(saved.json().data.isDraft).toBe(true);
    expect(saved.json().data.isActive).toBe(false);

    const published = await app.inject({ method: "POST", url: `/api/v1/admin/courses/${course!.id}/publish`, headers: adminHeaders() });
    expect(published.statusCode).toBe(200);
    expect(published.json().data).toMatchObject({ isDraft: false, isActive: true });

    const publicList = await app.inject({ method: "GET", url: "/api/v1/courses" });
    expect(publicList.statusCode).toBe(200);
    expect(publicList.json().data.courses.some((item: { id: string }) => item.id === course!.id)).toBe(true);
  });
});
