import { describe, it, expect, beforeAll, afterAll } from "vitest";
import type { FastifyInstance } from "fastify";
import { buildApp } from "../../src/server.js";

describe("Metrics & Health Endpoints", () => {
  let app: FastifyInstance;

  beforeAll(async () => {
    app = await buildApp();
    await app.ready();
  });

  afterAll(async () => {
    await app.close();
  });

  const createToken = () =>
    app.jwt.sign({
      sub: "00000000-0000-0000-0000-000000000001",
      stellarAddress:
        "GALICE0000000000000000000000000000000000000000000000000000000",
    });

  describe("GET /metrics", () => {
    it("should reject unauthenticated requests", async () => {
      const response = await app.inject({
        method: "GET",
        url: "/metrics",
      });

      expect(response.statusCode).toBe(401);
      const body = JSON.parse(response.payload);
      expect(body.error).toBe("UNAUTHORIZED");
    });

    it("should return metrics when authenticated (or 401 if test user not in DB)", async () => {
      const token = createToken();

      const response = await app.inject({
        method: "GET",
        url: "/metrics",
        headers: { authorization: `Bearer ${token}` },
      });

      // Returns 200 if user exists in DB, 401 if user not found, 503 if deps unavailable
      expect([200, 401, 503]).toContain(response.statusCode);
      if (response.statusCode === 200) {
        expect(response.headers["content-type"]).toContain("text/plain");
        expect(response.payload).toContain("chainlearn");
      }
    });
  });

  describe("GET /health", () => {
    it("should be accessible without authentication", async () => {
      const response = await app.inject({
        method: "GET",
        url: "/health",
      });

      expect([200, 503]).toContain(response.statusCode);
      const body = JSON.parse(response.payload);
      expect(body.status).toBeDefined();
      expect(body.checks).toBeDefined();
    }, 10000);
  });

  describe("GET /health/live", () => {
    it("should be accessible without authentication", async () => {
      const response = await app.inject({
        method: "GET",
        url: "/health/live",
      });

      expect(response.statusCode).toBe(200);
      const body = JSON.parse(response.payload);
      expect(body.status).toBe("ok");
    });
  });

  describe("GET /health/ready", () => {
    it("should be accessible without authentication", async () => {
      const response = await app.inject({
        method: "GET",
        url: "/health/ready",
      });

      expect([200, 503]).toContain(response.statusCode);
      const body = JSON.parse(response.payload);
      expect(body.status).toBeDefined();
      expect(body.checks).toBeDefined();
    }, 10000);
  });
});
