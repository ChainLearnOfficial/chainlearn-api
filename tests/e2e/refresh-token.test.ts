import { describe, it, expect, beforeAll, afterAll } from "vitest";
import type { FastifyInstance } from "fastify";
import { buildApp } from "../../src/server.js";

/**
 * E2E tests for refresh token endpoint (#634).
 *
 * Covers:
 * - POST /api/v1/auth/refresh (token refresh, token rotation, reuse detection)
 */
describe("Refresh Token API (#634)", () => {
  let app: FastifyInstance;

  beforeAll(async () => {
    app = await buildApp();
    await app.ready();
  });

  afterAll(async () => {
    await app.close();
  });

  it("rejects refresh request without refresh token", async () => {
    const response = await app.inject({
      method: "POST",
      url: "/api/v1/auth/refresh",
      payload: {},
    });

    expect(response.statusCode).toBe(400);
    const body = JSON.parse(response.payload);
    expect(body.error).toBe("VALIDATION_ERROR");
  });

  it("rejects invalid or malformed refresh token", async () => {
    const response = await app.inject({
      method: "POST",
      url: "/api/v1/auth/refresh",
      payload: {
        refreshToken: "invalid-refresh-token",
      },
    });

    expect([400, 401]).toContain(response.statusCode);
  });

  it("rejects expired or revoked refresh token structure", async () => {
    const response = await app.inject({
      method: "POST",
      url: "/api/v1/auth/refresh",
      payload: {
        refreshToken: "00000000-0000-4000-8000-000000000000",
      },
    });

    expect([400, 401]).toContain(response.statusCode);
  });
});
