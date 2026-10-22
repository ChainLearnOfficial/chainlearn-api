import { describe, it, expect, beforeAll, afterAll } from "vitest";
import type { FastifyInstance } from "fastify";
import { eq } from "drizzle-orm";
import { buildApp } from "../../src/server.js";
import { db } from "../../src/config/database.js";
import { users, courses, enrollments } from "../../src/database/schema.js";

describe("Admin Course Enrolled Users API (#657)", () => {
  let app: FastifyInstance;

  const adminUserId = "d1c2d3e4-1111-4ef8-bb6d-6bb9bd380d57";
  const adminStellarAddress =
    "GADMINCEUSER000000000000000000000000000000000000000000000".slice(0, 56);
  const nonAdminUserId = "d1c2d3e4-2222-4ef8-bb6d-6bb9bd380d57";
  const nonAdminStellarAddress =
    "GNONADMINCEUSER00000000000000000000000000000000000000000".slice(0, 56);

  const enrolledUserAId = "d1c2d3e4-3333-4ef8-bb6d-6bb9bd380d57";
  const enrolledUserAStellar =
    "GENROLLEDUSERAA0000000000000000000000000000000000000000".slice(0, 56);
  const enrolledUserBId = "d1c2d3e4-4444-4ef8-bb6d-6bb9bd380d57";
  const enrolledUserBStellar =
    "GENROLLEDUSERBBB0000000000000000000000000000000000000000".slice(0, 56);

  const createdCourseIds: string[] = [];

  beforeAll(async () => {
    app = await buildApp();
    await app.ready();

    await db
      .insert(users)
      .values({
        id: adminUserId,
        stellarAddress: adminStellarAddress,
        displayName: "Enrolled Users Admin",
        isAdmin: true,
      })
      .onConflictDoNothing();

    await db
      .insert(users)
      .values({
        id: nonAdminUserId,
        stellarAddress: nonAdminStellarAddress,
        displayName: "Enrolled Users Non-Admin",
        isAdmin: false,
      })
      .onConflictDoNothing();

    await db
      .insert(users)
      .values([
        {
          id: enrolledUserAId,
          stellarAddress: enrolledUserAStellar,
          displayName: "Enrolled User A",
        },
        {
          id: enrolledUserBId,
          stellarAddress: enrolledUserBStellar,
          displayName: "Enrolled User B",
        },
      ])
      .onConflictDoNothing();
  });

  afterAll(async () => {
    for (const id of createdCourseIds) {
      await db.delete(enrollments).where(eq(enrollments.courseId, id));
      await db.delete(courses).where(eq(courses.id, id));
    }
    await db.delete(users).where(eq(users.id, enrolledUserAId));
    await db.delete(users).where(eq(users.id, enrolledUserBId));
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
        .values({ title: "Auth Test Course EU", description: "For auth tests" })
        .returning();
      createdCourseIds.push(course!.id);

      const response = await app.inject({
        method: "GET",
        url: `/api/v1/admin/courses/${course!.id}/enrolled-users`,
      });

      expect(response.statusCode).toBe(401);
    });

    it("should reject non-admin users with 403", async () => {
      const [course] = await db
        .insert(courses)
        .values({
          title: "Non-Admin Test Course EU",
          description: "For 403 tests",
        })
        .returning();
      createdCourseIds.push(course!.id);

      const response = await app.inject({
        method: "GET",
        url: `/api/v1/admin/courses/${course!.id}/enrolled-users`,
        headers: { authorization: `Bearer ${nonAdminToken()}` },
      });

      expect(response.statusCode).toBe(403);
    });
  });

  describe("listing enrolled users", () => {
    it("should return an empty list for a course with no enrollments", async () => {
      const [course] = await db
        .insert(courses)
        .values({
          title: "No Enrollments Course",
          description: "Zero enrolled",
        })
        .returning();
      createdCourseIds.push(course!.id);

      const response = await app.inject({
        method: "GET",
        url: `/api/v1/admin/courses/${course!.id}/enrolled-users`,
        headers: { authorization: `Bearer ${adminToken()}` },
      });

      expect(response.statusCode).toBe(200);
      const body = JSON.parse(response.payload);
      expect(body.success).toBe(true);
      expect(Array.isArray(body.data.users)).toBe(true);
      expect(body.data.total).toBe(0);
      expect(body.data.users).toHaveLength(0);
    });

    it("should list enrolled users with quiz progress fields", async () => {
      const [course] = await db
        .insert(courses)
        .values({
          title: "Enrolled Users List Course",
          description: "For listing tests",
        })
        .returning();
      createdCourseIds.push(course!.id);

      await db
        .insert(enrollments)
        .values({ userId: enrolledUserAId, courseId: course!.id })
        .onConflictDoNothing();

      const response = await app.inject({
        method: "GET",
        url: `/api/v1/admin/courses/${course!.id}/enrolled-users`,
        headers: { authorization: `Bearer ${adminToken()}` },
      });

      expect(response.statusCode).toBe(200);
      const body = JSON.parse(response.payload);
      expect(body.success).toBe(true);
      expect(body.data.total).toBe(1);
      expect(body.data.users).toHaveLength(1);

      const user = body.data.users[0];
      expect(user.userId).toBe(enrolledUserAId);
      expect(user).toHaveProperty("quizCount");
      expect(user).toHaveProperty("averageScore");
    });

    it("should list multiple enrolled users", async () => {
      const [course] = await db
        .insert(courses)
        .values({
          title: "Multi Enrolled Users Course",
          description: "For multi-user listing",
        })
        .returning();
      createdCourseIds.push(course!.id);

      await db
        .insert(enrollments)
        .values([
          { userId: enrolledUserAId, courseId: course!.id },
          { userId: enrolledUserBId, courseId: course!.id },
        ])
        .onConflictDoNothing();

      const response = await app.inject({
        method: "GET",
        url: `/api/v1/admin/courses/${course!.id}/enrolled-users`,
        headers: { authorization: `Bearer ${adminToken()}` },
      });

      expect(response.statusCode).toBe(200);
      const body = JSON.parse(response.payload);
      expect(body.data.total).toBe(2);
      expect(body.data.users).toHaveLength(2);
    });

    it("should return 404 for a non-existent course", async () => {
      const response = await app.inject({
        method: "GET",
        url: "/api/v1/admin/courses/00000000-0000-0000-0000-000000000000/enrolled-users",
        headers: { authorization: `Bearer ${adminToken()}` },
      });

      expect(response.statusCode).toBe(404);
    });
  });

  describe("pagination", () => {
    it("should paginate enrolled users with page and limit query params", async () => {
      const [course] = await db
        .insert(courses)
        .values({
          title: "Pagination Test Course EU",
          description: "For pagination tests",
        })
        .returning();
      createdCourseIds.push(course!.id);

      await db
        .insert(enrollments)
        .values([
          { userId: enrolledUserAId, courseId: course!.id },
          { userId: enrolledUserBId, courseId: course!.id },
        ])
        .onConflictDoNothing();

      const page1 = await app.inject({
        method: "GET",
        url: `/api/v1/admin/courses/${course!.id}/enrolled-users?page=1&limit=1`,
        headers: { authorization: `Bearer ${adminToken()}` },
      });

      expect(page1.statusCode).toBe(200);
      const body1 = JSON.parse(page1.payload);
      expect(body1.data.total).toBe(2);
      expect(body1.data.users).toHaveLength(1);

      const page2 = await app.inject({
        method: "GET",
        url: `/api/v1/admin/courses/${course!.id}/enrolled-users?page=2&limit=1`,
        headers: { authorization: `Bearer ${adminToken()}` },
      });

      expect(page2.statusCode).toBe(200);
      const body2 = JSON.parse(page2.payload);
      expect(body2.data.total).toBe(2);
      expect(body2.data.users).toHaveLength(1);

      // The two pages should return different users
      expect(body1.data.users[0].userId).not.toBe(body2.data.users[0].userId);
    });

    it("should use default pagination when no params are given", async () => {
      const [course] = await db
        .insert(courses)
        .values({
          title: "Default Pagination Course EU",
          description: "For default pagination",
        })
        .returning();
      createdCourseIds.push(course!.id);

      await db
        .insert(enrollments)
        .values({ userId: enrolledUserAId, courseId: course!.id })
        .onConflictDoNothing();

      const response = await app.inject({
        method: "GET",
        url: `/api/v1/admin/courses/${course!.id}/enrolled-users`,
        headers: { authorization: `Bearer ${adminToken()}` },
      });

      expect(response.statusCode).toBe(200);
      const body = JSON.parse(response.payload);
      expect(body.data).toHaveProperty("users");
      expect(body.data).toHaveProperty("total");
    });

    it("should reject invalid pagination params (page=0)", async () => {
      const [course] = await db
        .insert(courses)
        .values({
          title: "Invalid Pagination Course EU",
          description: "For invalid params",
        })
        .returning();
      createdCourseIds.push(course!.id);

      const response = await app.inject({
        method: "GET",
        url: `/api/v1/admin/courses/${course!.id}/enrolled-users?page=0`,
        headers: { authorization: `Bearer ${adminToken()}` },
      });

      expect(response.statusCode).toBe(400);
    });

    it("should reject limit exceeding maximum (limit=51)", async () => {
      const [course] = await db
        .insert(courses)
        .values({
          title: "Limit Exceed Course EU",
          description: "For limit exceed tests",
        })
        .returning();
      createdCourseIds.push(course!.id);

      const response = await app.inject({
        method: "GET",
        url: `/api/v1/admin/courses/${course!.id}/enrolled-users?limit=51`,
        headers: { authorization: `Bearer ${adminToken()}` },
      });

      expect(response.statusCode).toBe(400);
    });
  });

  describe("progress tracking", () => {
    it("should include quizCount of 0 and null averageScore for users with no quiz submissions", async () => {
      const [course] = await db
        .insert(courses)
        .values({
          title: "No Quizzes Course EU",
          description: "For no-quiz progress tests",
        })
        .returning();
      createdCourseIds.push(course!.id);

      await db
        .insert(enrollments)
        .values({ userId: enrolledUserBId, courseId: course!.id })
        .onConflictDoNothing();

      const response = await app.inject({
        method: "GET",
        url: `/api/v1/admin/courses/${course!.id}/enrolled-users`,
        headers: { authorization: `Bearer ${adminToken()}` },
      });

      expect(response.statusCode).toBe(200);
      const body = JSON.parse(response.payload);
      const user = body.data.users.find(
        (u: { userId: string }) => u.userId === enrolledUserBId,
      );
      expect(user).toBeDefined();
      expect(user.quizCount).toBe(0);
      expect(user.averageScore).toBeNull();
    });
  });
});
