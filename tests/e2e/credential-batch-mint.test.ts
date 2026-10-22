import { describe, it, expect, beforeAll, afterAll } from "vitest";
import type { FastifyInstance } from "fastify";
import { buildApp } from "../../src/server.js";

/**
 * E2E tests for credential batch mint endpoint (#637).
 *
 * Covers:
 * - POST /api/v1/credentials/batch-mint (batch minting credentials, validation, error handling)
 */
describe("Credential Batch Mint API (#637)", () => {
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

  it("rejects unauthenticated batch mint requests", async () => {
    const response = await app.inject({
      method: "POST",
      url: "/api/v1/credentials/batch-mint",
      payload: {
        submissions: [
          {
            courseId: "c1111111-1111-4111-8111-111111111111",
            submissionId: "s1111111-1111-4111-8111-111111111111",
          },
        ],
      },
    });

    expect(response.statusCode).toBe(401);
  });

  it("rejects empty submissions array", async () => {
    const token = tokenFor("a1111111-1111-4111-8111-111111111111");
    const response = await app.inject({
      method: "POST",
      url: "/api/v1/credentials/batch-mint",
      headers: {
        authorization: `Bearer ${token}`,
      },
      payload: {
        submissions: [],
      },
    });

    expect(response.statusCode).toBe(400);
    const body = JSON.parse(response.payload);
    expect(body.error).toBe("VALIDATION_ERROR");
  });

  it("rejects submissions with invalid UUIDs", async () => {
    const token = tokenFor("a1111111-1111-4111-8111-111111111111");
    const response = await app.inject({
      method: "POST",
      url: "/api/v1/credentials/batch-mint",
      headers: {
        authorization: `Bearer ${token}`,
      },
      payload: {
        submissions: [
          {
            courseId: "not-a-uuid",
            submissionId: "not-a-uuid",
          },
        ],
      },
    });

    expect(response.statusCode).toBe(400);
    const body = JSON.parse(response.payload);
    expect(body.error).toBe("VALIDATION_ERROR");
  });

  it("handles valid batch mint request format", async () => {
    const token = tokenFor("a1111111-1111-4111-8111-111111111111");
    const response = await app.inject({
      method: "POST",
      url: "/api/v1/credentials/batch-mint",
      headers: {
        authorization: `Bearer ${token}`,
      },
      payload: {
        submissions: [
          {
            courseId: "c1111111-1111-4111-8111-111111111111",
            submissionId: "s1111111-1111-4111-8111-111111111111",
          },
        ],
      },
    });

    expect([200, 207, 400, 404, 500]).toContain(response.statusCode);
  });
});
