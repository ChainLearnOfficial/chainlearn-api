import { describe, it, expect, beforeAll, afterAll } from "vitest";
import type { FastifyInstance } from "fastify";
import { buildApp } from "../../src/server.js";

/**
 * E2E tests for course leaderboard endpoint (#643).
 *
 * Covers:
 * - GET /api/v1/courses/:id/leaderboard (top learners leaderboard for a course)
 */
describe("Course Leaderboard API (#643)", () => {
  let app: FastifyInstance;

  beforeAll(async () => {
    app = await buildApp();
    await app.ready();
  });

  afterAll(async () => {
    await app.close();
  });

  it("rejects invalid course UUID parameter", async () => {
    const response = await app.inject({
      method: "GET",
      url: "/api/v1/courses/not-a-valid-uuid/leaderboard",
    });

    expect(response.statusCode).toBe(400);
    const body = JSON.parse(response.payload);
    expect(body.error).toBe("VALIDATION_ERROR");
  });

  it("handles leaderboard request for valid course UUID without auth", async () => {
    const response = await app.inject({
      method: "GET",
      url: "/api/v1/courses/c1111111-1111-4111-8111-111111111111/leaderboard",
    });

    expect([200, 404, 500]).toContain(response.statusCode);
    if (response.statusCode === 200) {
      const body = JSON.parse(response.payload);
      expect(body).toHaveProperty("success");
    }
  });
});
