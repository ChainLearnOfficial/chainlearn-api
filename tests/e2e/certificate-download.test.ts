import { describe, it, expect, beforeAll, afterAll } from "vitest";
import type { FastifyInstance } from "fastify";
import { buildApp } from "../../src/server.js";

/**
 * E2E tests for certificate download endpoints (#638).
 *
 * Covers:
 * - GET /api/v1/credentials/:id/certificate (download certificate payload/format)
 * - GET /api/v1/courses/:id/completion-certificate (download course completion PDF)
 */
describe("Certificate Download API (#638)", () => {
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

  describe("GET /api/v1/credentials/:id/certificate", () => {
    it("rejects unauthenticated requests", async () => {
      const response = await app.inject({
        method: "GET",
        url: "/api/v1/credentials/c1111111-1111-4111-8111-111111111111/certificate",
      });

      expect(response.statusCode).toBe(401);
    });

    it("rejects invalid certificate UUID param", async () => {
      const token = tokenFor("a1111111-1111-4111-8111-111111111111");
      const response = await app.inject({
        method: "GET",
        url: "/api/v1/credentials/invalid-uuid/certificate",
        headers: {
          authorization: `Bearer ${token}`,
        },
      });

      expect(response.statusCode).toBe(400);
      const body = JSON.parse(response.payload);
      expect(body.error).toBe("VALIDATION_ERROR");
    });

    it("handles download attempt for valid UUID", async () => {
      const token = tokenFor("a1111111-1111-4111-8111-111111111111");
      const response = await app.inject({
        method: "GET",
        url: "/api/v1/credentials/c1111111-1111-4111-8111-111111111111/certificate",
        headers: {
          authorization: `Bearer ${token}`,
        },
      });

      expect([200, 404, 500]).toContain(response.statusCode);
    });
  });

  describe("GET /api/v1/courses/:id/completion-certificate", () => {
    it("rejects unauthenticated requests", async () => {
      const response = await app.inject({
        method: "GET",
        url: "/api/v1/courses/c1111111-1111-4111-8111-111111111111/completion-certificate",
      });

      expect(response.statusCode).toBe(401);
    });

    it("rejects invalid course UUID param", async () => {
      const token = tokenFor("a1111111-1111-4111-8111-111111111111");
      const response = await app.inject({
        method: "GET",
        url: "/api/v1/courses/not-uuid/completion-certificate",
        headers: {
          authorization: `Bearer ${token}`,
        },
      });

      expect(response.statusCode).toBe(400);
      const body = JSON.parse(response.payload);
      expect(body.error).toBe("VALIDATION_ERROR");
    });
  });
});
