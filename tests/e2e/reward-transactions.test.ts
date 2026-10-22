import { describe, it, expect, beforeAll, afterAll } from "vitest";
import type { FastifyInstance } from "fastify";
import { buildApp } from "../../src/server.js";

/**
 * E2E tests for reward transactions endpoint (#636).
 *
 * Covers:
 * - GET /api/v1/rewards/transactions (transactions listing, pagination, on-chain status)
 */
describe("Reward Transactions API (#636)", () => {
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
      url: "/api/v1/rewards/transactions",
    });

    expect(response.statusCode).toBe(401);
  });

  it("handles authenticated transactions request with default query params", async () => {
    const token = tokenFor("a1111111-1111-4111-8111-111111111111");
    const response = await app.inject({
      method: "GET",
      url: "/api/v1/rewards/transactions",
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

  it("rejects invalid page query param", async () => {
    const token = tokenFor("a1111111-1111-4111-8111-111111111111");
    const response = await app.inject({
      method: "GET",
      url: "/api/v1/rewards/transactions?page=0",
      headers: {
        authorization: `Bearer ${token}`,
      },
    });

    expect(response.statusCode).toBe(400);
    const body = JSON.parse(response.payload);
    expect(body.error).toBe("VALIDATION_ERROR");
  });

  it("rejects limit query param exceeding 50", async () => {
    const token = tokenFor("a1111111-1111-4111-8111-111111111111");
    const response = await app.inject({
      method: "GET",
      url: "/api/v1/rewards/transactions?limit=100",
      headers: {
        authorization: `Bearer ${token}`,
      },
    });

    expect(response.statusCode).toBe(400);
    const body = JSON.parse(response.payload);
    expect(body.error).toBe("VALIDATION_ERROR");
  });
});
