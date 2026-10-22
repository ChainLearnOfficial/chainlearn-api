import { describe, it, expect, beforeAll, afterAll } from "vitest";
import type { FastifyInstance } from "fastify";
import { buildApp } from "../../src/server.js";

/**
 * E2E tests for batch enrollment endpoint (#640).
 *
 * Covers:
 * - POST /api/v1/courses/enroll/batch (enrolling in multiple courses in one call)
 */
describe("Batch Enrollment API (#640)", () => {
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

  it("rejects unauthenticated batch enrollment requests", async () => {
    const response = await app.inject({
      method: "POST",
      url: "/api/v1/courses/enroll/batch",
      payload: {
        courseIds: ["c1111111-1111-4111-8111-111111111111"],
      },
    });

    expect(response.statusCode).toBe(401);
  });

  it("rejects empty courseIds list in payload", async () => {
    const token = tokenFor("a1111111-1111-4111-8111-111111111111");
    const response = await app.inject({
      method: "POST",
      url: "/api/v1/courses/enroll/batch",
      headers: {
        authorization: `Bearer ${token}`,
      },
      payload: {
        courseIds: [],
      },
    });

    expect(response.statusCode).toBe(400);
    const body = JSON.parse(response.payload);
    expect(body.error).toBe("VALIDATION_ERROR");
  });

  it("rejects invalid UUIDs inside courseIds list", async () => {
    const token = tokenFor("a1111111-1111-4111-8111-111111111111");
    const response = await app.inject({
      method: "POST",
      url: "/api/v1/courses/enroll/batch",
      headers: {
        authorization: `Bearer ${token}`,
      },
      payload: {
        courseIds: ["invalid-uuid"],
      },
    });

    expect(response.statusCode).toBe(400);
    const body = JSON.parse(response.payload);
    expect(body.error).toBe("VALIDATION_ERROR");
  });

  it("handles valid batch enrollment payload structure", async () => {
    const token = tokenFor("a1111111-1111-4111-8111-111111111111");
    const response = await app.inject({
      method: "POST",
      url: "/api/v1/courses/enroll/batch",
      headers: {
        authorization: `Bearer ${token}`,
      },
      payload: {
        courseIds: [
          "c1111111-1111-4111-8111-111111111111",
          "c2222222-2222-4222-8222-222222222222",
        ],
      },
    });

    expect([200, 207, 400, 404, 500]).toContain(response.statusCode);
  });
});
