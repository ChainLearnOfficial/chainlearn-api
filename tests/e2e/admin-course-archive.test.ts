import { describe, it, expect, beforeAll, afterAll } from "vitest";
import type { FastifyInstance } from "fastify";
import { eq } from "drizzle-orm";
import { buildApp } from "../../src/server.js";
import { db } from "../../src/config/database.js";
import { users, courses, enrollments } from "../../src/database/schema.js";

describe("Admin Course Archive E2E API (#653)", () => {
  let app: FastifyInstance;

  const adminUserId = "c1a2d3e4-1111-4ef8-bb6d-6bb9bd380c10";
  const adminStellarAddress = "GADMINARCHIVE000000000000000000000000000000000000000000".slice(
    0,
    56,
  );
  const nonAdminUserId = "c1a2d3e4-2222-4ef8-bb6d-6bb9bd380c10";
  const nonAdminStellarAddress =
    "GNONADMINARCHIVE000000000000000000000000000000000000000".slice(0, 56);

  const learnerUserId = "c1a2d3e4-3333-4ef8-bb6d-6bb9bd380c10";
  const learnerStellarAddress =
    "GLEARNERARCHIVE0000000000000000000000000000000000000000".slice(0, 56);

  const createdCourseIds: string[] = [];

  beforeAll(async () => {
    app = await buildApp();
    await app.ready();

    await db
      .insert(users)
      .values({
        id: adminUserId,
        stellarAddress: adminStellarAddress,
        displayName: "Archive Admin",
        isAdmin: true,
      })
      .onConflictDoNothing();

    await db
      .insert(users)
      .values({
        id: nonAdminUserId,
        stellarAddress: nonAdminStellarAddress,
        displayName: "Archive Non-Admin",
        isAdmin: false,
      })
      .onConflictDoNothing();

    await db
      .insert(users)
      .values({
        id: learnerUserId,
        stellarAddress: learnerStellarAddress,
        displayName: "Archive Learner",
        isAdmin: false,
      })
      .onConflictDoNothing();
  });

  afterAll(async () => {
    for (const id of createdCourseIds) {
      await db.delete(enrollments).where(eq(enrollments.courseId, id));
      await db.delete(courses).where(eq(courses.id, id));
    }
    await db.delete(users).where(eq(users.id, adminUserId));
    await db.delete(users).where(eq(users.id, nonAdminUserId));
    await db.delete(users).where(eq(users.id, learnerUserId));
    await app.close();
  });

  const adminToken = () =>
    app.jwt.sign({ sub: adminUserId, stellarAddress: adminStellarAddress });

  const nonAdminToken = () =>
    app.jwt.sign({ sub: nonAdminUserId, stellarAddress: nonAdminStellarAddress });

  const learnerToken = () =>
    app.jwt.sign({ sub: learnerUserId, stellarAddress: learnerStellarAddress });

  describe("Authentication & Authorization", () => {
    it("should reject unauthenticated requests with 401", async () => {
      const response = await app.inject({
        method: "POST",
        url: "/api/v1/admin/courses/00000000-0000-0000-0000-000000000000/archive",
      });

      expect(response.statusCode).toBe(401);
    });

    it("should reject non-admin users with 403", async () => {
      const response = await app.inject({
        method: "POST",
        url: "/api/v1/admin/courses/00000000-0000-0000-0000-000000000000/archive",
        headers: { authorization: `Bearer ${nonAdminToken()}` },
      });

      expect(response.statusCode).toBe(403);
    });

    it("should return 400 for invalid UUID format", async () => {
      const response = await app.inject({
        method: "POST",
        url: "/api/v1/admin/courses/not-a-valid-uuid/archive",
        headers: { authorization: `Bearer ${adminToken()}` },
      });

      expect(response.statusCode).toBe(400);
    });

    it("should return 404 when archiving a non-existent course", async () => {
      const nonExistentId = "ffffffff-ffff-4fff-bfff-ffffffffffff";
      const response = await app.inject({
        method: "POST",
        url: `/api/v1/admin/courses/${nonExistentId}/archive`,
        headers: { authorization: `Bearer ${adminToken()}` },
      });

      expect(response.statusCode).toBe(404);
    });
  });

  describe("Course Archiving & Unarchiving State Lifecycle", () => {
    it("should archive an active course and set archivedAt timestamp", async () => {
      const [course] = await db
        .insert(courses)
        .values({
          title: "Course to Archive",
          description: "Active course testing archive state transition",
          difficulty: "beginner",
          isActive: true,
          isDraft: false,
        })
        .returning();
      createdCourseIds.push(course!.id);

      const response = await app.inject({
        method: "POST",
        url: `/api/v1/admin/courses/${course!.id}/archive`,
        headers: { authorization: `Bearer ${adminToken()}` },
      });

      expect(response.statusCode).toBe(200);
      const body = JSON.parse(response.payload);
      expect(body.success).toBe(true);
      expect(body.message).toBe("Course archived");

      // Verify DB record
      const [updated] = await db
        .select()
        .from(courses)
        .where(eq(courses.id, course!.id));

      expect(updated?.isActive).toBe(false);
      expect(updated?.archivedAt).not.toBeNull();
    });

    it("should keep original archivedAt timestamp when archiving an already archived course", async () => {
      const originalArchivedDate = new Date(Date.now() - 3600000); // 1 hour ago
      const [course] = await db
        .insert(courses)
        .values({
          title: "Already Archived Course",
          description: "Idempotent archive timestamp verification",
          difficulty: "intermediate",
          isActive: false,
          archivedAt: originalArchivedDate,
        })
        .returning();
      createdCourseIds.push(course!.id);

      const response = await app.inject({
        method: "POST",
        url: `/api/v1/admin/courses/${course!.id}/archive`,
        headers: { authorization: `Bearer ${adminToken()}` },
      });

      expect(response.statusCode).toBe(200);

      const [updated] = await db
        .select()
        .from(courses)
        .where(eq(courses.id, course!.id));

      // Timestamp should remain unchanged
      expect(updated?.isActive).toBe(false);
      expect(updated?.archivedAt?.toISOString()).toBe(originalArchivedDate.toISOString());
    });

    it("should allow unarchiving / activating the course via update", async () => {
      const [course] = await db
        .insert(courses)
        .values({
          title: "Archived Course to Unarchive",
          description: "Testing unarchive / reactivation via update",
          difficulty: "advanced",
          isActive: false,
          archivedAt: new Date(),
        })
        .returning();
      createdCourseIds.push(course!.id);

      // Admin updates course to active
      const response = await app.inject({
        method: "PUT",
        url: `/api/v1/admin/courses/${course!.id}`,
        headers: { authorization: `Bearer ${adminToken()}` },
        payload: {
          isActive: true,
        },
      });

      expect(response.statusCode).toBe(200);
      const body = JSON.parse(response.payload);
      expect(body.success).toBe(true);
      expect(body.data.isActive).toBe(true);

      const [updated] = await db
        .select()
        .from(courses)
        .where(eq(courses.id, course!.id));

      expect(updated?.isActive).toBe(true);
    });
  });

  describe("Listing and Visibility Behavior", () => {
    it("should exclude archived course from public course listings", async () => {
      const [course] = await db
        .insert(courses)
        .values({
          title: "Archived Hidden From Public",
          description: "This course should not appear in public list",
          difficulty: "beginner",
          isActive: false,
          archivedAt: new Date(),
        })
        .returning();
      createdCourseIds.push(course!.id);

      const listResponse = await app.inject({
        method: "GET",
        url: "/api/v1/courses",
      });

      expect(listResponse.statusCode).toBe(200);
      const listBody = JSON.parse(listResponse.payload);
      const courseInList = listBody.data?.courses?.some(
        (c: { id: string }) => c.id === course!.id,
      );
      expect(courseInList).toBe(false);
    });

    it("should preserve enrolled learner access to an archived course", async () => {
      const [course] = await db
        .insert(courses)
        .values({
          title: "Archived Enrolled Course",
          description: "Enrolled users retain access",
          difficulty: "beginner",
          isActive: false,
          archivedAt: new Date(),
        })
        .returning();
      createdCourseIds.push(course!.id);

      // Enroll learner
      await db
        .insert(enrollments)
        .values({
          userId: learnerUserId,
          courseId: course!.id,
          progress: 25,
        })
        .onConflictDoNothing();

      // Learner requests course detail
      const detailResponse = await app.inject({
        method: "GET",
        url: `/api/v1/courses/${course!.id}`,
        headers: { authorization: `Bearer ${learnerToken()}` },
      });

      expect(detailResponse.statusCode).toBe(200);
      const body = JSON.parse(detailResponse.payload);
      expect(body.success).toBe(true);
      expect(body.data.id).toBe(course!.id);
      expect(body.data.title).toBe("Archived Enrolled Course");
    });

    it("should allow admin to inspect archived course in admin view", async () => {
      const [course] = await db
        .insert(courses)
        .values({
          title: "Archived Admin Viewable",
          description: "Admins can view archived courses",
          difficulty: "intermediate",
          isActive: false,
          archivedAt: new Date(),
        })
        .returning();
      createdCourseIds.push(course!.id);

      const adminResponse = await app.inject({
        method: "GET",
        url: `/api/v1/admin/courses/${course!.id}`,
        headers: { authorization: `Bearer ${adminToken()}` },
      });

      expect(adminResponse.statusCode).toBe(200);
      const body = JSON.parse(adminResponse.payload);
      expect(body.success).toBe(true);
      expect(body.data.id).toBe(course!.id);
      expect(body.data.isActive).toBe(false);
      expect(body.data.archivedAt).not.toBeNull();
    });
  });
});
