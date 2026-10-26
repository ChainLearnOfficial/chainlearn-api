import { describe, it, expect, beforeAll, afterAll } from "vitest";
import type { FastifyInstance } from "fastify";
import { eq } from "drizzle-orm";
import { buildApp } from "../../src/server.js";
import { db } from "../../src/config/database.js";
import { users, enrollments, courses } from "../../src/database/schema.js";

describe("Admin Users API (#288)", () => {
  let app: FastifyInstance;

  const adminUserId = "c1a2d3e4-1111-4ef8-bb6d-6bb9bd380a99";
  const adminStellarAddress =
    "GADMIN00000000000000000000000000000000000000000000000000";
  const nonAdminUserId = "c1a2d3e4-2222-4ef8-bb6d-6bb9bd380a98";
  const nonAdminStellarAddress =
    "GNONADMIN00000000000000000000000000000000000000000000000";
  // Separate target users for the destructive ban/credit tests, so they
  // don't mutate (and leave side effects on) the shared nonAdminUserId
  // fixture the listing/search tests above also read.
  const banTargetUserId = "c1a2d3e4-3333-4ef8-bb6d-6bb9bd380a97";
  const banTargetStellarAddress =
    "GBANTARGET0000000000000000000000000000000000000000000000";
  const creditTargetUserId = "c1a2d3e4-4444-4ef8-bb6d-6bb9bd380a96";
  const creditTargetStellarAddress =
    "GCREDITTARGET0000000000000000000000000000000000000000000";
  const activityUserId = "c1a2d3e4-5555-4ef8-bb6d-6bb9bd380a95";
  const activityStellarAddress =
    "GACTIVITYUSER0000000000000000000000000000000000000000000";
  const activityCourseId = "c1a2d3e4-6666-4ef8-bb6d-6bb9bd380a94";

  beforeAll(async () => {
    app = await buildApp();
    await app.ready();

    await db
      .insert(users)
      .values({
        id: adminUserId,
        stellarAddress: adminStellarAddress,
        displayName: "Admin User",
        isAdmin: true,
      })
      .onConflictDoNothing();

    await db
      .insert(users)
      .values({
        id: nonAdminUserId,
        stellarAddress: nonAdminStellarAddress,
        displayName: "Regular User",
        isAdmin: false,
      })
      .onConflictDoNothing();

    await db
      .insert(users)
      .values({
        id: banTargetUserId,
        stellarAddress: banTargetStellarAddress,
        displayName: "Ban Target",
        isAdmin: false,
      })
      .onConflictDoNothing();

    await db
      .insert(users)
      .values({
        id: creditTargetUserId,
        stellarAddress: creditTargetStellarAddress,
        displayName: "Credit Target",
        isAdmin: false,
        credits: 100,
      })
      .onConflictDoNothing();

    await db
      .insert(users)
      .values({
        id: activityUserId,
        stellarAddress: activityStellarAddress,
        displayName: "Activity User",
        isAdmin: false,
      })
      .onConflictDoNothing();

    await db
      .insert(courses)
      .values({
        id: activityCourseId,
        title: "Activity Test Course",
        description: "Course fixture for the admin activity feed test",
        difficulty: "beginner",
      })
      .onConflictDoNothing();

    await db
      .insert(enrollments)
      .values({
        userId: activityUserId,
        courseId: activityCourseId,
      })
      .onConflictDoNothing();
  });

  afterAll(async () => {
    await db.delete(enrollments).where(eq(enrollments.userId, activityUserId));
    await db.delete(courses).where(eq(courses.id, activityCourseId));
    await db.delete(users).where(eq(users.id, activityUserId));
    await db.delete(users).where(eq(users.id, creditTargetUserId));
    await db.delete(users).where(eq(users.id, banTargetUserId));
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

  describe("GET /api/v1/admin/users", () => {
    it("should reject unauthenticated requests", async () => {
      const response = await app.inject({
        method: "GET",
        url: "/api/v1/admin/users",
      });

      expect(response.statusCode).toBe(401);
      const body = JSON.parse(response.payload);
      expect(body.error).toBe("UNAUTHORIZED");
    });

    it("should reject non-admin users with 403", async () => {
      const response = await app.inject({
        method: "GET",
        url: "/api/v1/admin/users",
        headers: { authorization: `Bearer ${nonAdminToken()}` },
      });

      expect(response.statusCode).toBe(403);
      const body = JSON.parse(response.payload);
      expect(body.error).toBe("FORBIDDEN");
    });

    it("should return a paginated user list for admins", async () => {
      const response = await app.inject({
        method: "GET",
        url: "/api/v1/admin/users",
        headers: { authorization: `Bearer ${adminToken()}` },
      });

      expect(response.statusCode).toBe(200);
      const body = JSON.parse(response.payload);
      expect(body.success).toBe(true);
      expect(Array.isArray(body.data)).toBe(true);
      expect(body.pagination).toBeDefined();
      expect(typeof body.pagination.page).toBe("number");
      expect(typeof body.pagination.limit).toBe("number");
      expect(typeof body.pagination.total).toBe("number");
    });

    it("should respect page and limit query params", async () => {
      const response = await app.inject({
        method: "GET",
        url: "/api/v1/admin/users?page=1&limit=1",
        headers: { authorization: `Bearer ${adminToken()}` },
      });

      expect(response.statusCode).toBe(200);
      const body = JSON.parse(response.payload);
      expect(body.data.length).toBeLessThanOrEqual(1);
      expect(body.pagination.page).toBe(1);
      expect(body.pagination.limit).toBe(1);
    });

    it("should search by stellar address", async () => {
      const response = await app.inject({
        method: "GET",
        url: `/api/v1/admin/users?search=${adminStellarAddress}`,
        headers: { authorization: `Bearer ${adminToken()}` },
      });

      expect(response.statusCode).toBe(200);
      const body = JSON.parse(response.payload);
      expect(
        body.data.some((u: { stellarAddress: string }) => u.stellarAddress === adminStellarAddress),
      ).toBe(true);
    });

    it("should search by display name", async () => {
      const response = await app.inject({
        method: "GET",
        url: "/api/v1/admin/users?search=Regular User",
        headers: { authorization: `Bearer ${adminToken()}` },
      });

      expect(response.statusCode).toBe(200);
      const body = JSON.parse(response.payload);
      expect(
        body.data.some((u: { id: string }) => u.id === nonAdminUserId),
      ).toBe(true);
    });

    it("should not leak the isAdmin field's absence — each row reports isAdmin explicitly", async () => {
      const response = await app.inject({
        method: "GET",
        url: "/api/v1/admin/users",
        headers: { authorization: `Bearer ${adminToken()}` },
      });

      expect(response.statusCode).toBe(200);
      const body = JSON.parse(response.payload);
      for (const user of body.data) {
        expect(typeof user.isAdmin).toBe("boolean");
      }
    });

    it("should surface deletedAt (null for active accounts) so admins can distinguish deleted users (#290)", async () => {
      const response = await app.inject({
        method: "GET",
        url: "/api/v1/admin/users",
        headers: { authorization: `Bearer ${adminToken()}` },
      });

      expect(response.statusCode).toBe(200);
      const body = JSON.parse(response.payload);
      const admin = body.data.find((u: { id: string }) => u.id === adminUserId);
      expect(admin).toBeDefined();
      expect(admin.deletedAt).toBeNull();
    });

    it("should reject invalid page/limit values", async () => {
      const response = await app.inject({
        method: "GET",
        url: "/api/v1/admin/users?limit=0",
        headers: { authorization: `Bearer ${adminToken()}` },
      });

      expect(response.statusCode).toBe(400);
    });
  });

  describe("POST /api/v1/admin/users/:id/ban (#616)", () => {
    it("should reject unauthenticated requests", async () => {
      const response = await app.inject({
        method: "POST",
        url: `/api/v1/admin/users/${banTargetUserId}/ban`,
        payload: { reason: "Terms of service violation" },
      });

      expect(response.statusCode).toBe(401);
    });

    it("should reject non-admin users with 403", async () => {
      const response = await app.inject({
        method: "POST",
        url: `/api/v1/admin/users/${banTargetUserId}/ban`,
        headers: { authorization: `Bearer ${nonAdminToken()}` },
        payload: { reason: "Terms of service violation" },
      });

      expect(response.statusCode).toBe(403);
    });

    it("should reject a missing reason", async () => {
      const response = await app.inject({
        method: "POST",
        url: `/api/v1/admin/users/${banTargetUserId}/ban`,
        headers: { authorization: `Bearer ${adminToken()}` },
        payload: {},
      });

      expect(response.statusCode).toBe(400);
    });

    it("should 404 for a non-existent user", async () => {
      const response = await app.inject({
        method: "POST",
        url: "/api/v1/admin/users/00000000-0000-0000-0000-000000000000/ban",
        headers: { authorization: `Bearer ${adminToken()}` },
        payload: { reason: "Terms of service violation" },
      });

      expect(response.statusCode).toBe(404);
    });

    it("should ban a user, persist the reason, and reject their subsequent authenticated requests with 403", async () => {
      const response = await app.inject({
        method: "POST",
        url: `/api/v1/admin/users/${banTargetUserId}/ban`,
        headers: { authorization: `Bearer ${adminToken()}` },
        payload: { reason: "Terms of service violation" },
      });

      expect(response.statusCode).toBe(200);
      const body = JSON.parse(response.payload);
      expect(body.success).toBe(true);

      const [banned] = await db
        .select()
        .from(users)
        .where(eq(users.id, banTargetUserId));
      expect(banned?.bannedAt).not.toBeNull();
      expect(banned?.banReason).toBe("Terms of service violation");

      // The banned user's own token must now be rejected (authGuard, #347):
      // a ban takes effect on the next request without needing to revoke
      // the JWT itself.
      const bannedUserToken = app.jwt.sign({
        sub: banTargetUserId,
        stellarAddress: banTargetStellarAddress,
      });
      const selfResponse = await app.inject({
        method: "GET",
        url: "/api/v1/users/me",
        headers: { authorization: `Bearer ${bannedUserToken}` },
      });
      expect(selfResponse.statusCode).toBe(403);
    });

    // Issue #616 asks for ban/unban coverage, but no unban/reinstate
    // entrypoint exists anywhere in the codebase (confirmed by searching
    // the whole repo for "unban" and for any route that clears bannedAt).
    // This test documents that gap explicitly rather than silently
    // omitting it: it will start failing (in a good way) the moment an
    // unban route is added, which is the signal to replace it with real
    // coverage instead of deleting it.
    it("has no unban/reinstate entrypoint yet (tracks the gap in #616's ban/unban scope)", async () => {
      const response = await app.inject({
        method: "POST",
        url: `/api/v1/admin/users/${banTargetUserId}/unban`,
        headers: { authorization: `Bearer ${adminToken()}` },
      });

      expect(response.statusCode).toBe(404);
    });
  });

  describe("POST /api/v1/admin/users/:id/credits/grant and /deduct (#386, #616)", () => {
    it("should reject unauthenticated grant requests", async () => {
      const response = await app.inject({
        method: "POST",
        url: `/api/v1/admin/users/${creditTargetUserId}/credits/grant`,
        payload: { amount: 50, reason: "Promotion" },
      });

      expect(response.statusCode).toBe(401);
    });

    it("should reject non-admin grant requests with 403", async () => {
      const response = await app.inject({
        method: "POST",
        url: `/api/v1/admin/users/${creditTargetUserId}/credits/grant`,
        headers: { authorization: `Bearer ${nonAdminToken()}` },
        payload: { amount: 50, reason: "Promotion" },
      });

      expect(response.statusCode).toBe(403);
    });

    it("should grant credits and return the balance before and after", async () => {
      const response = await app.inject({
        method: "POST",
        url: `/api/v1/admin/users/${creditTargetUserId}/credits/grant`,
        headers: { authorization: `Bearer ${adminToken()}` },
        payload: { amount: 50, reason: "Promotion", reference: "PROMO2026" },
      });

      expect(response.statusCode).toBe(200);
      const body = JSON.parse(response.payload);
      expect(body.success).toBe(true);
      expect(body.data.creditsBefore).toBe(100);
      expect(body.data.creditsAfter).toBe(150);
      expect(body.data.reference).toBe("PROMO2026");

      const [row] = await db
        .select()
        .from(users)
        .where(eq(users.id, creditTargetUserId));
      expect(row?.credits).toBe(150);
    });

    it("should reject a grant with a non-positive amount", async () => {
      const response = await app.inject({
        method: "POST",
        url: `/api/v1/admin/users/${creditTargetUserId}/credits/grant`,
        headers: { authorization: `Bearer ${adminToken()}` },
        payload: { amount: 0, reason: "Promotion" },
      });

      expect(response.statusCode).toBe(400);
    });

    it("should reject a grant with a missing reason", async () => {
      const response = await app.inject({
        method: "POST",
        url: `/api/v1/admin/users/${creditTargetUserId}/credits/grant`,
        headers: { authorization: `Bearer ${adminToken()}` },
        payload: { amount: 10 },
      });

      expect(response.statusCode).toBe(400);
    });

    it("should 404 a grant for a non-existent user", async () => {
      const response = await app.inject({
        method: "POST",
        url: "/api/v1/admin/users/00000000-0000-0000-0000-000000000000/credits/grant",
        headers: { authorization: `Bearer ${adminToken()}` },
        payload: { amount: 10, reason: "Promotion" },
      });

      expect(response.statusCode).toBe(404);
    });

    it("should deduct credits and return the balance before and after", async () => {
      // Balance is 150 after the grant test above (same fixture user,
      // sequential within this file).
      const response = await app.inject({
        method: "POST",
        url: `/api/v1/admin/users/${creditTargetUserId}/credits/deduct`,
        headers: { authorization: `Bearer ${adminToken()}` },
        payload: { amount: 30, reason: "Penalty" },
      });

      expect(response.statusCode).toBe(200);
      const body = JSON.parse(response.payload);
      expect(body.success).toBe(true);
      expect(body.data.creditsBefore).toBe(150);
      expect(body.data.creditsAfter).toBe(120);

      const [row] = await db
        .select()
        .from(users)
        .where(eq(users.id, creditTargetUserId));
      expect(row?.credits).toBe(120);
    });

    it("should reject a deduction that would make the balance negative", async () => {
      const response = await app.inject({
        method: "POST",
        url: `/api/v1/admin/users/${creditTargetUserId}/credits/deduct`,
        headers: { authorization: `Bearer ${adminToken()}` },
        payload: { amount: 999999, reason: "Penalty" },
      });

      expect(response.statusCode).toBe(400);
      const body = JSON.parse(response.payload);
      expect(body.error).toBe("VALIDATION_ERROR");

      // The balance must be unchanged after the rejected deduction.
      const [row] = await db
        .select()
        .from(users)
        .where(eq(users.id, creditTargetUserId));
      expect(row?.credits).toBe(120);
    });
  });

  describe("GET /api/v1/admin/users/:id/activity (#346, #616)", () => {
    it("should reject unauthenticated requests", async () => {
      const response = await app.inject({
        method: "GET",
        url: `/api/v1/admin/users/${activityUserId}/activity`,
      });

      expect(response.statusCode).toBe(401);
    });

    it("should reject non-admin users with 403", async () => {
      const response = await app.inject({
        method: "GET",
        url: `/api/v1/admin/users/${activityUserId}/activity`,
        headers: { authorization: `Bearer ${nonAdminToken()}` },
      });

      expect(response.statusCode).toBe(403);
    });

    it("should 404 for a non-existent user", async () => {
      const response = await app.inject({
        method: "GET",
        url: "/api/v1/admin/users/00000000-0000-0000-0000-000000000000/activity",
        headers: { authorization: `Bearer ${adminToken()}` },
      });

      expect(response.statusCode).toBe(404);
    });

    it("should return the user's enrollment as an activity entry", async () => {
      const response = await app.inject({
        method: "GET",
        url: `/api/v1/admin/users/${activityUserId}/activity`,
        headers: { authorization: `Bearer ${adminToken()}` },
      });

      expect(response.statusCode).toBe(200);
      const body = JSON.parse(response.payload);
      expect(body.success).toBe(true);
      expect(Array.isArray(body.data)).toBe(true);
      const enrollmentActivity = body.data.find(
        (a: { type: string }) => a.type === "enrollment",
      );
      expect(enrollmentActivity).toBeDefined();
      expect(enrollmentActivity.details.courseId).toBe(activityCourseId);
    });
  });
});
