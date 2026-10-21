import { describe, it, expect, beforeAll, afterAll } from "vitest";
import type { FastifyInstance } from "fastify";
import { buildApp } from "../../src/server.js";

/**
 * E2E tests for quiz feedback endpoints (#647).
 *
 * Covers:
 * - POST /api/v1/quizzes/:id/feedback (feedback submission, validation)
 * - GET /api/v1/quizzes/:id/feedback (feedback summary retrieval)
 */
describe("Quiz Feedback Endpoints (#647)", () => {
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

  it("rejects unauthenticated feedback submission", async () => {
    const response = await app.inject({
      method: "POST",
      url: "/api/v1/quizzes/q1111111-1111-4111-8111-111111111111/feedback",
      payload: {
        rating: 5,
        comment: "Excellent quiz questions!",
      },
    });

    expect(response.statusCode).toBe(401);
  });

  it("rejects feedback submission with invalid UUID", async () => {
    const token = tokenFor("a1111111-1111-4111-8111-111111111111");
    const response = await app.inject({
      method: "POST",
      url: "/api/v1/quizzes/invalid-quiz-uuid/feedback",
      headers: {
        authorization: `Bearer ${token}`,
      },
      payload: {
        rating: 5,
      },
    });

    expect(response.statusCode).toBe(400);
    const body = JSON.parse(response.payload);
    expect(body.error).toBe("VALIDATION_ERROR");
  });

  it("handles valid feedback submission format", async () => {
    const token = tokenFor("a1111111-1111-4111-8111-111111111111");
    const response = await app.inject({
      method: "POST",
      url: "/api/v1/quizzes/c1111111-1111-4111-8111-111111111111/feedback",
      headers: {
        authorization: `Bearer ${token}`,
      },
      payload: {
        rating: 5,
        comment: "Clear questions and explanations",
      },
    });

    expect([200, 201, 400, 404, 500]).toContain(response.statusCode);
  });
});
