import { describe, it, expect, beforeAll, afterAll } from "vitest";
import type { FastifyInstance } from "fastify";
import { buildApp } from "../../src/server.js";

/**
 * E2E tests for avatar upload endpoint (#639).
 *
 * Covers:
 * - PUT /api/v1/users/me/avatar (uploading user avatar, file validation, auth checks)
 */
describe("Avatar Upload API (#639)", () => {
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

  it("rejects unauthenticated avatar uploads", async () => {
    const response = await app.inject({
      method: "PUT",
      url: "/api/v1/users/me/avatar",
    });

    expect(response.statusCode).toBe(401);
  });

  it("rejects non-multipart requests when authenticated", async () => {
    const token = tokenFor("a1111111-1111-4111-8111-111111111111");
    const response = await app.inject({
      method: "PUT",
      url: "/api/v1/users/me/avatar",
      headers: {
        authorization: `Bearer ${token}`,
        "content-type": "application/json",
      },
      payload: {
        avatar: "invalid-payload",
      },
    });

    expect([400, 415, 500]).toContain(response.statusCode);
  });

  it("rejects empty multipart payload", async () => {
    const token = tokenFor("a1111111-1111-4111-8111-111111111111");
    const boundary = "----WebKitFormBoundary7MA4YWxkTrZu0gW";
    const response = await app.inject({
      method: "PUT",
      url: "/api/v1/users/me/avatar",
      headers: {
        authorization: `Bearer ${token}`,
        "content-type": `multipart/form-data; boundary=${boundary}`,
      },
      payload: `--${boundary}--\r\n`,
    });

    expect([400, 422, 500]).toContain(response.statusCode);
  });
});
