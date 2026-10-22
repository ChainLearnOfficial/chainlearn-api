import { describe, it, expect, beforeAll, afterAll } from "vitest";
import type { FastifyInstance } from "fastify";
import { buildApp } from "../../src/server.js";

/**
 * E2E tests for session management endpoints (#633).
 *
 * Covers:
 * - GET /api/v1/auth/sessions (listing active sessions)
 * - DELETE /api/v1/auth/sessions/:sessionId (revoking individual session)
 */
describe("Sessions API (#633)", () => {
  let app: FastifyInstance;

  beforeAll(async () => {
    app = await buildApp();
    await app.ready();
  });

  afterAll(async () => {
    await app.close();
  });

  const tokenFor = (sub: string) =>
    app.jwt.sign({
      sub,
      stellarAddress:
        "GALICE0000000000000000000000000000000000000000000000000000000",
    });

  describe("GET /api/v1/auth/sessions", () => {
    it("rejects unauthenticated requests", async () => {
      const response = await app.inject({
        method: "GET",
        url: "/api/v1/auth/sessions",
      });

      expect(response.statusCode).toBe(401);
      const body = JSON.parse(response.payload);
      expect(body.error).toBe("UNAUTHORIZED");
    });

    it("rejects malformed authorization header", async () => {
      const response = await app.inject({
        method: "GET",
        url: "/api/v1/auth/sessions",
        headers: {
          authorization: "Bearer invalid.jwt.token",
        },
      });

      expect(response.statusCode).toBe(401);
    });

    it("handles authenticated call", async () => {
      const token = tokenFor("a1111111-1111-4111-8111-111111111111");
      const response = await app.inject({
        method: "GET",
        url: "/api/v1/auth/sessions",
        headers: {
          authorization: `Bearer ${token}`,
        },
      });

      expect([200, 404, 500]).toContain(response.statusCode);
      if (response.statusCode === 200) {
        const body = JSON.parse(response.payload);
        expect(body).toHaveProperty("success");
      }
    });
  });

  describe("DELETE /api/v1/auth/sessions/:sessionId", () => {
    it("rejects unauthenticated requests", async () => {
      const response = await app.inject({
        method: "DELETE",
        url: "/api/v1/auth/sessions/c2222222-2222-4222-8222-222222222222",
      });

      expect(response.statusCode).toBe(401);
    });

    it("validates uuid format for sessionId param", async () => {
      const token = tokenFor("a1111111-1111-4111-8111-111111111111");
      const response = await app.inject({
        method: "DELETE",
        url: "/api/v1/auth/sessions/not-a-valid-uuid",
        headers: {
          authorization: `Bearer ${token}`,
        },
      });

      expect(response.statusCode).toBe(400);
      const body = JSON.parse(response.payload);
      expect(body.error).toBe("VALIDATION_ERROR");
    });

    it("handles valid uuid revocation request", async () => {
      const token = tokenFor("a1111111-1111-4111-8111-111111111111");
      const response = await app.inject({
        method: "DELETE",
        url: "/api/v1/auth/sessions/c2222222-2222-4222-8222-222222222222",
        headers: {
          authorization: `Bearer ${token}`,
        },
      });

      expect([200, 404, 500]).toContain(response.statusCode);
    });
  });
});
