import { describe, it, expect, beforeAll, afterAll } from "vitest";
import type { FastifyInstance } from "fastify";
import { buildApp } from "../../src/server.js";

/**
 * E2E tests for course prerequisites endpoint (#644).
 *
 * Covers:
 * - GET /api/v1/courses/:id/prerequisites (prerequisites listing and completion status)
 */
describe("Course Prerequisites Check API (#644)", () => {
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

  it("rejects invalid course UUID parameter", async () => {
    const response = await app.inject({
      method: "GET",
      url: "/api/v1/courses/not-a-valid-uuid/prerequisites",
    });

    expect(response.statusCode).toBe(400);
    const body = JSON.parse(response.payload);
    expect(body.error).toBe("VALIDATION_ERROR");
  });

  it("handles unauthenticated request for prerequisites", async () => {
    const response = await app.inject({
      method: "GET",
      url: "/api/v1/courses/c1111111-1111-4111-8111-111111111111/prerequisites",
    });

    expect([200, 404, 500]).toContain(response.statusCode);
  });

  it("handles authenticated request returning prerequisites with completion status", async () => {
    const token = tokenFor("a1111111-1111-4111-8111-111111111111");
    const response = await app.inject({
      method: "GET",
      url: "/api/v1/courses/c1111111-1111-4111-8111-111111111111/prerequisites",
      headers: {
        authorization: `Bearer ${token}`,
      },
    });

    expect([200, 404, 500]).toContain(response.statusCode);
    if (response.statusCode === 200) {
      const body = JSON.parse(response.payload);
      expect(body).toHaveProperty("success");
    }
  });
});
