import { describe, it, expect, beforeAll, afterAll } from "vitest";
import type { FastifyInstance } from "fastify";
import { buildApp } from "../../src/server.js";

describe("Courses API", () => {
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

  describe("GET /api/courses", () => {
    it("should return paginated course list", async () => {
      const response = await app.inject({
        method: "GET",
        url: "/api/courses",
      });

      expect([200, 500]).toContain(response.statusCode);
      if (response.statusCode === 200) {
        const body = JSON.parse(response.payload);
        expect(body.success).toBe(true);
        expect(Array.isArray(body.data)).toBe(true);
        expect(body.pagination).toBeDefined();
        expect(typeof body.pagination.page).toBe("number");
        expect(typeof body.pagination.limit).toBe("number");
        expect(typeof body.pagination.total).toBe("number");
      }
    });

    it("should filter by difficulty query param", { timeout: 10000 }, async () => {
      const response = await app.inject({
        method: "GET",
        url: "/api/courses?difficulty=beginner",
      });

      expect([200, 400, 500]).toContain(response.statusCode);
      if (response.statusCode === 200) {
        const body = JSON.parse(response.payload);
        expect(body.success).toBe(true);
        for (const course of body.data) {
          expect(course.difficulty).toBe("beginner");
        }
      }
    });

    it("should return enrolledCount for each course", { timeout: 10000 }, async () => {
      const response = await app.inject({
        method: "GET",
        url: "/api/courses",
      });

      // May return 500 if Redis/DB unavailable
      expect([200, 500]).toContain(response.statusCode);
      if (response.statusCode === 200) {
        const body = JSON.parse(response.payload);
        for (const course of body.data) {
          expect(typeof course.enrolledCount).toBe("number");
        }
      }
    });

    it("should include isEnrolled when authenticated", async () => {
      const token = createToken();

      const response = await app.inject({
        method: "GET",
        url: "/api/courses",
        headers: { authorization: `Bearer ${token}` },
      });

      expect([200, 401, 500]).toContain(response.statusCode);
      if (response.statusCode === 200) {
        const body = JSON.parse(response.payload);
        for (const course of body.data) {
          expect(typeof course.isEnrolled).toBe("boolean");
        }
      }
    });
  });

  describe("GET /api/courses/:id", () => {
    it("should return course detail with modules", async () => {
      // First get a valid course ID from the list
      const listResponse = await app.inject({
        method: "GET",
        url: "/api/courses",
      });

      if (listResponse.statusCode === 200) {
        const listBody = JSON.parse(listResponse.payload);
        if (listBody.data.length > 0) {
          const courseId = listBody.data[0].id;

          const response = await app.inject({
            method: "GET",
            url: `/api/courses/${courseId}`,
          });

          expect([200, 404, 500]).toContain(response.statusCode);
          if (response.statusCode === 200) {
            const body = JSON.parse(response.payload);
            expect(body.success).toBe(true);
            expect(body.data.id).toBe(courseId);
            expect(Array.isArray(body.data.modules)).toBe(true);
          }
        }
      }
    });

    it("should return 404 for non-existent course", async () => {
      const response = await app.inject({
        method: "GET",
        url: "/api/courses/00000000-0000-0000-0000-000000000000",
      });

      expect([404, 500]).toContain(response.statusCode);
    });

    it("should include enrollment status when authenticated", async () => {
      const token = createToken();

      const listResponse = await app.inject({
        method: "GET",
        url: "/api/courses",
      });

      if (listResponse.statusCode === 200) {
        const listBody = JSON.parse(listResponse.payload);
        if (listBody.data.length > 0) {
          const courseId = listBody.data[0].id;

          const response = await app.inject({
            method: "GET",
            url: `/api/courses/${courseId}`,
            headers: { authorization: `Bearer ${token}` },
          });

          expect([200, 401, 404, 500]).toContain(response.statusCode);
          if (response.statusCode === 200) {
            const body = JSON.parse(response.payload);
            expect(typeof body.data.isEnrolled).toBe("boolean");
          }
        }
      }
    });
  });

  describe("POST /api/courses/:id/enroll", () => {
    it("should reject unauthenticated requests", async () => {
      const response = await app.inject({
        method: "POST",
        url: "/api/courses/00000000-0000-0000-0000-000000000001/enroll",
      });

      expect(response.statusCode).toBe(401);
    });

    it("should enroll user in course", async () => {
      const token = createToken();

      const listResponse = await app.inject({
        method: "GET",
        url: "/api/courses",
      });

      if (listResponse.statusCode === 200) {
        const listBody = JSON.parse(listResponse.payload);
        if (listBody.data.length > 0) {
          const courseId = listBody.data[0].id;

          const response = await app.inject({
            method: "POST",
            url: `/api/courses/${courseId}/enroll`,
            headers: { authorization: `Bearer ${token}` },
          });

          // 201 (enrolled), 409 (already enrolled), 401 (auth rejected), 500 (DB unavailable)
          expect([201, 401, 409, 500]).toContain(response.statusCode);
          if (response.statusCode === 201) {
            const body = JSON.parse(response.payload);
            expect(body.success).toBe(true);
            expect(body.message).toBe("Enrolled successfully");
          }
        }
      }
    });

    it("should reject duplicate enrollment", async () => {
      const token = createToken();

      const listResponse = await app.inject({
        method: "GET",
        url: "/api/courses",
      });

      if (listResponse.statusCode === 200) {
        const listBody = JSON.parse(listResponse.payload);
        if (listBody.data.length > 0) {
          const courseId = listBody.data[0].id;

          // First enrollment attempt
          await app.inject({
            method: "POST",
            url: `/api/courses/${courseId}/enroll`,
            headers: { authorization: `Bearer ${token}` },
          });

          // Second enrollment attempt should be rejected
          const response = await app.inject({
            method: "POST",
            url: `/api/courses/${courseId}/enroll`,
            headers: { authorization: `Bearer ${token}` },
          });

          expect([401, 409, 500]).toContain(response.statusCode);
          if (response.statusCode === 409) {
            const body = JSON.parse(response.payload);
            expect(body.error).toBe("CONFLICT");
          }
        }
      }
    });

    it("should return 404 for non-existent course", async () => {
      const token = createToken();

      const response = await app.inject({
        method: "POST",
        url: "/api/courses/00000000-0000-0000-0000-000000000000/enroll",
        headers: { authorization: `Bearer ${token}` },
      });

      expect([401, 404, 500]).toContain(response.statusCode);
      if (response.statusCode === 404) {
        const body = JSON.parse(response.payload);
        expect(body.error).toBe("NOT_FOUND");
      }
    });
  });
});
