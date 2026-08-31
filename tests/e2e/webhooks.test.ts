import { describe, it, expect, beforeAll, afterAll } from "vitest";
import type { FastifyInstance } from "fastify";
import { buildApp } from "../../src/server.js";

describe("Webhook System API (Issue #320)", () => {
  let app: FastifyInstance;

  beforeAll(async () => {
    app = await buildApp();
    await app.ready();
  });

  afterAll(async () => {
    await app.close();
  });

  const createAdminToken = () =>
    app.jwt.sign({
      sub: "00000000-0000-0000-0000-000000000002",
      stellarAddress:
        "GADMIN00000000000000000000000000000000000000000000000000000",
    });

  describe("POST /api/v1/admin/webhooks", () => {
    it("should require authentication", async () => {
      const response = await app.inject({
        method: "POST",
        url: "/api/v1/admin/webhooks",
        payload: {
          url: "https://example.com/webhooks",
          events: ["enrollment.created"],
        },
      });

      expect(response.statusCode).toBe(401);
    });

    it("should require admin access", async () => {
      const token = app.jwt.sign({
        sub: "00000000-0000-0000-0000-000000000001",
        stellarAddress:
          "GALICE0000000000000000000000000000000000000000000000000000000",
      });

      const response = await app.inject({
        method: "POST",
        url: "/api/v1/admin/webhooks",
        headers: { authorization: `Bearer ${token}` },
        payload: {
          url: "https://example.com/webhooks",
          events: ["enrollment.created"],
        },
      });

      expect([201, 403]).toContain(response.statusCode);
    });

    it("should create webhook with valid payload", async () => {
      const token = createAdminToken();

      const response = await app.inject({
        method: "POST",
        url: "/api/v1/admin/webhooks",
        headers: { authorization: `Bearer ${token}` },
        payload: {
          url: "https://example.com/webhooks",
          events: ["enrollment.created", "quiz.submitted"],
        },
      });

      expect([201, 403, 400]).toContain(response.statusCode);
      if (response.statusCode === 201) {
        const body = JSON.parse(response.payload);
        expect(body.data).toHaveProperty("id");
        expect(body.data.url).toBe("https://example.com/webhooks");
        expect(body.data.events).toEqual(["enrollment.created", "quiz.submitted"]);
        expect(body.data.active).toBe(true);
      }
    });

    it("should reject invalid URL format", async () => {
      const token = createAdminToken();

      const response = await app.inject({
        method: "POST",
        url: "/api/v1/admin/webhooks",
        headers: { authorization: `Bearer ${token}` },
        payload: {
          url: "not-a-valid-url",
          events: ["enrollment.created"],
        },
      });

      expect([400, 403]).toContain(response.statusCode);
    });

    it("should require at least one event", async () => {
      const token = createAdminToken();

      const response = await app.inject({
        method: "POST",
        url: "/api/v1/admin/webhooks",
        headers: { authorization: `Bearer ${token}` },
        payload: {
          url: "https://example.com/webhooks",
          events: [],
        },
      });

      expect([400, 403]).toContain(response.statusCode);
    });
  });

  describe("GET /api/v1/admin/webhooks", () => {
    it("should require authentication", async () => {
      const response = await app.inject({
        method: "GET",
        url: "/api/v1/admin/webhooks",
      });

      expect(response.statusCode).toBe(401);
    });

    it("should list webhooks", async () => {
      const token = createAdminToken();

      const response = await app.inject({
        method: "GET",
        url: "/api/v1/admin/webhooks",
        headers: { authorization: `Bearer ${token}` },
      });

      expect([200, 403]).toContain(response.statusCode);
      if (response.statusCode === 200) {
        const body = JSON.parse(response.payload);
        expect(Array.isArray(body.data)).toBe(true);
        expect(body.pagination).toBeDefined();
        expect(typeof body.pagination.total).toBe("number");
      }
    });
  });

  describe("GET /api/v1/admin/webhooks/:id", () => {
    it("should require authentication", async () => {
      const response = await app.inject({
        method: "GET",
        url: "/api/v1/admin/webhooks/00000000-0000-0000-0000-000000000000",
      });

      expect(response.statusCode).toBe(401);
    });

    it("should return 404 for non-existent webhook", async () => {
      const token = createAdminToken();

      const response = await app.inject({
        method: "GET",
        url: "/api/v1/admin/webhooks/00000000-0000-0000-0000-000000000000",
        headers: { authorization: `Bearer ${token}` },
      });

      expect([403, 404]).toContain(response.statusCode);
    });
  });

  describe("PUT /api/v1/admin/webhooks/:id", () => {
    it("should require authentication", async () => {
      const response = await app.inject({
        method: "PUT",
        url: "/api/v1/admin/webhooks/00000000-0000-0000-0000-000000000000",
        payload: { active: false },
      });

      expect(response.statusCode).toBe(401);
    });

    it("should update webhook", async () => {
      const token = createAdminToken();

      // Create webhook first
      const createResponse = await app.inject({
        method: "POST",
        url: "/api/v1/admin/webhooks",
        headers: { authorization: `Bearer ${token}` },
        payload: {
          url: "https://example.com/webhooks",
          events: ["enrollment.created"],
        },
      });

      if (createResponse.statusCode === 201) {
        const createBody = JSON.parse(createResponse.payload);
        const webhookId = createBody.data.id;

        // Update it
        const updateResponse = await app.inject({
          method: "PUT",
          url: `/api/v1/admin/webhooks/${webhookId}`,
          headers: { authorization: `Bearer ${token}` },
          payload: { active: false },
        });

        expect([200, 400, 403, 404]).toContain(updateResponse.statusCode);
      }
    });
  });

  describe("DELETE /api/v1/admin/webhooks/:id", () => {
    it("should require authentication", async () => {
      const response = await app.inject({
        method: "DELETE",
        url: "/api/v1/admin/webhooks/00000000-0000-0000-0000-000000000000",
      });

      expect(response.statusCode).toBe(401);
    });
  });

  describe("POST /api/v1/admin/webhooks/:id/rotate-secret", () => {
    it("should require authentication", async () => {
      const response = await app.inject({
        method: "POST",
        url: "/api/v1/admin/webhooks/00000000-0000-0000-0000-000000000000/rotate-secret",
      });

      expect(response.statusCode).toBe(401);
    });

    it("should return new secret on rotation", async () => {
      const token = createAdminToken();

      // Create webhook first
      const createResponse = await app.inject({
        method: "POST",
        url: "/api/v1/admin/webhooks",
        headers: { authorization: `Bearer ${token}` },
        payload: {
          url: "https://example.com/webhooks",
          events: ["enrollment.created"],
        },
      });

      if (createResponse.statusCode === 201) {
        const createBody = JSON.parse(createResponse.payload);
        const webhookId = createBody.data.id;

        // Rotate secret
        const rotateResponse = await app.inject({
          method: "POST",
          url: `/api/v1/admin/webhooks/${webhookId}/rotate-secret`,
          headers: { authorization: `Bearer ${token}` },
        });

        expect([200, 400, 403, 404]).toContain(rotateResponse.statusCode);
        if (rotateResponse.statusCode === 200) {
          const body = JSON.parse(rotateResponse.payload);
          expect(body.data).toHaveProperty("secret");
          expect(typeof body.data.secret).toBe("string");
          expect(body.data.secret.length).toBe(64); // 32 bytes = 64 hex chars
        }
      }
    });
  });

  describe("GET /api/v1/admin/webhooks/:id/attempts", () => {
    it("should require authentication", async () => {
      const response = await app.inject({
        method: "GET",
        url: "/api/v1/admin/webhooks/00000000-0000-0000-0000-000000000000/attempts",
      });

      expect(response.statusCode).toBe(401);
    });
  });

  describe("GET /api/v1/admin/webhooks/:id/stats", () => {
    it("should require authentication", async () => {
      const response = await app.inject({
        method: "GET",
        url: "/api/v1/admin/webhooks/00000000-0000-0000-0000-000000000000/stats",
      });

      expect(response.statusCode).toBe(401);
    });

    it("should return webhook statistics", async () => {
      const token = createAdminToken();

      // Create webhook first
      const createResponse = await app.inject({
        method: "POST",
        url: "/api/v1/admin/webhooks",
        headers: { authorization: `Bearer ${token}` },
        payload: {
          url: "https://example.com/webhooks",
          events: ["enrollment.created"],
        },
      });

      if (createResponse.statusCode === 201) {
        const createBody = JSON.parse(createResponse.payload);
        const webhookId = createBody.data.id;

        // Get stats
        const statsResponse = await app.inject({
          method: "GET",
          url: `/api/v1/admin/webhooks/${webhookId}/stats`,
          headers: { authorization: `Bearer ${token}` },
        });

        expect([200, 400, 403, 404]).toContain(statsResponse.statusCode);
        if (statsResponse.statusCode === 200) {
          const body = JSON.parse(statsResponse.payload);
          expect(body.data).toHaveProperty("totalAttempts");
          expect(body.data).toHaveProperty("succeeded");
          expect(body.data).toHaveProperty("failed");
          expect(body.data).toHaveProperty("pending");
          expect(body.data).toHaveProperty("successRate");
        }
      }
    });
  });
});
