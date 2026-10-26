import { describe, it, expect, beforeAll, afterAll } from "vitest";
import type { FastifyInstance } from "fastify";
import { eq } from "drizzle-orm";
import { buildApp } from "../../src/server.js";
import { db } from "../../src/config/database.js";
import { users } from "../../src/database/schema.js";
import { redis } from "../../src/config/redis.js";
import { cacheKey } from "../../src/cache/index.js";

describe("Admin Dashboard API (#367, #618)", () => {
  let app: FastifyInstance;

  const adminUserId = "d1a2d3e4-1111-4ef8-bb6d-6bb9bd380b99";
  const adminStellarAddress =
    "GDASHADMIN0000000000000000000000000000000000000000000000";
  const nonAdminUserId = "d1a2d3e4-2222-4ef8-bb6d-6bb9bd380b98";
  const nonAdminStellarAddress =
    "GDASHNONADMIN000000000000000000000000000000000000000000";

  const dashboardCacheKey = cacheKey("admin", "dashboard-stats");

  beforeAll(async () => {
    app = await buildApp();
    await app.ready();

    await db
      .insert(users)
      .values({
        id: adminUserId,
        stellarAddress: adminStellarAddress,
        displayName: "Dashboard Admin",
        isAdmin: true,
      })
      .onConflictDoNothing();

    await db
      .insert(users)
      .values({
        id: nonAdminUserId,
        stellarAddress: nonAdminStellarAddress,
        displayName: "Dashboard Non-Admin",
        isAdmin: false,
      })
      .onConflictDoNothing();
  });

  afterAll(async () => {
    await db.delete(users).where(eq(users.id, adminUserId));
    await db.delete(users).where(eq(users.id, nonAdminUserId));
    await redis.del(dashboardCacheKey);
    await app.close();
  });

  const adminToken = () =>
    app.jwt.sign({ sub: adminUserId, stellarAddress: adminStellarAddress });

  const nonAdminToken = () =>
    app.jwt.sign({
      sub: nonAdminUserId,
      stellarAddress: nonAdminStellarAddress,
    });

  describe("GET /api/v1/admin/dashboard", () => {
    it("should reject unauthenticated requests", async () => {
      const response = await app.inject({
        method: "GET",
        url: "/api/v1/admin/dashboard",
      });

      expect(response.statusCode).toBe(401);
      const body = JSON.parse(response.payload);
      expect(body.error).toBe("UNAUTHORIZED");
    });

    it("should reject non-admin users with 403", async () => {
      const response = await app.inject({
        method: "GET",
        url: "/api/v1/admin/dashboard",
        headers: { authorization: `Bearer ${nonAdminToken()}` },
      });

      expect(response.statusCode).toBe(403);
      const body = JSON.parse(response.payload);
      expect(body.error).toBe("FORBIDDEN");
    });

    it("should return the full stats shape for admins", async () => {
      await redis.del(dashboardCacheKey);

      const response = await app.inject({
        method: "GET",
        url: "/api/v1/admin/dashboard",
        headers: { authorization: `Bearer ${adminToken()}` },
      });

      expect(response.statusCode).toBe(200);
      const body = JSON.parse(response.payload);
      expect(body.success).toBe(true);

      const stats = body.data;
      expect(typeof stats.totalUsers).toBe("number");
      expect(typeof stats.newUsersToday).toBe("number");
      expect(typeof stats.newUsersThisWeek).toBe("number");
      expect(typeof stats.newUsersThisMonth).toBe("number");
      expect(typeof stats.totalEnrollments).toBe("number");
      expect(typeof stats.quizCompletionRate).toBe("number");
      expect(typeof stats.totalCredentials).toBe("number");
      expect(typeof stats.totalRewardsClaimed).toBe("number");
      expect(typeof stats.generatedAt).toBe("string");

      // The two seed users above must be reflected in the admin-visible
      // total, since the count query filters only on deletedAt.
      expect(stats.totalUsers).toBeGreaterThanOrEqual(2);
    });

    it("should include week-over-week trend metrics with current/previous/changePercent", async () => {
      await redis.del(dashboardCacheKey);

      const response = await app.inject({
        method: "GET",
        url: "/api/v1/admin/dashboard",
        headers: { authorization: `Bearer ${adminToken()}` },
      });

      expect(response.statusCode).toBe(200);
      const { trends } = JSON.parse(response.payload).data;

      for (const metric of [trends.newUsers, trends.enrollments]) {
        expect(typeof metric.current).toBe("number");
        expect(typeof metric.previous).toBe("number");
        expect(
          metric.changePercent === null || typeof metric.changePercent === "number",
        ).toBe(true);
      }
    });

    it("should cache the response in Redis under the documented key", async () => {
      await redis.del(dashboardCacheKey);

      const response = await app.inject({
        method: "GET",
        url: "/api/v1/admin/dashboard",
        headers: { authorization: `Bearer ${adminToken()}` },
      });

      expect(response.statusCode).toBe(200);

      const cached = await redis.get(dashboardCacheKey);
      expect(cached).not.toBeNull();
      const cachedStats = JSON.parse(cached as string);
      expect(cachedStats.generatedAt).toBe(
        JSON.parse(response.payload).data.generatedAt,
      );
    });

    it("should serve the identical cached response on a second request within the TTL, even after new data is written", async () => {
      await redis.del(dashboardCacheKey);

      const first = await app.inject({
        method: "GET",
        url: "/api/v1/admin/dashboard",
        headers: { authorization: `Bearer ${adminToken()}` },
      });
      const firstBody = JSON.parse(first.payload);

      // Write a brand-new user after the first request. If the endpoint
      // were not caching, this would change totalUsers on the next call.
      const extraUserId = "d1a2d3e4-3333-4ef8-bb6d-6bb9bd380b97";
      await db.insert(users).values({
        id: extraUserId,
        stellarAddress:
          "GDASHEXTRAUSER0000000000000000000000000000000000000000",
        displayName: "Extra Dashboard User",
        isAdmin: false,
      });

      try {
        const second = await app.inject({
          method: "GET",
          url: "/api/v1/admin/dashboard",
          headers: { authorization: `Bearer ${adminToken()}` },
        });
        const secondBody = JSON.parse(second.payload);

        expect(secondBody.data.totalUsers).toBe(firstBody.data.totalUsers);
        expect(secondBody.data.generatedAt).toBe(firstBody.data.generatedAt);
      } finally {
        await db.delete(users).where(eq(users.id, extraUserId));
      }
    });

    it("should recompute (and reflect new data) once the cache entry is cleared", async () => {
      await redis.del(dashboardCacheKey);

      const before = await app.inject({
        method: "GET",
        url: "/api/v1/admin/dashboard",
        headers: { authorization: `Bearer ${adminToken()}` },
      });
      const beforeTotal = JSON.parse(before.payload).data.totalUsers;

      const extraUserId = "d1a2d3e4-4444-4ef8-bb6d-6bb9bd380b96";
      await db.insert(users).values({
        id: extraUserId,
        stellarAddress:
          "GDASHEXTRAUSER20000000000000000000000000000000000000000",
        displayName: "Another Extra Dashboard User",
        isAdmin: false,
      });

      try {
        await redis.del(dashboardCacheKey);

        const after = await app.inject({
          method: "GET",
          url: "/api/v1/admin/dashboard",
          headers: { authorization: `Bearer ${adminToken()}` },
        });
        const afterTotal = JSON.parse(after.payload).data.totalUsers;

        expect(afterTotal).toBe(beforeTotal + 1);
      } finally {
        await db.delete(users).where(eq(users.id, extraUserId));
      }
    });
  });
});
