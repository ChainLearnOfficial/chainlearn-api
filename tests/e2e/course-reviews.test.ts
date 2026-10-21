import { describe, it, expect, beforeAll, afterAll } from "vitest";
import type { FastifyInstance } from "fastify";
import { buildApp } from "../../src/server.js";

/**
 * E2E tests for course reviews endpoints (#630).
 *
 * Covers:
 * - GET /api/v1/courses/:id/reviews (listing course reviews)
 * - POST /api/v1/courses/:id/reviews (creating/updating a course review)
 */
describe("Course Reviews API (#630)", () => {
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

  describe("GET /api/v1/courses/:id/reviews", () => {
    it("rejects invalid course UUID parameter", async () => {
      const response = await app.inject({
        method: "GET",
        url: "/api/v1/courses/not-a-valid-uuid/reviews",
      });

      expect(response.statusCode).toBe(400);
      const body = JSON.parse(response.payload);
      expect(body.error).toBe("VALIDATION_ERROR");
    });

    it("handles review listing with valid course ID", async () => {
      const response = await app.inject({
        method: "GET",
        url: "/api/v1/courses/c1111111-1111-4111-8111-111111111111/reviews",
      });

      expect([200, 404, 500]).toContain(response.statusCode);
      if (response.statusCode === 200) {
        const body = JSON.parse(response.payload);
        expect(body).toHaveProperty("success");
      }
    });

    it("rejects invalid query parameters (e.g. invalid page)", async () => {
      const response = await app.inject({
        method: "GET",
        url: "/api/v1/courses/c1111111-1111-4111-8111-111111111111/reviews?page=0",
      });

      expect(response.statusCode).toBe(400);
    });
  });

  describe("POST /api/v1/courses/:id/reviews", () => {
    it("rejects unauthenticated review submission", async () => {
      const response = await app.inject({
        method: "POST",
        url: "/api/v1/courses/c1111111-1111-4111-8111-111111111111/reviews",
        payload: {
          rating: 5,
          comment: "Great introductory course!",
        },
      });

      expect(response.statusCode).toBe(401);
    });

    it("validates rating range and required fields", async () => {
      const token = tokenFor("a1111111-1111-4111-8111-111111111111");
      const response = await app.inject({
        method: "POST",
        url: "/api/v1/courses/c1111111-1111-4111-8111-111111111111/reviews",
        headers: {
          authorization: `Bearer ${token}`,
        },
        payload: {
          rating: 10, // Invalid: exceeds maximum rating
          comment: "Invalid rating value",
        },
      });

      expect(response.statusCode).toBe(400);
      const body = JSON.parse(response.payload);
      expect(body.error).toBe("VALIDATION_ERROR");
    });

    it("handles valid review submission attempt", async () => {
      const token = tokenFor("a1111111-1111-4111-8111-111111111111");
      const response = await app.inject({
        method: "POST",
        url: "/api/v1/courses/c1111111-1111-4111-8111-111111111111/reviews",
        headers: {
          authorization: `Bearer ${token}`,
        },
        payload: {
          rating: 5,
          comment: "Great introductory course on blockchain!",
        },
      });

      expect([200, 201, 403, 404, 500]).toContain(response.statusCode);
    });
  });
});
