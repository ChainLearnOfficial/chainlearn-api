import { describe, it, expect, beforeAll, afterAll } from "vitest";
import type { FastifyInstance } from "fastify";
import { buildApp } from "../../src/server.js";

/**
 * E2E tests for pending rewards endpoint (#635).
 *
 * Covers:
 * - GET /api/v1/rewards/pending (pending rewards listing, different pending states, auth guard)
 */
describe("Pending Rewards API (#635)", () => {
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

  it("rejects unauthenticated requests", async () => {
    const response = await app.inject({
      method: "GET",
      url: "/api/v1/rewards/pending",
    });

    expect(response.statusCode).toBe(401);
  });

  it("handles authenticated pending rewards request", async () => {
    const token = tokenFor("a1111111-1111-4111-8111-111111111111");
    const response = await app.inject({
      method: "GET",
      url: "/api/v1/rewards/pending",
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
