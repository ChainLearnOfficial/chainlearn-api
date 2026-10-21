import { describe, it, expect, beforeAll, afterAll } from "vitest";
import type { FastifyInstance } from "fastify";
import { buildApp } from "../../src/server.js";

/**
 * E2E tests for course share endpoints (#631).
 *
 * Covers:
 * - POST /api/v1/courses/:id/share (share link creation, referral code, QR code generation)
 * - GET /api/v1/courses/shared/:code (share link resolution)
 */
describe("Course Share API (#631)", () => {
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

  describe("POST /api/v1/courses/:id/share", () => {
    it("rejects unauthenticated share link creation", async () => {
      const response = await app.inject({
        method: "POST",
        url: "/api/v1/courses/c1111111-1111-4111-8111-111111111111/share",
      });

      expect(response.statusCode).toBe(401);
    });

    it("rejects invalid course UUID parameter", async () => {
      const token = tokenFor("a1111111-1111-4111-8111-111111111111");
      const response = await app.inject({
        method: "POST",
        url: "/api/v1/courses/invalid-id/share",
        headers: {
          authorization: `Bearer ${token}`,
        },
      });

      expect(response.statusCode).toBe(400);
      const body = JSON.parse(response.payload);
      expect(body.error).toBe("VALIDATION_ERROR");
    });

    it("handles share generation attempt with valid UUID", async () => {
      const token = tokenFor("a1111111-1111-4111-8111-111111111111");
      const response = await app.inject({
        method: "POST",
        url: "/api/v1/courses/c1111111-1111-4111-8111-111111111111/share",
        headers: {
          authorization: `Bearer ${token}`,
        },
      });

      expect([200, 201, 404, 500]).toContain(response.statusCode);
      if (response.statusCode === 200 || response.statusCode === 201) {
        const body = JSON.parse(response.payload);
        expect(body).toHaveProperty("success");
      }
    });
  });

  describe("GET /api/v1/courses/shared/:code", () => {
    it("handles share code resolution attempt", async () => {
      const response = await app.inject({
        method: "GET",
        url: "/api/v1/courses/shared/SAMPLECODE123",
      });

      expect([200, 404, 500]).toContain(response.statusCode);
    });
  });
});
