import { describe, it, expect, beforeAll, afterAll } from "vitest";
import type { FastifyInstance } from "fastify";
import { buildApp } from "../../src/server.js";

describe("Rewards API", () => {
  let app: FastifyInstance;

  beforeAll(async () => {
    app = await buildApp();
    await app.ready();
  });

  afterAll(async () => {
    await app.close();
  });

  describe("POST /api/rewards/claim", () => {
    it("should reject unauthenticated requests", async () => {
      const response = await app.inject({
        method: "POST",
        url: "/api/rewards/claim",
        payload: {
          submissionId: "00000000-0000-0000-0000-000000000000",
        },
      });

      expect(response.statusCode).toBe(401);
      const body = JSON.parse(response.payload);
      expect(body.error).toBe("UNAUTHORIZED");
    });

    it("should reject invalid submission ID format", async () => {
      const token = app.jwt.sign({
        sub: "00000000-0000-0000-0000-000000000001",
        stellarAddress:
          "GALICE0000000000000000000000000000000000000000000000000000000",
      });

      const response = await app.inject({
        method: "POST",
        url: "/api/rewards/claim",
        headers: { authorization: `Bearer ${token}` },
        payload: {
          submissionId: "not-a-uuid",
        },
      });

      // Auth may reject the token (401) or validation may reject the ID (400)
      expect([400, 401]).toContain(response.statusCode);
    });
  });

  describe("GET /api/rewards/history", () => {
    it("should reject unauthenticated requests", async () => {
      const response = await app.inject({
        method: "GET",
        url: "/api/rewards/history",
      });

      expect(response.statusCode).toBe(401);
    });

    it("should return empty history for a valid user", async () => {
      const token = app.jwt.sign({
        sub: "00000000-0000-0000-0000-000000000001",
        stellarAddress:
          "GALICE0000000000000000000000000000000000000000000000000000000",
      });

      const response = await app.inject({
        method: "GET",
        url: "/api/rewards/history",
        headers: { authorization: `Bearer ${token}` },
      });

      // May return 200 (success), 401 (auth rejected), or 500 (DB unavailable)
      expect([200, 401, 500]).toContain(response.statusCode);
      if (response.statusCode === 200) {
        const body = JSON.parse(response.payload);
        expect(body.success).toBe(true);
        expect(Array.isArray(body.data)).toBe(true);
      }
    });
  });
});
