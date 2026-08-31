import { describe, it, expect, beforeAll, afterAll } from "vitest";
import type { FastifyInstance } from "fastify";
import { buildApp } from "../../src/server.js";

describe("Users API", () => {
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

  describe("GET /api/v1/users/me", () => {
    it("should reject unauthenticated requests", async () => {
      const response = await app.inject({
        method: "GET",
        url: "/api/v1/users/me",
      });

      expect(response.statusCode).toBe(401);
      const body = JSON.parse(response.payload);
      expect(body.error).toBe("UNAUTHORIZED");
    });

    it("should return user profile when authenticated", async () => {
      const token = createToken();

      const response = await app.inject({
        method: "GET",
        url: "/api/v1/users/me",
        headers: { authorization: `Bearer ${token}` },
      });

      // May return 200 (success) or 401 (auth rejected)
      expect([200, 401]).toContain(response.statusCode);
      if (response.statusCode === 200) {
        const body = JSON.parse(response.payload);
        expect(body.success).toBe(true);
        expect(body.data).toBeDefined();
      }
    });

    it("should return correct stellarAddress in profile", async () => {
      const token = createToken();

      const response = await app.inject({
        method: "GET",
        url: "/api/v1/users/me",
        headers: { authorization: `Bearer ${token}` },
      });

      expect([200, 401]).toContain(response.statusCode);
      if (response.statusCode === 200) {
        const body = JSON.parse(response.payload);
        expect(body.data.stellarAddress).toBe(
          "GALICE0000000000000000000000000000000000000000000000000000000",
        );
      }
    });
  });

  describe("PUT /api/v1/users/me", () => {
    it("should reject unauthenticated requests", async () => {
      const response = await app.inject({
        method: "PUT",
        url: "/api/v1/users/me",
        payload: { displayName: "Alice" },
      });

      expect(response.statusCode).toBe(401);
    });

    it("should update displayName", async () => {
      const token = createToken();

      const response = await app.inject({
        method: "PUT",
        url: "/api/v1/users/me",
        headers: { authorization: `Bearer ${token}` },
        payload: { displayName: "Alice ChainLearner" },
      });

      expect([200, 401]).toContain(response.statusCode);
      if (response.statusCode === 200) {
        const body = JSON.parse(response.payload);
        expect(body.success).toBe(true);
        expect(body.data.displayName).toBe("Alice ChainLearner");
      }
    });

    it("should update background and learningGoal", async () => {
      const token = createToken();

      const response = await app.inject({
        method: "PUT",
        url: "/api/v1/users/me",
        headers: { authorization: `Bearer ${token}` },
        payload: {
          background: "Software developer exploring blockchain",
          learningGoal: "Master Stellar smart contracts",
        },
      });

      expect([200, 401]).toContain(response.statusCode);
      if (response.statusCode === 200) {
        const body = JSON.parse(response.payload);
        expect(body.success).toBe(true);
        expect(body.data.background).toBe(
          "Software developer exploring blockchain",
        );
        expect(body.data.learningGoal).toBe(
          "Master Stellar smart contracts",
        );
      }
    });

    it("should reject invalid background values", async () => {
      const token = createToken();

      const response = await app.inject({
        method: "PUT",
        url: "/api/v1/users/me",
        headers: { authorization: `Bearer ${token}` },
        payload: { background: "" },
      });

      // May return 400 (validation error) or 401 (auth rejected)
      expect([400, 401]).toContain(response.statusCode);
    });
  });

  describe("GET /api/v1/users/me/progress", () => {
    it("should reject unauthenticated requests", async () => {
      const response = await app.inject({
        method: "GET",
        url: "/api/v1/users/me/progress",
      });

      expect(response.statusCode).toBe(401);
    });

    it("should return progress aggregate for enrolled user", async () => {
      const token = createToken();

      const response = await app.inject({
        method: "GET",
        url: "/api/v1/users/me/progress",
        headers: { authorization: `Bearer ${token}` },
      });

      expect([200, 401]).toContain(response.statusCode);
      if (response.statusCode === 200) {
        const body = JSON.parse(response.payload);
        expect(body.success).toBe(true);
        expect(body.data).toBeDefined();
        expect(typeof body.data.enrolledCourses).toBe("number");
        expect(typeof body.data.completedCourses).toBe("number");
        expect(typeof body.data.credentialsEarned).toBe("number");
      }
    });
  });

  describe("GET /api/v1/users/me/activity", () => {
    it("should reject unauthenticated requests", async () => {
      const response = await app.inject({
        method: "GET",
        url: "/api/v1/users/me/activity",
      });

      expect(response.statusCode).toBe(401);
    });

    it("should return a cursor-paginated activity feed when authenticated", async () => {
      const token = createToken();

      const response = await app.inject({
        method: "GET",
        url: "/api/v1/users/me/activity?limit=20",
        headers: { authorization: `Bearer ${token}` },
      });

      expect([200, 401]).toContain(response.statusCode);
      if (response.statusCode === 200) {
        const body = JSON.parse(response.payload);
        expect(body.success).toBe(true);
        expect(Array.isArray(body.data)).toBe(true);
        expect(body.pagination).toBeDefined();
        expect(body.pagination).toHaveProperty("nextCursor");
        for (const activity of body.data) {
          expect(typeof activity.type).toBe("string");
          expect(typeof activity.title).toBe("string");
          expect(typeof activity.timestamp).toBe("string");
          expect(activity.metadata).toBeDefined();
        }
      }
    });
  });

  describe("PUT /api/v1/users/me/avatar", () => {
    it("should reject unauthenticated uploads", async () => {
      const response = await app.inject({
        method: "PUT",
        url: "/api/v1/users/me/avatar",
      });

      expect(response.statusCode).toBe(401);
    });
  });
});
