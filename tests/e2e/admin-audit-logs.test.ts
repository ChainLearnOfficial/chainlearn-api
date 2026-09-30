import { describe, it, expect, beforeAll, afterAll } from "vitest";
import type { FastifyInstance } from "fastify";
import { eq } from "drizzle-orm";
import { buildApp } from "../../src/server.js";
import { db } from "../../src/config/database.js";
import { users, auditLogs } from "../../src/database/schema.js";

describe("Admin Audit Logs API (#289)", () => {
  let app: FastifyInstance;

  const adminUserId = "d1a2d3e4-1111-4ef8-bb6d-6bb9bd380a77";
  const adminStellarAddress =
    "GAUDITADMIN0000000000000000000000000000000000000000000000".slice(0, 56);
  const nonAdminUserId = "d1a2d3e4-2222-4ef8-bb6d-6bb9bd380a76";
  const nonAdminStellarAddress =
    "GAUDITNONADMIN000000000000000000000000000000000000000000".slice(0, 56);

  const testEvent = "auth.login_failed" as const;
  const insertedIds: string[] = [];

  beforeAll(async () => {
    app = await buildApp();
    await app.ready();

    await db
      .insert(users)
      .values({
        id: adminUserId,
        stellarAddress: adminStellarAddress,
        displayName: "Audit Admin",
        isAdmin: true,
      })
      .onConflictDoNothing();

    await db
      .insert(users)
      .values({
        id: nonAdminUserId,
        stellarAddress: nonAdminStellarAddress,
        displayName: "Audit Non-Admin",
        isAdmin: false,
      })
      .onConflictDoNothing();

    const rows = await db
      .insert(auditLogs)
      .values([
        { event: testEvent, fields: { note: "admin-audit-log-test-1" } },
        { event: testEvent, fields: { note: "admin-audit-log-test-2" } },
        {
          event: "auth.login",
          fields: { note: "admin-audit-log-test-other-event" },
        },
      ])
      .returning();
    insertedIds.push(...rows.map((r) => r.id));
  });

  afterAll(async () => {
    for (const id of insertedIds) {
      await db.delete(auditLogs).where(eq(auditLogs.id, id));
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

  describe("GET /api/v1/admin/audit-logs", () => {
    it("should reject unauthenticated requests", async () => {
      const response = await app.inject({
        method: "GET",
        url: "/api/v1/admin/audit-logs",
      });

      expect(response.statusCode).toBe(401);
    });

    it("should reject non-admin users with 403", async () => {
      const response = await app.inject({
        method: "GET",
        url: "/api/v1/admin/audit-logs",
        headers: { authorization: `Bearer ${nonAdminToken()}` },
      });

      expect(response.statusCode).toBe(403);
      const body = JSON.parse(response.payload);
      expect(body.error).toBe("FORBIDDEN");
    });

    it("should return a paginated audit log list for admins", async () => {
      const response = await app.inject({
        method: "GET",
        url: "/api/v1/admin/audit-logs",
        headers: { authorization: `Bearer ${adminToken()}` },
      });

      expect(response.statusCode).toBe(200);
      const body = JSON.parse(response.payload);
      expect(body.success).toBe(true);
      expect(Array.isArray(body.data)).toBe(true);
      expect(body.pagination).toBeDefined();
      expect(typeof body.pagination.limit).toBe("number");
      expect(typeof body.pagination.offset).toBe("number");
      expect(typeof body.pagination.total).toBe("number");
    });

    it("should filter by exact event match", async () => {
      const response = await app.inject({
        method: "GET",
        url: `/api/v1/admin/audit-logs?event=${testEvent}`,
        headers: { authorization: `Bearer ${adminToken()}` },
      });

      expect(response.statusCode).toBe(200);
      const body = JSON.parse(response.payload);
      expect(body.data.length).toBeGreaterThanOrEqual(2);
      for (const log of body.data) {
        expect(log.event).toBe(testEvent);
      }
    });

    it("should respect limit and offset", async () => {
      const response = await app.inject({
        method: "GET",
        url: `/api/v1/admin/audit-logs?event=${testEvent}&limit=1&offset=0`,
        headers: { authorization: `Bearer ${adminToken()}` },
      });

      expect(response.statusCode).toBe(200);
      const body = JSON.parse(response.payload);
      expect(body.data.length).toBe(1);
      expect(body.pagination.limit).toBe(1);
      expect(body.pagination.offset).toBe(0);
      expect(body.pagination.total).toBeGreaterThanOrEqual(2);
    });

    it("should filter by dateFrom/dateTo range", async () => {
      const farFuture = new Date(Date.now() + 1000 * 60 * 60 * 24 * 365).toISOString();
      const response = await app.inject({
        method: "GET",
        url: `/api/v1/admin/audit-logs?dateFrom=${encodeURIComponent(farFuture)}`,
        headers: { authorization: `Bearer ${adminToken()}` },
      });

      expect(response.statusCode).toBe(200);
      const body = JSON.parse(response.payload);
      expect(body.data.length).toBe(0);
    });

    it("should reject invalid dateFrom format", async () => {
      const response = await app.inject({
        method: "GET",
        url: "/api/v1/admin/audit-logs?dateFrom=not-a-date",
        headers: { authorization: `Bearer ${adminToken()}` },
      });

      expect(response.statusCode).toBe(400);
    });
  });
});
