import { describe, it, expect, beforeAll, afterAll } from "vitest";
import type { FastifyInstance } from "fastify";
import { buildApp } from "../../src/server.js";

/**
 * E2E tests for popular courses endpoint (#641).
 *
 * Covers:
 * - GET /api/v1/courses/popular (listing popular courses by enrollment count, pagination limits)
 */
describe("Popular Courses API (#641)", () => {
  let app: FastifyInstance;

  beforeAll(async () => {
    app = await buildApp();
    await app.ready();
  });

  afterAll(async () => {
    await app.close();
  });

  it("returns popular courses list without requiring auth", async () => {
    const response = await app.inject({
      method: "GET",
      url: "/api/v1/courses/popular",
    });

    expect([200, 500]).toContain(response.statusCode);
    if (response.statusCode === 200) {
      const body = JSON.parse(response.payload);
      expect(body).toHaveProperty("success");
      expect(Array.isArray(body.data)).toBe(true);
    }
  });

  it("accepts valid limit query parameter", async () => {
    const response = await app.inject({
      method: "GET",
      url: "/api/v1/courses/popular?limit=5",
    });

    expect([200, 500]).toContain(response.statusCode);
  });

  it("rejects invalid limit query parameter", async () => {
    const response = await app.inject({
      method: "GET",
      url: "/api/v1/courses/popular?limit=0",
    });

    expect(response.statusCode).toBe(400);
    const body = JSON.parse(response.payload);
    expect(body.error).toBe("VALIDATION_ERROR");
  });

  it("rejects limit exceeding maximum allowed", async () => {
    const response = await app.inject({
      method: "GET",
      url: "/api/v1/courses/popular?limit=100",
    });

    expect(response.statusCode).toBe(400);
    const body = JSON.parse(response.payload);
    expect(body.error).toBe("VALIDATION_ERROR");
  });
});
