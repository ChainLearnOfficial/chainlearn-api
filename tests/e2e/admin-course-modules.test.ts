import { describe, it, expect, beforeAll, afterAll } from "vitest";
import type { FastifyInstance } from "fastify";
import { eq } from "drizzle-orm";
import { buildApp } from "../../src/server.js";
import { db } from "../../src/config/database.js";
import { users, courses } from "../../src/database/schema.js";

describe("Admin Course Module Management API (#656)", () => {
  let app: FastifyInstance;

  const adminUserId = "e1c2d3e4-1111-4ef8-bb6d-6bb9bd380e56";
  const adminStellarAddress =
    "GADMINMODULE000000000000000000000000000000000000000000000".slice(0, 56);
  const nonAdminUserId = "e1c2d3e4-2222-4ef8-bb6d-6bb9bd380e56";
  const nonAdminStellarAddress =
    "GNONADMINMODULE000000000000000000000000000000000000000000".slice(0, 56);

  const createdCourseIds: string[] = [];

  beforeAll(async () => {
    app = await buildApp();
    await app.ready();

    await db
      .insert(users)
      .values({
        id: adminUserId,
        stellarAddress: adminStellarAddress,
        displayName: "Module Admin",
        isAdmin: true,
      })
      .onConflictDoNothing();

    await db
      .insert(users)
      .values({
        id: nonAdminUserId,
        stellarAddress: nonAdminStellarAddress,
        displayName: "Module Non-Admin",
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

  describe("auth", () => {
    it("should reject unauthenticated requests with 401", async () => {
      const [course] = await db
        .insert(courses)
        .values({ title: "Auth Module Course", description: "For auth tests" })
        .returning();
      createdCourseIds.push(course!.id);

      const response = await app.inject({
        method: "POST",
        url: `/api/v1/admin/courses/${course!.id}/modules`,
        payload: { title: "Unauthorized Module" },
      });

      expect(response.statusCode).toBe(401);
    });

    it("should reject non-admin users with 403", async () => {
      const [course] = await db
        .insert(courses)
        .values({
          title: "Non-Admin Module Course",
          description: "For 403 tests",
        })
        .returning();
      createdCourseIds.push(course!.id);

      const response = await app.inject({
        method: "POST",
        url: `/api/v1/admin/courses/${course!.id}/modules`,
        headers: { authorization: `Bearer ${nonAdminToken()}` },
        payload: { title: "Forbidden Module" },
      });

      expect(response.statusCode).toBe(403);
    });
  });

  describe("module CRUD", () => {
    it("should create a module for a course", async () => {
      const [course] = await db
        .insert(courses)
        .values({
          title: "Create Module Course",
          description: "For create module tests",
        })
        .returning();
      createdCourseIds.push(course!.id);

      const response = await app.inject({
        method: "POST",
        url: `/api/v1/admin/courses/${course!.id}/modules`,
        headers: { authorization: `Bearer ${adminToken()}` },
        payload: { title: "Module Alpha", description: "First test module" },
      });

      expect(response.statusCode).toBe(201);
      const body = JSON.parse(response.payload);
      expect(body.success).toBe(true);
      expect(body.data.title).toBe("Module Alpha");
    });

    it("should create a module with an optional order field", async () => {
      const [course] = await db
        .insert(courses)
        .values({
          title: "Ordered Module Course",
          description: "For order tests",
        })
        .returning();
      createdCourseIds.push(course!.id);

      const response = await app.inject({
        method: "POST",
        url: `/api/v1/admin/courses/${course!.id}/modules`,
        headers: { authorization: `Bearer ${adminToken()}` },
        payload: {
          title: "Ordered Module",
          description: "With explicit order",
          order: 0,
        },
      });

      expect(response.statusCode).toBe(201);
      const body = JSON.parse(response.payload);
      expect(body.data.title).toBe("Ordered Module");
    });

    it("should reject module creation without a title", async () => {
      const [course] = await db
        .insert(courses)
        .values({
          title: "No Title Module Course",
          description: "For validation tests",
        })
        .returning();
      createdCourseIds.push(course!.id);

      const response = await app.inject({
        method: "POST",
        url: `/api/v1/admin/courses/${course!.id}/modules`,
        headers: { authorization: `Bearer ${adminToken()}` },
        payload: { description: "Missing title" },
      });

      expect(response.statusCode).toBe(400);
    });

    it("should return 404 when creating a module for a non-existent course", async () => {
      const response = await app.inject({
        method: "POST",
        url: "/api/v1/admin/courses/00000000-0000-0000-0000-000000000000/modules",
        headers: { authorization: `Bearer ${adminToken()}` },
        payload: { title: "Ghost Module" },
      });

      expect(response.statusCode).toBe(404);
    });

    it("should update a module's title", async () => {
      const [course] = await db
        .insert(courses)
        .values({
          title: "Update Module Course",
          description: "For update module tests",
        })
        .returning();
      createdCourseIds.push(course!.id);

      const createResponse = await app.inject({
        method: "POST",
        url: `/api/v1/admin/courses/${course!.id}/modules`,
        headers: { authorization: `Bearer ${adminToken()}` },
        payload: { title: "Original Module Title", description: "desc" },
      });
      const moduleId = JSON.parse(createResponse.payload).data.id;

      const updateResponse = await app.inject({
        method: "PUT",
        url: `/api/v1/admin/courses/${course!.id}/modules/${moduleId}`,
        headers: { authorization: `Bearer ${adminToken()}` },
        payload: { title: "Updated Module Title" },
      });

      expect(updateResponse.statusCode).toBe(200);
      const body = JSON.parse(updateResponse.payload);
      expect(body.data.title).toBe("Updated Module Title");
    });

    it("should update a module's description", async () => {
      const [course] = await db
        .insert(courses)
        .values({
          title: "Update Desc Module Course",
          description: "For desc update tests",
        })
        .returning();
      createdCourseIds.push(course!.id);

      const createResponse = await app.inject({
        method: "POST",
        url: `/api/v1/admin/courses/${course!.id}/modules`,
        headers: { authorization: `Bearer ${adminToken()}` },
        payload: { title: "Desc Module", description: "Original description" },
      });
      const moduleId = JSON.parse(createResponse.payload).data.id;

      const updateResponse = await app.inject({
        method: "PUT",
        url: `/api/v1/admin/courses/${course!.id}/modules/${moduleId}`,
        headers: { authorization: `Bearer ${adminToken()}` },
        payload: { description: "New description" },
      });

      expect(updateResponse.statusCode).toBe(200);
      const body = JSON.parse(updateResponse.payload);
      expect(body.data.description).toBe("New description");
    });

    it("should delete a module", async () => {
      const [course] = await db
        .insert(courses)
        .values({
          title: "Delete Module Course",
          description: "For delete module tests",
        })
        .returning();
      createdCourseIds.push(course!.id);

      const createResponse = await app.inject({
        method: "POST",
        url: `/api/v1/admin/courses/${course!.id}/modules`,
        headers: { authorization: `Bearer ${adminToken()}` },
        payload: { title: "Module To Delete", description: "Will be removed" },
      });
      const moduleId = JSON.parse(createResponse.payload).data.id;

      const deleteResponse = await app.inject({
        method: "DELETE",
        url: `/api/v1/admin/courses/${course!.id}/modules/${moduleId}`,
        headers: { authorization: `Bearer ${adminToken()}` },
      });

      expect(deleteResponse.statusCode).toBe(200);
    });

    it("should return 404 when deleting a non-existent module", async () => {
      const [course] = await db
        .insert(courses)
        .values({
          title: "Ghost Delete Module Course",
          description: "For 404 delete tests",
        })
        .returning();
      createdCourseIds.push(course!.id);

      const response = await app.inject({
        method: "DELETE",
        url: `/api/v1/admin/courses/${course!.id}/modules/nonexistent-module-id`,
        headers: { authorization: `Bearer ${adminToken()}` },
      });

      expect(response.statusCode).toBe(404);
    });
  });

  describe("module reordering", () => {
    it("should reorder modules atomically", async () => {
      const [course] = await db
        .insert(courses)
        .values({
          title: "Reorder Modules Course",
          description: "For reorder tests",
        })
        .returning();
      createdCourseIds.push(course!.id);

      const mod1Response = await app.inject({
        method: "POST",
        url: `/api/v1/admin/courses/${course!.id}/modules`,
        headers: { authorization: `Bearer ${adminToken()}` },
        payload: { title: "Module One", description: "First" },
      });
      const moduleOneId = JSON.parse(mod1Response.payload).data.id;

      const mod2Response = await app.inject({
        method: "POST",
        url: `/api/v1/admin/courses/${course!.id}/modules`,
        headers: { authorization: `Bearer ${adminToken()}` },
        payload: { title: "Module Two", description: "Second" },
      });
      const moduleTwoId = JSON.parse(mod2Response.payload).data.id;

      const reorderResponse = await app.inject({
        method: "POST",
        url: `/api/v1/admin/courses/${course!.id}/modules/reorder`,
        headers: { authorization: `Bearer ${adminToken()}` },
        payload: { moduleIds: [moduleTwoId, moduleOneId] },
      });

      expect(reorderResponse.statusCode).toBe(200);
      const body = JSON.parse(reorderResponse.payload);
      expect(body.success).toBe(true);
    });

    it("should reject reorder with an empty moduleIds array", async () => {
      const [course] = await db
        .insert(courses)
        .values({
          title: "Empty Reorder Course",
          description: "For empty reorder tests",
        })
        .returning();
      createdCourseIds.push(course!.id);

      const response = await app.inject({
        method: "POST",
        url: `/api/v1/admin/courses/${course!.id}/modules/reorder`,
        headers: { authorization: `Bearer ${adminToken()}` },
        payload: { moduleIds: [] },
      });

      expect(response.statusCode).toBe(400);
    });

    it("should reject reorder with a missing moduleIds field", async () => {
      const [course] = await db
        .insert(courses)
        .values({
          title: "Missing ModuleIds Course",
          description: "For missing field tests",
        })
        .returning();
      createdCourseIds.push(course!.id);

      const response = await app.inject({
        method: "POST",
        url: `/api/v1/admin/courses/${course!.id}/modules/reorder`,
        headers: { authorization: `Bearer ${adminToken()}` },
        payload: {},
      });

      expect(response.statusCode).toBe(400);
    });
  });

  describe("module content listing", () => {
    it("should list content items within a module", async () => {
      const [course] = await db
        .insert(courses)
        .values({
          title: "Module Content List Course",
          description: "For content listing",
        })
        .returning();
      createdCourseIds.push(course!.id);

      const moduleResponse = await app.inject({
        method: "POST",
        url: `/api/v1/admin/courses/${course!.id}/modules`,
        headers: { authorization: `Bearer ${adminToken()}` },
        payload: { title: "Content Listing Module", description: "desc" },
      });
      const moduleId = JSON.parse(moduleResponse.payload).data.id;

      await app.inject({
        method: "POST",
        url: `/api/v1/admin/courses/${course!.id}/modules/${moduleId}/content`,
        headers: { authorization: `Bearer ${adminToken()}` },
        payload: {
          title: "A content item",
          type: "text",
          content: { body: "Hello from module listing test." },
        },
      });

      const listResponse = await app.inject({
        method: "GET",
        url: `/api/v1/admin/courses/${course!.id}/modules/${moduleId}/content`,
        headers: { authorization: `Bearer ${adminToken()}` },
      });

      expect(listResponse.statusCode).toBe(200);
      const body = JSON.parse(listResponse.payload);
      expect(Array.isArray(body.data)).toBe(true);
      expect(body.data.length).toBeGreaterThanOrEqual(1);
    });
  });
});
