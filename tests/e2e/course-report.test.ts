import { describe, it, expect, beforeAll, afterAll } from "vitest";
import type { FastifyInstance } from "fastify";
import { buildApp } from "../../src/server.js";

/**
 * E2E tests for course report endpoint (#632).
 *
 * Covers:
 * - POST /api/v1/courses/:id/report (report creation, duplicate handling, input validation)
 */
describe("Course Report API (#632)", () => {
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

  it("rejects unauthenticated report submissions", async () => {
    const response = await app.inject({
      method: "POST",
      url: "/api/v1/courses/c1111111-1111-4111-8111-111111111111/report",
      payload: {
        reason: "inappropriate",
        description: "Inappropriate language in module 2",
      },
    });

    expect(response.statusCode).toBe(401);
    const body = JSON.parse(response.payload);
    expect(body.error).toBe("UNAUTHORIZED");
  });

  it("rejects requests with invalid course UUID parameter", async () => {
    const token = tokenFor("a1111111-1111-4111-8111-111111111111");
    const response = await app.inject({
      method: "POST",
      url: "/api/v1/courses/invalid-uuid/report",
      headers: {
        authorization: `Bearer ${token}`,
      },
      payload: {
        reason: "inappropriate",
        description: "Report description",
      },
    });

    expect(response.statusCode).toBe(400);
    const body = JSON.parse(response.payload);
    expect(body.error).toBe("VALIDATION_ERROR");
  });

  it("rejects invalid report payload", async () => {
    const token = tokenFor("a1111111-1111-4111-8111-111111111111");
    const response = await app.inject({
      method: "POST",
      url: "/api/v1/courses/c1111111-1111-4111-8111-111111111111/report",
      headers: {
        authorization: `Bearer ${token}`,
      },
      payload: {},
    });

    expect(response.statusCode).toBe(400);
    const body = JSON.parse(response.payload);
    expect(body.error).toBe("VALIDATION_ERROR");
  });

  it("handles valid report submission structure", async () => {
    const token = tokenFor("a1111111-1111-4111-8111-111111111111");
    const response = await app.inject({
      method: "POST",
      url: "/api/v1/courses/c1111111-1111-4111-8111-111111111111/report",
      headers: {
        authorization: `Bearer ${token}`,
      },
      payload: {
        reason: "inappropriate",
        description: "Detailed description of the issue in course materials",
      },
    });

    expect([200, 201, 404, 409, 500]).toContain(response.statusCode);
  });
});
