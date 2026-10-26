import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import type { FastifyInstance } from "fastify";
import { eq } from "drizzle-orm";
import { buildApp } from "../../src/server.js";
import { db } from "../../src/config/database.js";
import { users, webhooks, webhookAttempts } from "../../src/database/schema.js";

describe("Admin Webhook Management API (#615)", () => {
  let app: FastifyInstance;

  const adminUserId = "f1a2d3e4-1111-4ef8-bb6d-6bb9bd380d99";
  const adminStellarAddress =
    "GWEBHOOKADMIN0000000000000000000000000000000000000000000";
  const nonAdminUserId = "f1a2d3e4-2222-4ef8-bb6d-6bb9bd380d98";
  const nonAdminStellarAddress =
    "GWEBHOOKNONADMIN0000000000000000000000000000000000000000";

  beforeAll(async () => {
    app = await buildApp();
    await app.ready();

    await db
      .insert(users)
      .values({
        id: adminUserId,
        stellarAddress: adminStellarAddress,
        displayName: "Webhook Admin",
        isAdmin: true,
      })
      .onConflictDoNothing();

    await db
      .insert(users)
      .values({
        id: nonAdminUserId,
        stellarAddress: nonAdminStellarAddress,
        displayName: "Webhook Non-Admin",
        isAdmin: false,
      })
      .onConflictDoNothing();
  });

  afterAll(async () => {
    await db.delete(users).where(eq(users.id, adminUserId));
    await db.delete(users).where(eq(users.id, nonAdminUserId));
    await app.close();
  });

  // Every webhook this file creates is cleared before each test (cascades
  // to webhookAttempts via onDelete: "cascade"), so list/pagination/stats
  // assertions never see leftovers from a previous test.
  beforeEach(async () => {
    await db.delete(webhooks);
  });

  const adminToken = () =>
    app.jwt.sign({ sub: adminUserId, stellarAddress: adminStellarAddress });

  const nonAdminToken = () =>
    app.jwt.sign({
      sub: nonAdminUserId,
      stellarAddress: nonAdminStellarAddress,
    });

  async function createWebhookDirect(
    overrides: Partial<{ url: string; events: string[]; active: boolean }> = {},
  ): Promise<string> {
    const [row] = await db
      .insert(webhooks)
      .values({
        url: overrides.url ?? "https://example.com/webhook",
        events: overrides.events ?? ["enrollment.created"],
        secret: "test-secret-0000000000000000000000000000000000000000000000",
        active: overrides.active ?? true,
      })
      .returning({ id: webhooks.id });
    return row.id;
  }

  describe("POST /api/v1/admin/webhooks", () => {
    it("should reject unauthenticated requests", async () => {
      const response = await app.inject({
        method: "POST",
        url: "/api/v1/admin/webhooks",
        payload: { url: "https://example.com/webhook", events: ["enrollment.created"] },
      });

      // Regression (#615): webhook.routes.ts previously registered only
      // adminGuard on this router, never authGuard. adminGuard reads
      // request.authUser.isAdmin directly, and only authGuard sets
      // authUser, so EVERY request here (admin or not, authenticated or
      // not) 500'd with "Cannot read properties of undefined (reading
      // 'isAdmin')" instead of the admin-users/dashboard routers' clean
      // 401/403. Fixed by adding the missing authGuard onRequest hook.
      expect(response.statusCode).toBe(401);
    });

    it("should reject non-admin users with 403", async () => {
      const response = await app.inject({
        method: "POST",
        url: "/api/v1/admin/webhooks",
        headers: { authorization: `Bearer ${nonAdminToken()}` },
        payload: { url: "https://example.com/webhook", events: ["enrollment.created"] },
      });

      expect(response.statusCode).toBe(403);
    });

    it("should create a webhook and never return the secret in the response", async () => {
      const response = await app.inject({
        method: "POST",
        url: "/api/v1/admin/webhooks",
        headers: { authorization: `Bearer ${adminToken()}` },
        payload: {
          url: "https://example.com/webhook",
          events: ["enrollment.created", "quiz.passed"],
        },
      });

      expect(response.statusCode).toBe(201);
      const body = JSON.parse(response.payload);
      expect(body.success).toBe(true);
      expect(body.data.url).toBe("https://example.com/webhook");
      expect(body.data.events).toEqual(["enrollment.created", "quiz.passed"]);
      expect(body.data.active).toBe(true);
      expect(body.data.secret).toBeUndefined();

      const [row] = await db
        .select()
        .from(webhooks)
        .where(eq(webhooks.id, body.data.id));
      expect(row?.secret).toBeDefined();
      expect(row?.secret.length).toBeGreaterThan(0);
    });

    it("should reject a webhook with no events", async () => {
      const response = await app.inject({
        method: "POST",
        url: "/api/v1/admin/webhooks",
        headers: { authorization: `Bearer ${adminToken()}` },
        payload: { url: "https://example.com/webhook", events: [] },
      });

      expect(response.statusCode).toBe(400);
    });

    it("should reject an invalid URL", async () => {
      const response = await app.inject({
        method: "POST",
        url: "/api/v1/admin/webhooks",
        headers: { authorization: `Bearer ${adminToken()}` },
        payload: { url: "not-a-url", events: ["enrollment.created"] },
      });

      expect(response.statusCode).toBe(400);
    });

    it("should reject a webhook targeting a loopback/private address (SSRF guard, #487)", async () => {
      const response = await app.inject({
        method: "POST",
        url: "/api/v1/admin/webhooks",
        headers: { authorization: `Bearer ${adminToken()}` },
        payload: { url: "http://localhost:3000/webhook", events: ["enrollment.created"] },
      });

      expect(response.statusCode).toBe(400);
    });
  });

  describe("GET /api/v1/admin/webhooks", () => {
    it("should reject non-admin users with 403", async () => {
      const response = await app.inject({
        method: "GET",
        url: "/api/v1/admin/webhooks",
        headers: { authorization: `Bearer ${nonAdminToken()}` },
      });

      expect(response.statusCode).toBe(403);
    });

    it("should list webhooks, newest first, with pagination", async () => {
      await createWebhookDirect({ url: "https://example.com/first" });
      await createWebhookDirect({ url: "https://example.com/second" });

      const response = await app.inject({
        method: "GET",
        url: "/api/v1/admin/webhooks",
        headers: { authorization: `Bearer ${adminToken()}` },
      });

      expect(response.statusCode).toBe(200);
      const body = JSON.parse(response.payload);
      expect(body.success).toBe(true);
      expect(body.data).toHaveLength(2);
      expect(body.pagination.total).toBe(2);
      // No secret anywhere in the listing either.
      for (const webhook of body.data) {
        expect(webhook.secret).toBeUndefined();
      }
    });

    it("should respect page and limit query params", async () => {
      await createWebhookDirect({ url: "https://example.com/a" });
      await createWebhookDirect({ url: "https://example.com/b" });
      await createWebhookDirect({ url: "https://example.com/c" });

      const response = await app.inject({
        method: "GET",
        url: "/api/v1/admin/webhooks?page=2&limit=2",
        headers: { authorization: `Bearer ${adminToken()}` },
      });

      expect(response.statusCode).toBe(200);
      const body = JSON.parse(response.payload);
      expect(body.data).toHaveLength(1);
      expect(body.pagination.page).toBe(2);
      expect(body.pagination.limit).toBe(2);
    });
  });

  describe("GET /api/v1/admin/webhooks/:id", () => {
    it("should get a single webhook", async () => {
      const id = await createWebhookDirect({ url: "https://example.com/single" });

      const response = await app.inject({
        method: "GET",
        url: `/api/v1/admin/webhooks/${id}`,
        headers: { authorization: `Bearer ${adminToken()}` },
      });

      expect(response.statusCode).toBe(200);
      const body = JSON.parse(response.payload);
      expect(body.data.id).toBe(id);
      expect(body.data.url).toBe("https://example.com/single");
    });

    it("should 404 for a non-existent webhook", async () => {
      const response = await app.inject({
        method: "GET",
        url: "/api/v1/admin/webhooks/00000000-0000-0000-0000-000000000000",
        headers: { authorization: `Bearer ${adminToken()}` },
      });

      expect(response.statusCode).toBe(404);
    });

    it("should reject a malformed webhook id", async () => {
      const response = await app.inject({
        method: "GET",
        url: "/api/v1/admin/webhooks/not-a-uuid",
        headers: { authorization: `Bearer ${adminToken()}` },
      });

      expect(response.statusCode).toBe(400);
    });
  });

  describe("PUT /api/v1/admin/webhooks/:id (CRUD: update)", () => {
    it("should update the url, events, and active flag independently", async () => {
      const id = await createWebhookDirect({
        url: "https://example.com/original",
        events: ["enrollment.created"],
        active: true,
      });

      const response = await app.inject({
        method: "PUT",
        url: `/api/v1/admin/webhooks/${id}`,
        headers: { authorization: `Bearer ${adminToken()}` },
        payload: { active: false },
      });

      expect(response.statusCode).toBe(200);
      const body = JSON.parse(response.payload);
      expect(body.data.active).toBe(false);
      // Fields not included in the PUT body must be left untouched.
      expect(body.data.url).toBe("https://example.com/original");
      expect(body.data.events).toEqual(["enrollment.created"]);
    });

    it("should update the url and events together", async () => {
      const id = await createWebhookDirect({ url: "https://example.com/original" });

      const response = await app.inject({
        method: "PUT",
        url: `/api/v1/admin/webhooks/${id}`,
        headers: { authorization: `Bearer ${adminToken()}` },
        payload: {
          url: "https://example.com/updated",
          events: ["quiz.passed", "credential.minted"],
        },
      });

      expect(response.statusCode).toBe(200);
      const body = JSON.parse(response.payload);
      expect(body.data.url).toBe("https://example.com/updated");
      expect(body.data.events).toEqual(["quiz.passed", "credential.minted"]);
    });

    it("should 404 when updating a non-existent webhook", async () => {
      const response = await app.inject({
        method: "PUT",
        url: "/api/v1/admin/webhooks/00000000-0000-0000-0000-000000000000",
        headers: { authorization: `Bearer ${adminToken()}` },
        payload: { active: false },
      });

      expect(response.statusCode).toBe(404);
    });

    it("should reject an update with an invalid URL", async () => {
      const id = await createWebhookDirect();

      const response = await app.inject({
        method: "PUT",
        url: `/api/v1/admin/webhooks/${id}`,
        headers: { authorization: `Bearer ${adminToken()}` },
        payload: { url: "not-a-url" },
      });

      expect(response.statusCode).toBe(400);
    });
  });

  describe("DELETE /api/v1/admin/webhooks/:id (CRUD: delete)", () => {
    it("should delete a webhook", async () => {
      const id = await createWebhookDirect();

      const response = await app.inject({
        method: "DELETE",
        url: `/api/v1/admin/webhooks/${id}`,
        headers: { authorization: `Bearer ${adminToken()}` },
      });

      expect(response.statusCode).toBe(200);
      const body = JSON.parse(response.payload);
      expect(body.success).toBe(true);

      const [row] = await db.select().from(webhooks).where(eq(webhooks.id, id));
      expect(row).toBeUndefined();
    });

    it("should 404 when deleting a non-existent webhook", async () => {
      const response = await app.inject({
        method: "DELETE",
        url: "/api/v1/admin/webhooks/00000000-0000-0000-0000-000000000000",
        headers: { authorization: `Bearer ${adminToken()}` },
      });

      expect(response.statusCode).toBe(404);
    });
  });

  describe("POST /api/v1/admin/webhooks/:id/rotate-secret", () => {
    it("should reject non-admin users with 403", async () => {
      const id = await createWebhookDirect();

      const response = await app.inject({
        method: "POST",
        url: `/api/v1/admin/webhooks/${id}/rotate-secret`,
        headers: { authorization: `Bearer ${nonAdminToken()}` },
      });

      expect(response.statusCode).toBe(403);
    });

    it("should rotate the secret and return the new value exactly once", async () => {
      const id = await createWebhookDirect();
      const [before] = await db.select().from(webhooks).where(eq(webhooks.id, id));

      const response = await app.inject({
        method: "POST",
        url: `/api/v1/admin/webhooks/${id}/rotate-secret`,
        headers: { authorization: `Bearer ${adminToken()}` },
      });

      expect(response.statusCode).toBe(200);
      const body = JSON.parse(response.payload);
      expect(body.success).toBe(true);
      expect(typeof body.data.secret).toBe("string");
      expect(body.data.secret.length).toBeGreaterThan(0);
      expect(body.data.secret).not.toBe(before?.secret);

      const [after] = await db.select().from(webhooks).where(eq(webhooks.id, id));
      expect(after?.secret).toBe(body.data.secret);

      // A follow-up GET on the webhook must never leak the (new) secret.
      const getResponse = await app.inject({
        method: "GET",
        url: `/api/v1/admin/webhooks/${id}`,
        headers: { authorization: `Bearer ${adminToken()}` },
      });
      expect(JSON.parse(getResponse.payload).data.secret).toBeUndefined();
    });

    it("should produce a different secret on each successive rotation", async () => {
      const id = await createWebhookDirect();

      const first = await app.inject({
        method: "POST",
        url: `/api/v1/admin/webhooks/${id}/rotate-secret`,
        headers: { authorization: `Bearer ${adminToken()}` },
      });
      const second = await app.inject({
        method: "POST",
        url: `/api/v1/admin/webhooks/${id}/rotate-secret`,
        headers: { authorization: `Bearer ${adminToken()}` },
      });

      expect(JSON.parse(first.payload).data.secret).not.toBe(
        JSON.parse(second.payload).data.secret,
      );
    });

    it("should 404 when rotating the secret of a non-existent webhook", async () => {
      const response = await app.inject({
        method: "POST",
        url: "/api/v1/admin/webhooks/00000000-0000-0000-0000-000000000000/rotate-secret",
        headers: { authorization: `Bearer ${adminToken()}` },
      });

      expect(response.statusCode).toBe(404);
    });
  });

  describe("GET /api/v1/admin/webhooks/:id/attempts", () => {
    it("should 404 for a non-existent webhook", async () => {
      const response = await app.inject({
        method: "GET",
        url: "/api/v1/admin/webhooks/00000000-0000-0000-0000-000000000000/attempts",
        headers: { authorization: `Bearer ${adminToken()}` },
      });

      expect(response.statusCode).toBe(404);
    });

    it("should list attempts for a webhook, newest first", async () => {
      const id = await createWebhookDirect();
      await db.insert(webhookAttempts).values({
        webhookId: id,
        event: "enrollment.created",
        payload: { foo: "bar" },
        statusCode: 200,
        succeededAt: new Date(),
      });
      await new Promise((resolve) => setTimeout(resolve, 10));
      const [secondAttempt] = await db
        .insert(webhookAttempts)
        .values({
          webhookId: id,
          event: "quiz.passed",
          payload: { foo: "baz" },
          statusCode: 500,
          errorMessage: "Connection refused",
          failedAt: new Date(),
        })
        .returning({ id: webhookAttempts.id });

      const response = await app.inject({
        method: "GET",
        url: `/api/v1/admin/webhooks/${id}/attempts`,
        headers: { authorization: `Bearer ${adminToken()}` },
      });

      expect(response.statusCode).toBe(200);
      const body = JSON.parse(response.payload);
      expect(body.data).toHaveLength(2);
      expect(body.data[0].id).toBe(secondAttempt.id);
      expect(body.data[0].statusCode).toBe(500);
      expect(body.data[0].errorMessage).toBe("Connection refused");
      expect(body.pagination.total).toBe(2);
    });

    it("should only return attempts for the requested webhook, not another one's", async () => {
      const id1 = await createWebhookDirect({ url: "https://example.com/one" });
      const id2 = await createWebhookDirect({ url: "https://example.com/two" });
      await db.insert(webhookAttempts).values({
        webhookId: id1,
        event: "enrollment.created",
        payload: {},
        statusCode: 200,
        succeededAt: new Date(),
      });
      await db.insert(webhookAttempts).values({
        webhookId: id2,
        event: "enrollment.created",
        payload: {},
        statusCode: 200,
        succeededAt: new Date(),
      });

      const response = await app.inject({
        method: "GET",
        url: `/api/v1/admin/webhooks/${id1}/attempts`,
        headers: { authorization: `Bearer ${adminToken()}` },
      });

      const body = JSON.parse(response.payload);
      expect(body.data).toHaveLength(1);
      expect(body.data[0].webhookId).toBe(id1);
    });

    it("should support cursor-based pagination via nextCursor (#482)", async () => {
      const id = await createWebhookDirect();
      for (let i = 0; i < 3; i++) {
        await db.insert(webhookAttempts).values({
          webhookId: id,
          event: "enrollment.created",
          payload: { i },
          statusCode: 200,
          succeededAt: new Date(),
        });
        await new Promise((resolve) => setTimeout(resolve, 5));
      }

      const firstPage = await app.inject({
        method: "GET",
        url: `/api/v1/admin/webhooks/${id}/attempts?limit=2`,
        headers: { authorization: `Bearer ${adminToken()}` },
      });
      const firstBody = JSON.parse(firstPage.payload);
      expect(firstBody.data).toHaveLength(2);
      expect(firstBody.pagination.nextCursor).not.toBeNull();

      const secondPage = await app.inject({
        method: "GET",
        url: `/api/v1/admin/webhooks/${id}/attempts?limit=2&cursor=${firstBody.pagination.nextCursor}`,
        headers: { authorization: `Bearer ${adminToken()}` },
      });
      const secondBody = JSON.parse(secondPage.payload);
      expect(secondBody.data).toHaveLength(1);
      expect(secondBody.pagination.nextCursor).toBeNull();

      // No overlap between the two pages.
      const firstIds = firstBody.data.map((a: { id: string }) => a.id);
      const secondIds = secondBody.data.map((a: { id: string }) => a.id);
      expect(firstIds.some((id: string) => secondIds.includes(id))).toBe(false);
    });
  });

  describe("GET /api/v1/admin/webhooks/:id/stats", () => {
    it("should 404 for a non-existent webhook", async () => {
      const response = await app.inject({
        method: "GET",
        url: "/api/v1/admin/webhooks/00000000-0000-0000-0000-000000000000/stats",
        headers: { authorization: `Bearer ${adminToken()}` },
      });

      expect(response.statusCode).toBe(404);
    });

    it("should return zeroed stats for a webhook with no attempts", async () => {
      const id = await createWebhookDirect();

      const response = await app.inject({
        method: "GET",
        url: `/api/v1/admin/webhooks/${id}/stats`,
        headers: { authorization: `Bearer ${adminToken()}` },
      });

      expect(response.statusCode).toBe(200);
      const body = JSON.parse(response.payload);
      expect(body.data).toEqual({
        webhookId: id,
        totalAttempts: 0,
        succeeded: 0,
        failed: 0,
        pending: 0,
        successRate: 0,
      });
    });

    it("should compute succeeded/failed/pending counts and successRate correctly", async () => {
      const id = await createWebhookDirect();
      // 2 succeeded, 1 failed, 1 pending (neither succeededAt nor failedAt set).
      await db.insert(webhookAttempts).values([
        {
          webhookId: id,
          event: "enrollment.created",
          payload: {},
          statusCode: 200,
          succeededAt: new Date(),
        },
        {
          webhookId: id,
          event: "quiz.passed",
          payload: {},
          statusCode: 200,
          succeededAt: new Date(),
        },
        {
          webhookId: id,
          event: "quiz.failed",
          payload: {},
          statusCode: 500,
          failedAt: new Date(),
        },
        {
          webhookId: id,
          event: "credential.minted",
          payload: {},
        },
      ]);

      const response = await app.inject({
        method: "GET",
        url: `/api/v1/admin/webhooks/${id}/stats`,
        headers: { authorization: `Bearer ${adminToken()}` },
      });

      expect(response.statusCode).toBe(200);
      const body = JSON.parse(response.payload);
      expect(body.data.totalAttempts).toBe(4);
      expect(body.data.succeeded).toBe(2);
      expect(body.data.failed).toBe(1);
      expect(body.data.pending).toBe(1);
      expect(body.data.successRate).toBe(50);
    });
  });
});
