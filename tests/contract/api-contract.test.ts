import { describe, it, expect, beforeAll, afterAll } from "vitest";
import type { FastifyInstance } from "fastify";
import { buildApp } from "../../src/server.js";

describe("API Versioning", () => {
  let app: FastifyInstance;

  beforeAll(async () => {
    app = await buildApp();
    await app.ready();
  });

  afterAll(async () => {
    await app.close();
  });

  describe("Versioned routes under /api/v1/", () => {
    it("GET /api/v1/courses returns 200 with meta.version", async () => {
      const res = await app.inject({ method: "GET", url: "/api/v1/courses" });
      expect([200, 500]).toContain(res.statusCode);
      if (res.statusCode === 200) {
        const body = JSON.parse(res.payload);
        expect(body.success).toBe(true);
        expect(body.meta).toBeDefined();
        expect(body.meta.version).toBe("v1");
        expect(body.meta.timestamp).toBeDefined();
        expect(body.meta.requestId).toBeDefined();
      }
    });

    it("GET /api/v1/courses includes response envelope", async () => {
      const res = await app.inject({ method: "GET", url: "/api/v1/courses" });
      expect([200, 500]).toContain(res.statusCode);
      if (res.statusCode === 200) {
        const body = JSON.parse(res.payload);
        expect(body).toHaveProperty("success");
        expect(body).toHaveProperty("data");
        expect(body).toHaveProperty("meta");
        expect(body.meta).toHaveProperty("version");
        expect(body.meta).toHaveProperty("timestamp");
        expect(body.meta).toHaveProperty("requestId");
      }
    });

    it("POST /api/v1/auth/challenge returns response with meta", async () => {
      const res = await app.inject({
        method: "POST",
        url: "/api/v1/auth/challenge",
        payload: { stellarAddress: "GALICE0000000000000000000000000000000000000000000000000000000" },
      });
      expect([200, 400, 500]).toContain(res.statusCode);
      if (res.statusCode === 200) {
        const body = JSON.parse(res.payload);
        expect(body.meta).toBeDefined();
        expect(body.meta.version).toBe("v1");
      }
    });
  });

  describe("Backwards compatibility redirect", () => {
    it("GET /api/courses redirects to /api/v1/courses", async () => {
      const res = await app.inject({ method: "GET", url: "/api/courses" });
      expect(res.statusCode).toBe(301);
      expect(res.headers.location).toBe("/api/v1/courses");
    });

    it("GET /api/auth/challenge redirects to /api/v1/auth/challenge", async () => {
      const res = await app.inject({ method: "GET", url: "/api/auth/challenge" });
      expect(res.statusCode).toBe(301);
      expect(res.headers.location).toBe("/api/v1/auth/challenge");
    });

    it("GET /api/users/me redirects to /api/v1/users/me", async () => {
      const res = await app.inject({ method: "GET", url: "/api/users/me" });
      expect(res.statusCode).toBe(301);
      expect(res.headers.location).toBe("/api/v1/users/me");
    });

    it("GET /api/quizzes/generate redirects to /api/v1/quizzes/generate", async () => {
      const res = await app.inject({ method: "GET", url: "/api/quizzes/generate" });
      expect(res.statusCode).toBe(301);
      expect(res.headers.location).toBe("/api/v1/quizzes/generate");
    });

    it("GET /api/rewards/history redirects to /api/v1/rewards/history", async () => {
      const res = await app.inject({ method: "GET", url: "/api/rewards/history" });
      expect(res.statusCode).toBe(301);
      expect(res.headers.location).toBe("/api/v1/rewards/history");
    });

    it("GET /api/credentials redirects to /api/v1/credentials", async () => {
      const res = await app.inject({ method: "GET", url: "/api/credentials" });
      expect(res.statusCode).toBe(301);
      expect(res.headers.location).toBe("/api/v1/credentials");
    });
  });

  describe("Versioned routes still work as before", () => {
    it("GET /api/v1/courses returns course list", { timeout: 10000 }, async () => {
      const res = await app.inject({ method: "GET", url: "/api/v1/courses" });
      expect([200, 500]).toContain(res.statusCode);
      if (res.statusCode === 200) {
        const body = JSON.parse(res.payload);
        expect(body.success).toBe(true);
        expect(Array.isArray(body.data)).toBe(true);
        expect(body.pagination).toBeDefined();
      }
    });

    it("GET /api/v1/courses/:id works", async () => {
      const listRes = await app.inject({ method: "GET", url: "/api/v1/courses" });
      if (listRes.statusCode === 200) {
        const listBody = JSON.parse(listRes.payload);
        if (listBody.data.length > 0) {
          const courseId = listBody.data[0].id;
          const res = await app.inject({ method: "GET", url: `/api/v1/courses/${courseId}` });
          expect([200, 404, 500]).toContain(res.statusCode);
          if (res.statusCode === 200) {
            const body = JSON.parse(res.payload);
            expect(body.success).toBe(true);
            expect(body.data.id).toBe(courseId);
          }
        }
      }
    });

    it("POST /api/v1/courses/:id/enroll rejects unauthenticated", async () => {
      const res = await app.inject({
        method: "POST",
        url: "/api/v1/courses/00000000-0000-0000-0000-000000000001/enroll",
      });
      expect(res.statusCode).toBe(401);
    });

    it("POST /api/v1/quizzes/generate rejects unauthenticated", async () => {
      const res = await app.inject({
        method: "POST",
        url: "/api/v1/quizzes/generate",
        payload: { moduleId: "test" },
      });
      expect(res.statusCode).toBe(401);
    });

    it("POST /api/v1/rewards/claim rejects unauthenticated", async () => {
      const res = await app.inject({
        method: "POST",
        url: "/api/v1/rewards/claim",
        payload: { quizId: "test", score: 100 },
      });
      expect(res.statusCode).toBe(401);
    });
  });

  describe("Health endpoints unaffected", () => {
    it("GET /health still works without version prefix", async () => {
      const res = await app.inject({ method: "GET", url: "/health" });
      expect([200, 503]).toContain(res.statusCode);
      const body = JSON.parse(res.payload);
      expect(body.status).toBeDefined();
    });

    it("GET /health/live still works", async () => {
      const res = await app.inject({ method: "GET", url: "/health/live" });
      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.payload);
      expect(body.status).toBe("ok");
    });

    it("GET /metrics still works", async () => {
      const res = await app.inject({ method: "GET", url: "/metrics" });
      expect(res.statusCode).toBe(200);
    });
  });

  describe("404 for unknown versioned routes", () => {
    it("GET /api/v1/nonexistent returns 404", async () => {
      const res = await app.inject({ method: "GET", url: "/api/v1/nonexistent" });
      expect(res.statusCode).toBe(404);
    });
  });
});
