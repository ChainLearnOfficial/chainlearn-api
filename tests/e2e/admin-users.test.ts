import { describe, it, expect, beforeAll, afterAll } from "vitest";
import type { FastifyInstance } from "fastify";
import { eq } from "drizzle-orm";
import { buildApp } from "../../src/server.js";
import { db } from "../../src/config/database.js";
import { users } from "../../src/database/schema.js";

describe("Admin Users API (#288)", () => {
  let app: FastifyInstance;

  const adminUserId = "c1a2d3e4-1111-4ef8-bb6d-6bb9bd380a99";
  const adminStellarAddress =
    "GADMIN00000000000000000000000000000000000000000000000000";
  const nonAdminUserId = "c1a2d3e4-2222-4ef8-bb6d-6bb9bd380a98";
  const nonAdminStellarAddress =
    "GNONADMIN00000000000000000000000000000000000000000000000";

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
  });

  afterAll(async () => {
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

    it("should reject invalid page/limit values", async () => {
      const response = await app.inject({
        method: "GET",
        url: "/api/v1/admin/users?limit=0",
        headers: { authorization: `Bearer ${adminToken()}` },
      });

      expect(response.statusCode).toBe(400);
    });
  });
});
