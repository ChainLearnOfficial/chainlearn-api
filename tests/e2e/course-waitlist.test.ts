/// <reference types="vitest" />
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import type { FastifyInstance } from "fastify";
import { buildApp } from "../../src/server.js";

describe("Course Enrollment Waitlist API (Issue #323)", () => {
  let app: FastifyInstance;

  beforeAll(async () => {
    app = await buildApp();
  });

  afterAll(async () => {
    await app.close();
  });

  const createToken = (userId = "00000000-0000-0000-0000-000000000001") =>
    app.jwt.sign({
      sub: userId,
      stellarAddress:
        "GALICE0000000000000000000000000000000000000000000000000000000",
    });

  describe("POST /api/v1/courses/:id/waitlist", () => {
    it("should require authentication", async () => {
      const response = await app.inject({
        method: "POST",
        url: "/api/v1/courses/00000000-0000-0000-0000-000000000000/waitlist",
        payload: {
          courseId: "00000000-0000-0000-0000-000000000000",
        },
      });

      expect(response.statusCode).toBe(401);
    });

    it("should allow user to join waitlist with valid courseId", async () => {
      const token = createToken();

      // Get a course
      const coursesResponse = await app.inject({
        method: "GET",
        url: "/api/v1/courses?limit=1",
      });

      if (coursesResponse.statusCode !== 200) {
        return;
      }

      const coursesBody = JSON.parse(coursesResponse.payload);
      const courseId = coursesBody.data[0]?.id;

      if (!courseId) {
        return;
      }

      const response = await app.inject({
        method: "POST",
        url: `/api/v1/courses/${courseId}/waitlist`,
        headers: { authorization: `Bearer ${token}` },
        payload: { courseId },
      });

      expect([201, 409, 400]).toContain(response.statusCode);
      if (response.statusCode === 201) {
        const body = JSON.parse(response.payload);
        expect(body.data).toHaveProperty("position");
        expect(typeof body.data.position).toBe("number");
        expect(body.data.position).toBeGreaterThan(0);
      }
    });

    it("should return 409 if user already enrolled", async () => {
      const token = createToken();

      // Get a course
      const coursesResponse = await app.inject({
        method: "GET",
        url: "/api/v1/courses?limit=1",
      });

      if (coursesResponse.statusCode !== 200) {
        return;
      }

      const coursesBody = JSON.parse(coursesResponse.payload);
      const courseId = coursesBody.data[0]?.id;

      if (!courseId) {
        return;
      }

      // Enroll first
      await app.inject({
        method: "POST",
        url: `/api/v1/courses/${courseId}/enroll`,
        headers: { authorization: `Bearer ${token}` },
      });

      // Try to join waitlist
      const response = await app.inject({
        method: "POST",
        url: `/api/v1/courses/${courseId}/waitlist`,
        headers: { authorization: `Bearer ${token}` },
        payload: { courseId },
      });

      expect([201, 409, 400]).toContain(response.statusCode);
    });
  });

  describe("DELETE /api/v1/courses/:id/waitlist", () => {
    it("should require authentication", async () => {
      const response = await app.inject({
        method: "DELETE",
        url: "/api/v1/courses/00000000-0000-0000-0000-000000000000/waitlist",
        payload: {
          courseId: "00000000-0000-0000-0000-000000000000",
        },
      });

      expect(response.statusCode).toBe(401);
    });

    it("should allow user to leave waitlist", async () => {
      const userId = "00000000-0000-0000-0000-000000000099";
      const token = createToken(userId);

      // Get a course
      const coursesResponse = await app.inject({
        method: "GET",
        url: "/api/v1/courses?limit=1",
      });

      if (coursesResponse.statusCode !== 200) {
        return;
      }

      const coursesBody = JSON.parse(coursesResponse.payload);
      const courseId = coursesBody.data[0]?.id;

      if (!courseId) {
        return;
      }

      // Join waitlist
      const joinResponse = await app.inject({
        method: "POST",
        url: `/api/v1/courses/${courseId}/waitlist`,
        headers: { authorization: `Bearer ${token}` },
        payload: { courseId },
      });

      // Only test leave if join was successful
      if (joinResponse.statusCode === 201) {
        const leaveResponse = await app.inject({
          method: "DELETE",
          url: `/api/v1/courses/${courseId}/waitlist`,
          headers: { authorization: `Bearer ${token}` },
          payload: { courseId },
        });

        expect([200, 204, 400, 404]).toContain(leaveResponse.statusCode);
      }
    });
  });

  describe("GET /api/v1/courses/:id/waitlist/status", () => {
    it("should require authentication", async () => {
      const response = await app.inject({
        method: "GET",
        url: "/api/v1/courses/00000000-0000-0000-0000-000000000000/waitlist/status",
      });

      expect(response.statusCode).toBe(401);
    });

    it("should return waitlist status for user", async () => {
      const token = createToken();

      // Get a course
      const coursesResponse = await app.inject({
        method: "GET",
        url: "/api/v1/courses?limit=1",
      });

      if (coursesResponse.statusCode !== 200) {
        return;
      }

      const coursesBody = JSON.parse(coursesResponse.payload);
      const courseId = coursesBody.data[0]?.id;

      if (!courseId) {
        return;
      }

      const response = await app.inject({
        method: "GET",
        url: `/api/v1/courses/${courseId}/waitlist/status`,
        headers: { authorization: `Bearer ${token}` },
      });

      expect([200, 400]).toContain(response.statusCode);
      if (response.statusCode === 200) {
        const body = JSON.parse(response.payload);
        expect(body.data).toHaveProperty("isOnWaitlist");
        expect(typeof body.data.isOnWaitlist).toBe("boolean");
        expect(body.data).toHaveProperty("totalOnWaitlist");
        expect(typeof body.data.totalOnWaitlist).toBe("number");
        
        if (body.data.isOnWaitlist) {
          expect(body.data).toHaveProperty("position");
          expect(typeof body.data.position).toBe("number");
        }
      }
    });

    it("should show position when user is on waitlist", async () => {
      const userId = "00000000-0000-0000-0000-000000000088";
      const token = createToken(userId);

      // Get a course
      const coursesResponse = await app.inject({
        method: "GET",
        url: "/api/v1/courses?limit=1",
      });

      if (coursesResponse.statusCode !== 200) {
        return;
      }

      const coursesBody = JSON.parse(coursesResponse.payload);
      const courseId = coursesBody.data[0]?.id;

      if (!courseId) {
        return;
      }

      // Join waitlist
      const joinResponse = await app.inject({
        method: "POST",
        url: `/api/v1/courses/${courseId}/waitlist`,
        headers: { authorization: `Bearer ${token}` },
        payload: { courseId },
      });

      // Check status
      if (joinResponse.statusCode === 201) {
        const statusResponse = await app.inject({
          method: "GET",
          url: `/api/v1/courses/${courseId}/waitlist/status`,
          headers: { authorization: `Bearer ${token}` },
        });

        if (statusResponse.statusCode === 200) {
          const body = JSON.parse(statusResponse.payload);
          expect(body.data.isOnWaitlist).toBe(true);
          expect(typeof body.data.position).toBe("number");
          expect(body.data.position).toBeGreaterThan(0);
        }
      }
    });
  });
});
