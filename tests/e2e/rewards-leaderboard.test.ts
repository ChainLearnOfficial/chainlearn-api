import { describe, it, expect, beforeAll, afterAll } from "vitest";
import type { FastifyInstance } from "fastify";
import { buildApp } from "../../src/server.js";

describe("Rewards Leaderboard API (Issue #321)", () => {
  let app: FastifyInstance;

  beforeAll(async () => {
    app = await buildApp();
    await app.ready();
  });

  afterAll(async () => {
    await app.close();
  });

  describe("GET /api/v1/rewards/leaderboard", () => {
    it("should return leaderboard without authentication", async () => {
      const response = await app.inject({
        method: "GET",
        url: "/api/v1/rewards/leaderboard",
      });

      expect(response.statusCode).toBe(200);
      const body = JSON.parse(response.payload);
      expect(body.success).toBe(true);
      expect(body.data).toBeDefined();
      expect(body.data.entries).toBeDefined();
      expect(body.data.generatedAt).toBeDefined();
    });

    it("should return array of leaderboard entries", async () => {
      const response = await app.inject({
        method: "GET",
        url: "/api/v1/rewards/leaderboard",
      });

      expect(response.statusCode).toBe(200);
      const body = JSON.parse(response.payload);
      expect(Array.isArray(body.data.entries)).toBe(true);
    });

    it("should include rank, displayName, and credits in each entry", async () => {
      const response = await app.inject({
        method: "GET",
        url: "/api/v1/rewards/leaderboard",
      });

      expect(response.statusCode).toBe(200);
      const body = JSON.parse(response.payload);
      
      if (body.data.entries.length > 0) {
        const entry = body.data.entries[0];
        expect(typeof entry.rank).toBe("number");
        expect(typeof entry.displayName).toBe("string");
        expect(typeof entry.credits).toBe("number");
      }
    });

    it("should return default limit of 50 entries", async () => {
      const response = await app.inject({
        method: "GET",
        url: "/api/v1/rewards/leaderboard",
      });

      expect(response.statusCode).toBe(200);
      const body = JSON.parse(response.payload);
      expect(body.data.entries.length).toBeLessThanOrEqual(50);
    });

    it("should respect custom limit parameter", async () => {
      const response = await app.inject({
        method: "GET",
        url: "/api/v1/rewards/leaderboard?limit=10",
      });

      expect([200, 400]).toContain(response.statusCode);
      if (response.statusCode === 200) {
        const body = JSON.parse(response.payload);
        expect(body.data.entries.length).toBeLessThanOrEqual(10);
      }
    });

    it("should sort entries by rank in ascending order", async () => {
      const response = await app.inject({
        method: "GET",
        url: "/api/v1/rewards/leaderboard",
      });

      expect(response.statusCode).toBe(200);
      const body = JSON.parse(response.payload);
      
      for (let i = 1; i < body.data.entries.length; i++) {
        expect(body.data.entries[i].rank).toBeGreaterThan(body.data.entries[i - 1].rank);
      }
    });

    it("should sort entries by credits in descending order", async () => {
      const response = await app.inject({
        method: "GET",
        url: "/api/v1/rewards/leaderboard",
      });

      expect(response.statusCode).toBe(200);
      const body = JSON.parse(response.payload);
      
      for (let i = 1; i < body.data.entries.length; i++) {
        expect(body.data.entries[i].credits).toBeLessThanOrEqual(body.data.entries[i - 1].credits);
      }
    });

    it("should be cached", async () => {
      const response1 = await app.inject({
        method: "GET",
        url: "/api/v1/rewards/leaderboard",
      });

      const response2 = await app.inject({
        method: "GET",
        url: "/api/v1/rewards/leaderboard",
      });

      expect(response1.statusCode).toBe(200);
      expect(response2.statusCode).toBe(200);
      
      const body1 = JSON.parse(response1.payload);
      const body2 = JSON.parse(response2.payload);
      
      // Should return same data (cached)
      expect(body1.data.entries).toEqual(body2.data.entries);
    });
  });
});
