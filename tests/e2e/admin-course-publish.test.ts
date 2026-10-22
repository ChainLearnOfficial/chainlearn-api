import { describe, it, expect, beforeAll, afterAll } from "vitest";
import type { FastifyInstance } from "fastify";
import { eq } from "drizzle-orm";
import { buildApp } from "../../src/server.js";
import { db } from "../../src/config/database.js";
import { users, courses, quizzes } from "../../src/database/schema.js";

describe("Admin Course Publish E2E API (#652)", () => {
  let app: FastifyInstance;

  const adminUserId = "p1c2d3e4-1111-4ef8-bb6d-6bb9bd380c10";
  const adminStellarAddress = "GADMINPUBLISH000000000000000000000000000000000000000000".slice(
    0,
    56,
  );
  const nonAdminUserId = "p1c2d3e4-2222-4ef8-bb6d-6bb9bd380c10";
  const nonAdminStellarAddress =
    "GNONADMINPUBLISH000000000000000000000000000000000000000".slice(0, 56);

  const createdCourseIds: string[] = [];

  beforeAll(async () => {
    app = await buildApp();
    await app.ready();

    await db
      .insert(users)
      .values({
        id: adminUserId,
        stellarAddress: adminStellarAddress,
        displayName: "Publish Admin",
        isAdmin: true,
      })
      .onConflictDoNothing();

    await db
      .insert(users)
      .values({
        id: nonAdminUserId,
        stellarAddress: nonAdminStellarAddress,
        displayName: "Publish Non-Admin",
        isAdmin: false,
      })
      .onConflictDoNothing();
  });

  afterAll(async () => {
    for (const id of createdCourseIds) {
      await db.delete(quizzes).where(eq(quizzes.courseId, id));
      await db.delete(courses).where(eq(courses.id, id));
    }
    await db.delete(users).where(eq(users.id, adminUserId));
    await db.delete(users).where(eq(users.id, nonAdminUserId));
    await app.close();
  });

  const adminToken = () =>
    app.jwt.sign({ sub: adminUserId, stellarAddress: adminStellarAddress });

  const nonAdminToken = () =>
    app.jwt.sign({ sub: nonAdminUserId, stellarAddress: nonAdminStellarAddress });

  describe("Authentication & Authorization", () => {
    it("should reject unauthenticated requests to publish with 401", async () => {
      const response = await app.inject({
        method: "POST",
        url: "/api/v1/admin/courses/00000000-0000-0000-0000-000000000000/publish",
      });

      expect(response.statusCode).toBe(401);
    });

    it("should reject non-admin users with 403", async () => {
      const response = await app.inject({
        method: "POST",
        url: "/api/v1/admin/courses/00000000-0000-0000-0000-000000000000/publish",
        headers: { authorization: `Bearer ${nonAdminToken()}` },
      });

      expect(response.statusCode).toBe(403);
    });

    it("should reject non-admin users from publish-check with 403", async () => {
      const response = await app.inject({
        method: "POST",
        url: "/api/v1/admin/courses/00000000-0000-0000-0000-000000000000/publish-check",
        headers: { authorization: `Bearer ${nonAdminToken()}` },
      });

      expect(response.statusCode).toBe(403);
    });

    it("should return 404 when publishing non-existent course", async () => {
      const nonExistentId = "ffffffff-ffff-4fff-bfff-ffffffffffff";
      const response = await app.inject({
        method: "POST",
        url: `/api/v1/admin/courses/${nonExistentId}/publish`,
        headers: { authorization: `Bearer ${adminToken()}` },
      });

      expect(response.statusCode).toBe(404);
    });
  });

  describe("Publish Checks & Validation (#384 / #652)", () => {
    it("should report blocking issues when course has no modules", async () => {
      const [course] = await db
        .insert(courses)
        .values({
          title: "Course Without Modules",
          description: "Testing readiness check with zero modules",
          difficulty: "beginner",
          modules: [],
          courseModules: [],
          isDraft: true,
          isActive: false,
        })
        .returning();
      createdCourseIds.push(course!.id);

      // Check publish readiness
      const checkResponse = await app.inject({
        method: "POST",
        url: `/api/v1/admin/courses/${course!.id}/publish-check`,
        headers: { authorization: `Bearer ${adminToken()}` },
      });

      expect(checkResponse.statusCode).toBe(200);
      const checkBody = JSON.parse(checkResponse.payload);
      expect(checkBody.data.ready).toBe(false);
      expect(checkBody.data.score).toBeLessThan(100);

      const blockingIssues = checkBody.data.issues.filter(
        (i: { severity: string }) => i.severity === "blocking",
      );
      expect(blockingIssues.length).toBeGreaterThanOrEqual(1);

      // Directly attempting to publish should be rejected with 400 validation error
      const publishResponse = await app.inject({
        method: "POST",
        url: `/api/v1/admin/courses/${course!.id}/publish`,
        headers: { authorization: `Bearer ${adminToken()}` },
      });

      expect(publishResponse.statusCode).toBe(400);
      const publishBody = JSON.parse(publishResponse.payload);
      expect(publishBody.error).toBeDefined();
    });

    it("should report blocking issues when a module is missing a quiz", async () => {
      const moduleId = "m1-no-quiz";
      const [course] = await db
        .insert(courses)
        .values({
          title: "Course Missing Quiz",
          description: "Has module but no corresponding quiz",
          difficulty: "intermediate",
          modules: [
            { id: moduleId, title: "Module Without Quiz", description: "desc", order: 0 },
          ],
          courseModules: [
            { id: moduleId, title: "Module Without Quiz", description: "desc" },
          ],
          isDraft: true,
          isActive: false,
        })
        .returning();
      createdCourseIds.push(course!.id);

      const checkResponse = await app.inject({
        method: "POST",
        url: `/api/v1/admin/courses/${course!.id}/publish-check`,
        headers: { authorization: `Bearer ${adminToken()}` },
      });

      expect(checkResponse.statusCode).toBe(200);
      const checkBody = JSON.parse(checkResponse.payload);
      expect(checkBody.data.ready).toBe(false);
      expect(
        checkBody.data.issues.some((issue: { code: string }) => issue.code === "module_missing_quiz"),
      ).toBe(true);

      const publishResponse = await app.inject({
        method: "POST",
        url: `/api/v1/admin/courses/${course!.id}/publish`,
        headers: { authorization: `Bearer ${adminToken()}` },
      });

      expect(publishResponse.statusCode).toBe(400);
    });
  });

  describe("Draft to Active Publish Workflow", () => {
    it("should successfully publish course when all requirements are satisfied", async () => {
      const moduleId = "mod-ready-1";
      const [course] = await db
        .insert(courses)
        .values({
          title: "Complete Publishable Course",
          description: "Full course with module and quiz",
          difficulty: "beginner",
          modules: [
            {
              id: moduleId,
              title: "Module 1",
              description: "Complete module content",
              order: 0,
            },
          ],
          courseModules: [
            {
              id: moduleId,
              title: "Module 1",
              description: "Complete module content",
            },
          ],
          isDraft: true,
          isActive: false,
          archivedAt: null,
        })
        .returning();
      createdCourseIds.push(course!.id);

      // Insert valid non-empty quiz for the module
      await db.insert(quizzes).values({
        courseId: course!.id,
        moduleId,
        questions: [
          {
            id: "q1",
            text: "What is Stellar?",
            options: ["A decentralized payment network", "A centralized database"],
            correctIndex: 0,
          },
        ],
      });

      // 1. Verify publish-check passes with 100 score
      const checkResponse = await app.inject({
        method: "POST",
        url: `/api/v1/admin/courses/${course!.id}/publish-check`,
        headers: { authorization: `Bearer ${adminToken()}` },
      });

      expect(checkResponse.statusCode).toBe(200);
      const checkBody = JSON.parse(checkResponse.payload);
      expect(checkBody.data.ready).toBe(true);
      expect(checkBody.data.score).toBe(100);
      expect(checkBody.data.issues).toHaveLength(0);

      // 2. Publish the course
      const publishResponse = await app.inject({
        method: "POST",
        url: `/api/v1/admin/courses/${course!.id}/publish`,
        headers: { authorization: `Bearer ${adminToken()}` },
      });

      expect(publishResponse.statusCode).toBe(200);
      const publishBody = JSON.parse(publishResponse.payload);
      expect(publishBody.success).toBe(true);
      expect(publishBody.data.isActive).toBe(true);
      expect(publishBody.data.isDraft).toBe(false);

      // 3. Verify DB record state transition
      const [updatedCourse] = await db
        .select()
        .from(courses)
        .where(eq(courses.id, course!.id));

      expect(updatedCourse?.isActive).toBe(true);
      expect(updatedCourse?.isDraft).toBe(false);
      expect(updatedCourse?.archivedAt).toBeNull();

      // 4. Verify course appears in public listing
      const publicResponse = await app.inject({
        method: "GET",
        url: "/api/v1/courses",
      });

      expect(publicResponse.statusCode).toBe(200);
      const publicBody = JSON.parse(publicResponse.payload);
      expect(
        publicBody.data?.courses?.some((c: { id: string }) => c.id === course!.id),
      ).toBe(true);
    });
  });
});
