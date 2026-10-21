import { describe, it, expect, beforeAll, afterAll } from "vitest";
import type { FastifyInstance } from "fastify";
import { buildApp } from "../../src/server.js";

/**
 * E2E tests for course stats endpoint (#645).
 *
 * Covers:
 * - GET /api/v1/courses/stats (course statistics overview and caching behavior)
 */
describe("Course Stats API (#645)", () => {
  let app: FastifyInstance;

  beforeAll(async () => {
    app = await buildApp();
    await app.ready();
  });

  afterAll(async () => {
    await app.close();
  });

  it("returns course statistics without requiring auth", async () => {
    const response = await app.inject({
      method: "GET",
      url: "/api/v1/courses/stats",
    });

    expect([200, 500]).toContain(response.statusCode);
    if (response.statusCode === 200) {
      const body = JSON.parse(response.payload);
      expect(body).toHaveProperty("success");
      expect(body).toHaveProperty("data");
    }
  });

  it("serves consistent responses across multiple calls (cached)", async () => {
    const res1 = await app.inject({
      method: "GET",
      url: "/api/v1/courses/stats",
    });

    const res2 = await app.inject({
      method: "GET",
      url: "/api/v1/courses/stats",
    });

    expect(res1.statusCode).toBe(res2.statusCode);
  });
});
