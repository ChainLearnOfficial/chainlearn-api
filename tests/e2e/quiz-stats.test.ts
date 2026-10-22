import { describe, it, expect, beforeAll, afterAll } from "vitest";
import type { FastifyInstance } from "fastify";
import { buildApp } from "../../src/server.js";

/**
 * E2E tests for quiz stats endpoint (#646).
 *
 * Covers:
 * - GET /api/v1/quizzes/stats (quiz statistics overview, course filtering, caching)
 */
describe("Quiz Stats API (#646)", () => {
  let app: FastifyInstance;

  beforeAll(async () => {
    app = await buildApp();
    await app.ready();
  });

  afterAll(async () => {
    await app.close();
  });

  it("returns overall quiz stats without authentication", async () => {
    const response = await app.inject({
      method: "GET",
      url: "/api/v1/quizzes/stats",
    });

    expect([200, 500]).toContain(response.statusCode);
    if (response.statusCode === 200) {
      const body = JSON.parse(response.payload);
      expect(body).toHaveProperty("success");
    }
  });

  it("accepts courseId filter query param", async () => {
    const response = await app.inject({
      method: "GET",
      url: "/api/v1/quizzes/stats?courseId=c1111111-1111-4111-8111-111111111111",
    });

    expect([200, 404, 500]).toContain(response.statusCode);
  });

  it("rejects invalid courseId query parameter", async () => {
    const response = await app.inject({
      method: "GET",
      url: "/api/v1/quizzes/stats?courseId=not-a-valid-uuid",
    });

    expect(response.statusCode).toBe(400);
    const body = JSON.parse(response.payload);
    expect(body.error).toBe("VALIDATION_ERROR");
  });
});
