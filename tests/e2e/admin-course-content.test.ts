import { describe, it, expect, beforeAll, afterAll } from "vitest";
import type { FastifyInstance } from "fastify";
import { eq } from "drizzle-orm";
import { buildApp } from "../../src/server.js";
import { db } from "../../src/config/database.js";
import { users, courses } from "../../src/database/schema.js";

describe("Admin Course Content Management API (#655)", () => {
  let app: FastifyInstance;

  const adminUserId = "f1c2d3e4-1111-4ef8-bb6d-6bb9bd380f55";
  const adminStellarAddress =
    "GADMINCONTENT00000000000000000000000000000000000000000000".slice(0, 56);
  const nonAdminUserId = "f1c2d3e4-2222-4ef8-bb6d-6bb9bd380f55";
  const nonAdminStellarAddress =
    "GNONADMINCONTENT0000000000000000000000000000000000000000".slice(0, 56);

  const createdCourseIds: string[] = [];

  beforeAll(async () => {
    app = await buildApp();
    await app.ready();

    await db
      .insert(users)
      .values({
        id: adminUserId,
        stellarAddress: adminStellarAddress,
        displayName: "Content Admin",
        isAdmin: true,
      })
      .onConflictDoNothing();

    await db
      .insert(users)
      .values({
        id: nonAdminUserId,
        stellarAddress: nonAdminStellarAddress,
        displayName: "Content Non-Admin",
        isAdmin: false,
      })
      .onConflictDoNothing();
  });

  afterAll(async () => {
    for (const id of createdCourseIds) {
      await db.delete(courses).where(eq(courses.id, id));
    }
    await db.delete(users).where(eq(users.id, adminUserId));
    await db.delete(users).where(eq(users.id, nonAdminUserId));
    await app.close();
  });

  const adminToken = () =>
    app.jwt.sign({ sub: adminUserId, stellarAddress: adminStellarAddress });

  const nonAdminToken = () =>
    app.jwt.sign({
      sub: nonAdminUserId,
      stellarAddress: nonAdminStellarAddress,
    });

  /** Helper: creates a course and a single module, returns { courseId, moduleId } */
  const setupCourseAndModule = async (titleSuffix: string) => {
    const [course] = await db
      .insert(courses)
      .values({
        title: `Content Test Course ${titleSuffix}`,
        description: "For content management tests",
      })
      .returning();
    createdCourseIds.push(course!.id);

    const moduleResponse = await app.inject({
      method: "POST",
      url: `/api/v1/admin/courses/${course!.id}/modules`,
      headers: { authorization: `Bearer ${adminToken()}` },
      payload: { title: `Module for ${titleSuffix}`, description: "desc" },
    });
    const moduleId = JSON.parse(moduleResponse.payload).data.id;

    return { courseId: course!.id, moduleId };
  };

  describe("auth", () => {
    it("should reject unauthenticated content creation with 401", async () => {
      const { courseId, moduleId } = await setupCourseAndModule("AuthCheck");

      const response = await app.inject({
        method: "POST",
        url: `/api/v1/admin/courses/${courseId}/modules/${moduleId}/content`,
        payload: {
          title: "Unauthorized",
          type: "text",
          content: { body: "x" },
        },
      });

      expect(response.statusCode).toBe(401);
    });

    it("should reject non-admin content creation with 403", async () => {
      const { courseId, moduleId } =
        await setupCourseAndModule("NonAdminCheck");

      const response = await app.inject({
        method: "POST",
        url: `/api/v1/admin/courses/${courseId}/modules/${moduleId}/content`,
        headers: { authorization: `Bearer ${nonAdminToken()}` },
        payload: { title: "Forbidden", type: "text", content: { body: "x" } },
      });

      expect(response.statusCode).toBe(403);
    });
  });

  describe("content CRUD", () => {
    it("should create a text content item", async () => {
      const { courseId, moduleId } = await setupCourseAndModule("CreateText");

      const response = await app.inject({
        method: "POST",
        url: `/api/v1/admin/courses/${courseId}/modules/${moduleId}/content`,
        headers: { authorization: `Bearer ${adminToken()}` },
        payload: {
          title: "Text Lesson",
          type: "text",
          content: { body: "This is the lesson body." },
        },
      });

      expect(response.statusCode).toBe(201);
      const body = JSON.parse(response.payload);
      expect(body.success).toBe(true);
      expect(body.data.title).toBe("Text Lesson");
      expect(body.data.type).toBe("text");
    });

    it("should create a video content item", async () => {
      const { courseId, moduleId } = await setupCourseAndModule("CreateVideo");

      const response = await app.inject({
        method: "POST",
        url: `/api/v1/admin/courses/${courseId}/modules/${moduleId}/content`,
        headers: { authorization: `Bearer ${adminToken()}` },
        payload: {
          title: "Video Lesson",
          type: "video",
          content: { url: "https://example.com/video.mp4" },
        },
      });

      expect(response.statusCode).toBe(201);
      const body = JSON.parse(response.payload);
      expect(body.data.type).toBe("video");
    });

    it("should create a quiz content item", async () => {
      const { courseId, moduleId } = await setupCourseAndModule("CreateQuiz");

      const response = await app.inject({
        method: "POST",
        url: `/api/v1/admin/courses/${courseId}/modules/${moduleId}/content`,
        headers: { authorization: `Bearer ${adminToken()}` },
        payload: {
          title: "Quiz Content",
          type: "quiz",
          content: { quizId: "some-quiz-ref" },
        },
      });

      expect(response.statusCode).toBe(201);
      const body = JSON.parse(response.payload);
      expect(body.data.type).toBe("quiz");
    });

    it("should create an exercise content item", async () => {
      const { courseId, moduleId } =
        await setupCourseAndModule("CreateExercise");

      const response = await app.inject({
        method: "POST",
        url: `/api/v1/admin/courses/${courseId}/modules/${moduleId}/content`,
        headers: { authorization: `Bearer ${adminToken()}` },
        payload: {
          title: "Exercise Content",
          type: "exercise",
          content: { instructions: "Do this exercise." },
        },
      });

      expect(response.statusCode).toBe(201);
      const body = JSON.parse(response.payload);
      expect(body.data.type).toBe("exercise");
    });

    it("should reject creation with an invalid content type", async () => {
      const { courseId, moduleId } = await setupCourseAndModule("InvalidType");

      const response = await app.inject({
        method: "POST",
        url: `/api/v1/admin/courses/${courseId}/modules/${moduleId}/content`,
        headers: { authorization: `Bearer ${adminToken()}` },
        payload: {
          title: "Invalid Type",
          type: "markdown",
          content: { body: "x" },
        },
      });

      expect(response.statusCode).toBe(400);
    });

    it("should reject creation with missing required fields", async () => {
      const { courseId, moduleId } =
        await setupCourseAndModule("MissingFields");

      const response = await app.inject({
        method: "POST",
        url: `/api/v1/admin/courses/${courseId}/modules/${moduleId}/content`,
        headers: { authorization: `Bearer ${adminToken()}` },
        payload: { title: "No type or content" },
      });

      expect(response.statusCode).toBe(400);
    });

    it("should list content items for a module", async () => {
      const { courseId, moduleId } = await setupCourseAndModule("ListContent");

      await app.inject({
        method: "POST",
        url: `/api/v1/admin/courses/${courseId}/modules/${moduleId}/content`,
        headers: { authorization: `Bearer ${adminToken()}` },
        payload: {
          title: "Item One",
          type: "text",
          content: { body: "First." },
        },
      });
      await app.inject({
        method: "POST",
        url: `/api/v1/admin/courses/${courseId}/modules/${moduleId}/content`,
        headers: { authorization: `Bearer ${adminToken()}` },
        payload: {
          title: "Item Two",
          type: "text",
          content: { body: "Second." },
        },
      });

      const listResponse = await app.inject({
        method: "GET",
        url: `/api/v1/admin/courses/${courseId}/modules/${moduleId}/content`,
        headers: { authorization: `Bearer ${adminToken()}` },
      });

      expect(listResponse.statusCode).toBe(200);
      const body = JSON.parse(listResponse.payload);
      expect(Array.isArray(body.data)).toBe(true);
      expect(body.data.length).toBeGreaterThanOrEqual(2);
    });

    it("should return an empty list for a module with no content", async () => {
      const { courseId, moduleId } = await setupCourseAndModule("EmptyContent");

      const listResponse = await app.inject({
        method: "GET",
        url: `/api/v1/admin/courses/${courseId}/modules/${moduleId}/content`,
        headers: { authorization: `Bearer ${adminToken()}` },
      });

      expect(listResponse.statusCode).toBe(200);
      const body = JSON.parse(listResponse.payload);
      expect(Array.isArray(body.data)).toBe(true);
      expect(body.data).toHaveLength(0);
    });

    it("should update a content item's title", async () => {
      const { courseId, moduleId } =
        await setupCourseAndModule("UpdateContent");

      const createResponse = await app.inject({
        method: "POST",
        url: `/api/v1/admin/courses/${courseId}/modules/${moduleId}/content`,
        headers: { authorization: `Bearer ${adminToken()}` },
        payload: {
          title: "Original Title",
          type: "text",
          content: { body: "Original body." },
        },
      });
      const contentId = JSON.parse(createResponse.payload).data.id;

      const updateResponse = await app.inject({
        method: "PUT",
        url: `/api/v1/admin/courses/${courseId}/modules/${moduleId}/content/${contentId}`,
        headers: { authorization: `Bearer ${adminToken()}` },
        payload: { title: "Updated Title" },
      });

      expect(updateResponse.statusCode).toBe(200);
      const body = JSON.parse(updateResponse.payload);
      expect(body.data.title).toBe("Updated Title");
    });

    it("should update a content item's body", async () => {
      const { courseId, moduleId } =
        await setupCourseAndModule("UpdateContentBody");

      const createResponse = await app.inject({
        method: "POST",
        url: `/api/v1/admin/courses/${courseId}/modules/${moduleId}/content`,
        headers: { authorization: `Bearer ${adminToken()}` },
        payload: {
          title: "Body Update Lesson",
          type: "text",
          content: { body: "Old body." },
        },
      });
      const contentId = JSON.parse(createResponse.payload).data.id;

      const updateResponse = await app.inject({
        method: "PUT",
        url: `/api/v1/admin/courses/${courseId}/modules/${moduleId}/content/${contentId}`,
        headers: { authorization: `Bearer ${adminToken()}` },
        payload: { content: { body: "New body." } },
      });

      expect(updateResponse.statusCode).toBe(200);
    });

    it("should delete a content item", async () => {
      const { courseId, moduleId } =
        await setupCourseAndModule("DeleteContent");

      const createResponse = await app.inject({
        method: "POST",
        url: `/api/v1/admin/courses/${courseId}/modules/${moduleId}/content`,
        headers: { authorization: `Bearer ${adminToken()}` },
        payload: {
          title: "Doomed Content",
          type: "text",
          content: { body: "Will be deleted." },
        },
      });
      const contentId = JSON.parse(createResponse.payload).data.id;

      const deleteResponse = await app.inject({
        method: "DELETE",
        url: `/api/v1/admin/courses/${courseId}/modules/${moduleId}/content/${contentId}`,
        headers: { authorization: `Bearer ${adminToken()}` },
      });

      expect(deleteResponse.statusCode).toBe(200);
    });

    it("should return 404 when deleting a non-existent content item", async () => {
      const { courseId, moduleId } =
        await setupCourseAndModule("DeleteNotFound");

      const response = await app.inject({
        method: "DELETE",
        url: `/api/v1/admin/courses/${courseId}/modules/${moduleId}/content/00000000-0000-0000-0000-000000000000`,
        headers: { authorization: `Bearer ${adminToken()}` },
      });

      expect(response.statusCode).toBe(404);
    });
  });

  describe("content reordering", () => {
    it("should reorder content items within a module atomically", async () => {
      const { courseId, moduleId } =
        await setupCourseAndModule("ReorderContent");

      const item1Response = await app.inject({
        method: "POST",
        url: `/api/v1/admin/courses/${courseId}/modules/${moduleId}/content`,
        headers: { authorization: `Bearer ${adminToken()}` },
        payload: {
          title: "Content Item 1",
          type: "text",
          content: { body: "First item." },
        },
      });
      const contentId1 = JSON.parse(item1Response.payload).data.id;

      const item2Response = await app.inject({
        method: "POST",
        url: `/api/v1/admin/courses/${courseId}/modules/${moduleId}/content`,
        headers: { authorization: `Bearer ${adminToken()}` },
        payload: {
          title: "Content Item 2",
          type: "text",
          content: { body: "Second item." },
        },
      });
      const contentId2 = JSON.parse(item2Response.payload).data.id;

      const reorderResponse = await app.inject({
        method: "POST",
        url: `/api/v1/admin/courses/${courseId}/modules/${moduleId}/content/reorder`,
        headers: { authorization: `Bearer ${adminToken()}` },
        payload: { contentIds: [contentId2, contentId1] },
      });

      expect(reorderResponse.statusCode).toBe(200);
      const body = JSON.parse(reorderResponse.payload);
      expect(body.success).toBe(true);
    });

    it("should create content with an explicit orderIndex", async () => {
      const { courseId, moduleId } =
        await setupCourseAndModule("OrderIndexContent");

      const response = await app.inject({
        method: "POST",
        url: `/api/v1/admin/courses/${courseId}/modules/${moduleId}/content`,
        headers: { authorization: `Bearer ${adminToken()}` },
        payload: {
          title: "Ordered Content",
          type: "text",
          content: { body: "At position 2." },
          orderIndex: 2,
        },
      });

      expect(response.statusCode).toBe(201);
      const body = JSON.parse(response.payload);
      expect(body.data.title).toBe("Ordered Content");
    });
  });
});
