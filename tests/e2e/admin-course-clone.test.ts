import { describe, it, expect, beforeAll, afterAll } from "vitest";
import type { FastifyInstance } from "fastify";
import { eq } from "drizzle-orm";
import { buildApp } from "../../src/server.js";
import { db } from "../../src/config/database.js";
import { users, courses, moduleContent, quizzes } from "../../src/database/schema.js";

describe("Admin Course Clone E2E API (#651)", () => {
  let app: FastifyInstance;

  const adminUserId = "k1c2d3e4-1111-4ef8-bb6d-6bb9bd380c10";
  const adminStellarAddress = "GADMINCLONE00000000000000000000000000000000000000000000".slice(
    0,
    56,
  );
  const nonAdminUserId = "k1c2d3e4-2222-4ef8-bb6d-6bb9bd380c10";
  const nonAdminStellarAddress =
    "GNONADMINCLONE000000000000000000000000000000000000000000".slice(0, 56);

  const createdCourseIds: string[] = [];

  beforeAll(async () => {
    app = await buildApp();
    await app.ready();

    await db
      .insert(users)
      .values({
        id: adminUserId,
        stellarAddress: adminStellarAddress,
        displayName: "Clone Admin",
        isAdmin: true,
      })
      .onConflictDoNothing();

    await db
      .insert(users)
      .values({
        id: nonAdminUserId,
        stellarAddress: nonAdminStellarAddress,
        displayName: "Clone Non-Admin",
        isAdmin: false,
      })
      .onConflictDoNothing();
  });

  afterAll(async () => {
    for (const id of createdCourseIds) {
      await db.delete(quizzes).where(eq(quizzes.courseId, id));
      await db.delete(moduleContent).where(eq(moduleContent.courseId, id));
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
    it("should reject unauthenticated clone requests with 401", async () => {
      const response = await app.inject({
        method: "POST",
        url: "/api/v1/admin/courses/00000000-0000-0000-0000-000000000000/clone",
        payload: { title: "Cloned Course" },
      });

      expect(response.statusCode).toBe(401);
    });

    it("should reject non-admin users with 403", async () => {
      const response = await app.inject({
        method: "POST",
        url: "/api/v1/admin/courses/00000000-0000-0000-0000-000000000000/clone",
        headers: { authorization: `Bearer ${nonAdminToken()}` },
        payload: { title: "Cloned Course" },
      });

      expect(response.statusCode).toBe(403);
    });

    it("should return 404 when attempting to clone a non-existent course", async () => {
      const nonExistentId = "ffffffff-ffff-4fff-bfff-ffffffffffff";
      const response = await app.inject({
        method: "POST",
        url: `/api/v1/admin/courses/${nonExistentId}/clone`,
        headers: { authorization: `Bearer ${adminToken()}` },
        payload: { title: "Cloned Course" },
      });

      expect(response.statusCode).toBe(404);
    });
  });

  describe("Course Cloning, Module and Content Copying (#651 / #378)", () => {
    it("should clone a course with modules, content items, and quizzes into a draft", async () => {
      const sourceModuleId = "src-mod-101";

      // 1. Create source course with modules
      const [sourceCourse] = await db
        .insert(courses)
        .values({
          title: "Original Master Course",
          description: "Full course with modules, lessons, and quiz",
          difficulty: "intermediate",
          tags: ["stellar", "blockchain"],
          modules: [
            {
              id: sourceModuleId,
              title: "Source Module 1",
              description: "Detailed source module description",
              order: 0,
            },
          ],
          courseModules: [
            {
              id: sourceModuleId,
              title: "Source Module 1",
              description: "Detailed source module description",
              estimatedDurationMinutes: 45,
            },
          ],
          isActive: true,
          isDraft: false,
        })
        .returning();
      createdCourseIds.push(sourceCourse!.id);

      // 2. Add module content item
      await db.insert(moduleContent).values({
        courseId: sourceCourse!.id,
        moduleId: sourceModuleId,
        title: "Lesson Text 1",
        type: "text",
        content: { body: "Original source text lesson" },
        orderIndex: 0,
      });

      // 3. Add quiz for the module
      await db.insert(quizzes).values({
        courseId: sourceCourse!.id,
        moduleId: sourceModuleId,
        questions: [
          {
            id: "q1",
            text: "What consensus does Stellar use?",
            options: ["SCP", "PoW", "PoS"],
            correctIndex: 0,
          },
        ],
      });

      // 4. Request course clone with custom title
      const customTitle = "Cloned Stellar Mastery Course";
      const cloneResponse = await app.inject({
        method: "POST",
        url: `/api/v1/admin/courses/${sourceCourse!.id}/clone`,
        headers: { authorization: `Bearer ${adminToken()}` },
        payload: {
          title: customTitle,
        },
      });

      expect(cloneResponse.statusCode).toBe(200);
      const cloneBody = JSON.parse(cloneResponse.payload);
      expect(cloneBody.success).toBe(true);

      const clonedCourse = cloneBody.data;
      expect(clonedCourse.id).toBeDefined();
      expect(clonedCourse.id).not.toBe(sourceCourse!.id);
      expect(clonedCourse.title).toBe(customTitle);
      expect(clonedCourse.isDraft).toBe(true);
      expect(clonedCourse.isActive).toBe(false);

      createdCourseIds.push(clonedCourse.id);

      // 5. Verify module copying and remapped IDs
      expect(clonedCourse.modules).toHaveLength(1);
      const clonedModule = clonedCourse.modules[0];
      expect(clonedModule.id).not.toBe(sourceModuleId);
      expect(clonedModule.title).toBe("Source Module 1");

      // 6. Verify module content copied and remapped to new course and module ID
      const clonedContentRows = await db
        .select()
        .from(moduleContent)
        .where(eq(moduleContent.courseId, clonedCourse.id));

      expect(clonedContentRows).toHaveLength(1);
      expect(clonedContentRows[0]?.courseId).toBe(clonedCourse.id);
      expect(clonedContentRows[0]?.moduleId).toBe(clonedModule.id);
      expect(clonedContentRows[0]?.title).toBe("Lesson Text 1");

      // 7. Verify quiz copied and remapped
      const clonedQuizzes = await db
        .select()
        .from(quizzes)
        .where(eq(quizzes.courseId, clonedCourse.id));

      expect(clonedQuizzes).toHaveLength(1);
      expect(clonedQuizzes[0]?.courseId).toBe(clonedCourse.id);
      expect(clonedQuizzes[0]?.moduleId).toBe(clonedModule.id);
    });

    it("should generate default clone title when title is omitted", async () => {
      const [sourceCourse] = await db
        .insert(courses)
        .values({
          title: "Standalone Course",
          description: "Testing default title suffix",
          difficulty: "beginner",
          modules: [],
          courseModules: [],
          isActive: true,
          isDraft: false,
        })
        .returning();
      createdCourseIds.push(sourceCourse!.id);

      const cloneResponse = await app.inject({
        method: "POST",
        url: `/api/v1/admin/courses/${sourceCourse!.id}/clone`,
        headers: { authorization: `Bearer ${adminToken()}` },
        payload: {},
      });

      expect(cloneResponse.statusCode).toBe(200);
      const cloneBody = JSON.parse(cloneResponse.payload);
      expect(cloneBody.success).toBe(true);
      expect(cloneBody.data.title).toBe("Standalone Course (Clone)");

      createdCourseIds.push(cloneBody.data.id);
    });
  });
});
