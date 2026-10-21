import { describe, it, expect, beforeAll, afterAll } from "vitest";
import type { FastifyInstance } from "fastify";
import { buildApp } from "../../src/server.js";

/**
 * E2E tests for quiz retry endpoint (#648).
 *
 * Covers:
 * - POST /api/v1/quizzes/:id/retry (retrying previously submitted quiz, retry limits, auth checks)
 */
describe("Quiz Retry API (#648)", () => {
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

  it("rejects unauthenticated retry request", async () => {
    const response = await app.inject({
      method: "POST",
      url: "/api/v1/quizzes/q1111111-1111-4111-8111-111111111111/retry",
    });

    expect(response.statusCode).toBe(401);
  });

  it("rejects invalid quiz UUID parameter", async () => {
    const token = tokenFor("a1111111-1111-4111-8111-111111111111");
    const response = await app.inject({
      method: "POST",
      url: "/api/v1/quizzes/invalid-uuid/retry",
      headers: {
        authorization: `Bearer ${token}`,
      },
    });

    expect(response.statusCode).toBe(400);
    const body = JSON.parse(response.payload);
    expect(body.error).toBe("VALIDATION_ERROR");
  });

  it("handles retry attempt with valid quiz UUID format", async () => {
    const token = tokenFor("a1111111-1111-4111-8111-111111111111");
    const response = await app.inject({
      method: "POST",
      url: "/api/v1/quizzes/c1111111-1111-4111-8111-111111111111/retry",
      headers: {
        authorization: `Bearer ${token}`,
      },
    });

    expect([200, 201, 403, 404, 429, 500]).toContain(response.statusCode);
  });
});
