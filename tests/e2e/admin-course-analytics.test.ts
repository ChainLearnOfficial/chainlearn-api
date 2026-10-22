import { describe, it, expect, beforeAll, afterAll } from "vitest";
import type { FastifyInstance } from "fastify";
import { eq } from "drizzle-orm";
import { buildApp } from "../../src/server.js";
import { db } from "../../src/config/database.js";
import { users, courses, enrollments } from "../../src/database/schema.js";

describe("Admin Course Analytics API (#654)", () => {
  let app: FastifyInstance;

  const adminUserId = "b1c2d3e4-1111-4ef8-bb6d-6bb9bd380b54";
  const adminStellarAddress =
    "GADMINANALYTICS00000000000000000000000000000000000000000".slice(0, 56);
  const nonAdminUserId = "b1c2d3e4-2222-4ef8-bb6d-6bb9bd380b54";
  const nonAdminStellarAddress =
    "GNONADMINANALYTICS000000000000000000000000000000000000000".slice(0, 56);

  const enrolledUserAId = "b1c2d3e4-3333-4ef8-bb6d-6bb9bd380b54";
  const enrolledUserAStellar =
    "GANALYTICSUSERAAA0000000000000000000000000000000000000000".slice(0, 56);

  const createdCourseIds: string[] = [];

  beforeAll(async () => {
    app = await buildApp();
    await app.ready();

    await db
      .insert(users)
      .values({
        id: adminUserId,
        stellarAddress: adminStellarAddress,
        displayName: "Analytics Admin",
        isAdmin: true,
      })
      .onConflictDoNothing();

    await db
      .insert(users)
      .values({
        id: nonAdminUserId,
        stellarAddress: nonAdminStellarAddress,
        displayName: "Analytics Non-Admin",
        isAdmin: false,
      })
      .onConflictDoNothing();

    await db
      .insert(users)
      .values({
        id: enrolledUserAId,
        stellarAddress: enrolledUserAStellar,
        displayName: "Analytics Enrolled User A",
      })
      .onConflictDoNothing();
  });

  afterAll(async () => {
    for (const id of createdCourseIds) {
      await db.delete(enrollments).where(eq(enrollments.courseId, id));
      await db.delete(courses).where(eq(courses.id, id));
    }
    await db.delete(users).where(eq(users.id, enrolledUserAId));
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
    it("should reject unauthenticated analytics requests with 401", async () => {
      const [course] = await db
        .insert(courses)
        .values({
          title: "Analytics Auth Course",
          description: "For auth tests",
        })
        .returning();
      createdCourseIds.push(course!.id);

      const response = await app.inject({
        method: "GET",
        url: `/api/v1/admin/courses/${course!.id}/analytics`,
      });

      expect(response.statusCode).toBe(401);
    });

    it("should reject non-admin analytics requests with 403", async () => {
      const [course] = await db
        .insert(courses)
        .values({
          title: "Analytics Non-Admin Course",
          description: "For 403 tests",
        })
        .returning();
      createdCourseIds.push(course!.id);

      const response = await app.inject({
        method: "GET",
        url: `/api/v1/admin/courses/${course!.id}/analytics`,
        headers: { authorization: `Bearer ${nonAdminToken()}` },
      });

      expect(response.statusCode).toBe(403);
    });
  });

  describe("course analytics endpoint", () => {
    it("should return analytics data for a valid course", async () => {
      const [course] = await db
        .insert(courses)
        .values({
          title: "Analytics Test Course",
          description: "For analytics tests",
          isActive: true,
        })
        .returning();
      createdCourseIds.push(course!.id);

      const response = await app.inject({
        method: "GET",
        url: `/api/v1/admin/courses/${course!.id}/analytics`,
        headers: { authorization: `Bearer ${adminToken()}` },
      });

      expect(response.statusCode).toBe(200);
      const body = JSON.parse(response.payload);
      expect(body.success).toBe(true);
      expect(body.data).toBeDefined();
    });

    it("should return 404 for a non-existent course", async () => {
      const response = await app.inject({
        method: "GET",
        url: "/api/v1/admin/courses/00000000-0000-0000-0000-000000000000/analytics",
        headers: { authorization: `Bearer ${adminToken()}` },
      });

      expect(response.statusCode).toBe(404);
    });

    it("should include enrollment trend data in the analytics response", async () => {
      const [course] = await db
        .insert(courses)
        .values({
          title: "Enrollment Trends Analytics Course",
          description: "For trend tests",
          isActive: true,
        })
        .returning();
      createdCourseIds.push(course!.id);

      await db
        .insert(enrollments)
        .values({ userId: enrolledUserAId, courseId: course!.id })
        .onConflictDoNothing();

      const response = await app.inject({
        method: "GET",
        url: `/api/v1/admin/courses/${course!.id}/analytics`,
        headers: { authorization: `Bearer ${adminToken()}` },
      });

      expect(response.statusCode).toBe(200);
      const body = JSON.parse(response.payload);
      expect(body.data).toHaveProperty("totalEnrollments");
    });

    it("should return zero enrollments for a brand-new course", async () => {
      const [course] = await db
        .insert(courses)
        .values({
          title: "Zero Enrollments Analytics Course",
          description: "For zero count tests",
        })
        .returning();
      createdCourseIds.push(course!.id);

      const response = await app.inject({
        method: "GET",
        url: `/api/v1/admin/courses/${course!.id}/analytics`,
        headers: { authorization: `Bearer ${adminToken()}` },
      });

      expect(response.statusCode).toBe(200);
      const body = JSON.parse(response.payload);
      expect(body.data.totalEnrollments).toBe(0);
    });

    it("should return 400 for an invalid course ID format", async () => {
      const response = await app.inject({
        method: "GET",
        url: "/api/v1/admin/courses/not-a-uuid/analytics",
        headers: { authorization: `Bearer ${adminToken()}` },
      });

      expect(response.statusCode).toBe(400);
    });
  });

  describe("enrollment trends", () => {
    it("should return enrollment trends with default range and granularity", async () => {
      const [course] = await db
        .insert(courses)
        .values({
          title: "Trends Default Course",
          description: "For default trend tests",
        })
        .returning();
      createdCourseIds.push(course!.id);

      const response = await app.inject({
        method: "GET",
        url: `/api/v1/admin/courses/${course!.id}/enrollment-trends`,
        headers: { authorization: `Bearer ${adminToken()}` },
      });

      expect(response.statusCode).toBe(200);
      const body = JSON.parse(response.payload);
      expect(body.success).toBe(true);
      expect(body.data).toBeDefined();
    });

    it("should return trends for 7d range with daily granularity", async () => {
      const [course] = await db
        .insert(courses)
        .values({
          title: "Trends 7d Daily Course",
          description: "For 7d daily trends",
        })
        .returning();
      createdCourseIds.push(course!.id);

      const response = await app.inject({
        method: "GET",
        url: `/api/v1/admin/courses/${course!.id}/enrollment-trends?range=7d&granularity=daily`,
        headers: { authorization: `Bearer ${adminToken()}` },
      });

      expect(response.statusCode).toBe(200);
      const body = JSON.parse(response.payload);
      expect(body.data).toBeDefined();
    });

    it("should return trends for 30d range with weekly granularity", async () => {
      const [course] = await db
        .insert(courses)
        .values({
          title: "Trends 30d Weekly Course",
          description: "For 30d weekly trends",
        })
        .returning();
      createdCourseIds.push(course!.id);

      const response = await app.inject({
        method: "GET",
        url: `/api/v1/admin/courses/${course!.id}/enrollment-trends?range=30d&granularity=weekly`,
        headers: { authorization: `Bearer ${adminToken()}` },
      });

      expect(response.statusCode).toBe(200);
      const body = JSON.parse(response.payload);
      expect(body.data).toBeDefined();
    });

    it("should return trends for 90d range with monthly granularity", async () => {
      const [course] = await db
        .insert(courses)
        .values({
          title: "Trends 90d Monthly Course",
          description: "For 90d monthly trends",
        })
        .returning();
      createdCourseIds.push(course!.id);

      const response = await app.inject({
        method: "GET",
        url: `/api/v1/admin/courses/${course!.id}/enrollment-trends?range=90d&granularity=monthly`,
        headers: { authorization: `Bearer ${adminToken()}` },
      });

      expect(response.statusCode).toBe(200);
    });

    it("should reject an invalid range parameter", async () => {
      const [course] = await db
        .insert(courses)
        .values({
          title: "Trends Invalid Range Course",
          description: "For invalid range tests",
        })
        .returning();
      createdCourseIds.push(course!.id);

      const response = await app.inject({
        method: "GET",
        url: `/api/v1/admin/courses/${course!.id}/enrollment-trends?range=1y`,
        headers: { authorization: `Bearer ${adminToken()}` },
      });

      expect(response.statusCode).toBe(400);
    });

    it("should reject an invalid granularity parameter", async () => {
      const [course] = await db
        .insert(courses)
        .values({
          title: "Trends Invalid Granularity Course",
          description: "For invalid granularity",
        })
        .returning();
      createdCourseIds.push(course!.id);

      const response = await app.inject({
        method: "GET",
        url: `/api/v1/admin/courses/${course!.id}/enrollment-trends?granularity=hourly`,
        headers: { authorization: `Bearer ${adminToken()}` },
      });

      expect(response.statusCode).toBe(400);
    });
  });

  describe("module engagement metrics", () => {
    it("should return engagement metrics including completion rate", async () => {
      const [course] = await db
        .insert(courses)
        .values({
          title: "Engagement Metrics Course",
          description: "For engagement tests",
          isActive: true,
        })
        .returning();
      createdCourseIds.push(course!.id);

      const response = await app.inject({
        method: "GET",
        url: `/api/v1/admin/courses/${course!.id}/engagement`,
        headers: { authorization: `Bearer ${adminToken()}` },
      });

      expect(response.statusCode).toBe(200);
      const body = JSON.parse(response.payload);
      expect(body.success).toBe(true);
      expect(body.data).toHaveProperty("completionRate");
    });

    it("should include per-module drop-off data in engagement response", async () => {
      const [course] = await db
        .insert(courses)
        .values({
          title: "Dropoff Metrics Course",
          description: "For drop-off tests",
        })
        .returning();
      createdCourseIds.push(course!.id);

      const response = await app.inject({
        method: "GET",
        url: `/api/v1/admin/courses/${course!.id}/engagement`,
        headers: { authorization: `Bearer ${adminToken()}` },
      });

      expect(response.statusCode).toBe(200);
      const body = JSON.parse(response.payload);
      expect(body.data).toHaveProperty("moduleDropOff");
    });

    it("should reject unauthenticated engagement requests with 401", async () => {
      const [course] = await db
        .insert(courses)
        .values({
          title: "Engagement Auth Course",
          description: "For auth tests",
        })
        .returning();
      createdCourseIds.push(course!.id);

      const response = await app.inject({
        method: "GET",
        url: `/api/v1/admin/courses/${course!.id}/engagement`,
      });

      expect(response.statusCode).toBe(401);
    });

    it("should reject non-admin engagement requests with 403", async () => {
      const [course] = await db
        .insert(courses)
        .values({
          title: "Engagement Non-Admin Course",
          description: "For 403 tests",
        })
        .returning();
      createdCourseIds.push(course!.id);

      const response = await app.inject({
        method: "GET",
        url: `/api/v1/admin/courses/${course!.id}/engagement`,
        headers: { authorization: `Bearer ${nonAdminToken()}` },
      });

      expect(response.statusCode).toBe(403);
    });

    it("should return 404 for a non-existent course engagement", async () => {
      const response = await app.inject({
        method: "GET",
        url: "/api/v1/admin/courses/00000000-0000-0000-0000-000000000000/engagement",
        headers: { authorization: `Bearer ${adminToken()}` },
      });

      expect(response.statusCode).toBe(404);
    });
  });
});
