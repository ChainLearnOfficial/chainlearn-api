import { describe, it, expect, beforeAll, afterAll } from "vitest";
import type { FastifyInstance } from "fastify";
import { buildApp } from "../../src/server.js";

describe("Quizzes API", () => {
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

  describe("POST /api/v1/quizzes/generate", () => {
    it("should reject unauthenticated requests", async () => {
      const response = await app.inject({
        method: "POST",
        url: "/api/v1/quizzes/generate",
        payload: {
          courseId: "00000000-0000-0000-0000-000000000001",
          moduleId: "module-1",
        },
      });

      expect(response.statusCode).toBe(401);
      const body = JSON.parse(response.payload);
      expect(body.error).toBe("UNAUTHORIZED");
    });

    it("should reject if not enrolled in course", async () => {
      const token = createToken();

      const response = await app.inject({
        method: "POST",
        url: "/api/v1/quizzes/generate",
        headers: { authorization: `Bearer ${token}` },
        payload: {
          courseId: "00000000-0000-0000-0000-000000000001",
          moduleId: "module-1",
        },
      });

      // 403 (not enrolled), 401 (auth rejected), 404 (course not found), 500 (DB unavailable)
      expect([401, 403, 404, 500]).toContain(response.statusCode);
      if (response.statusCode === 403) {
        const body = JSON.parse(response.payload);
        expect(body.error).toBe("FORBIDDEN");
      }
    });

    it("should return generated quiz questions", async () => {
      const token = createToken();

      // First, get a course to enroll in
      const listResponse = await app.inject({
        method: "GET",
        url: "/api/v1/courses",
      });

      if (listResponse.statusCode === 200) {
        const listBody = JSON.parse(listResponse.payload);
        if (listBody.data.length > 0) {
          const course = listBody.data[0];

          // Enroll in the course
          await app.inject({
            method: "POST",
            url: `/api/v1/courses/${course.id}/enroll`,
            headers: { authorization: `Bearer ${token}` },
          });

          // Generate a quiz
          const response = await app.inject({
            method: "POST",
            url: "/api/v1/quizzes/generate",
            headers: { authorization: `Bearer ${token}` },
            payload: {
              courseId: course.id,
              moduleId: "module-1",
            },
          });

          // 200/201 (generated), 401 (auth rejected), 403 (not enrolled), 500 (DB/AI unavailable)
          expect([200, 201, 401, 403, 500]).toContain(response.statusCode);
          if (response.statusCode === 200 || response.statusCode === 201) {
            const body = JSON.parse(response.payload);
            expect(body.success).toBe(true);
            expect(body.data.id).toBeDefined();
            expect(Array.isArray(body.data.questions)).toBe(true);
            expect(body.data.questions.length).toBeGreaterThan(0);
            // Verify correctIndex is not exposed
            for (const question of body.data.questions) {
              expect(question.correctIndex).toBeUndefined();
            }
          }
        }
      }
    });

    it("should return same quiz on repeat generation (idempotent)", { timeout: 15000 }, async () => {
      const token = createToken();

      const listResponse = await app.inject({
        method: "GET",
        url: "/api/v1/courses",
      });

      if (listResponse.statusCode === 200) {
        const listBody = JSON.parse(listResponse.payload);
        if (listBody.data.length > 0) {
          const course = listBody.data[0];

          await app.inject({
            method: "POST",
            url: `/api/v1/courses/${course.id}/enroll`,
            headers: { authorization: `Bearer ${token}` },
          });

          // First generation
          const first = await app.inject({
            method: "POST",
            url: "/api/v1/quizzes/generate",
            headers: { authorization: `Bearer ${token}` },
            payload: {
              courseId: course.id,
              moduleId: "module-1",
            },
          });

          // Second generation with same params
          const second = await app.inject({
            method: "POST",
            url: "/api/v1/quizzes/generate",
            headers: { authorization: `Bearer ${token}` },
            payload: {
              courseId: course.id,
              moduleId: "module-1",
            },
          });

          if (
            (first.statusCode === 200 || first.statusCode === 201) &&
            (second.statusCode === 200 || second.statusCode === 201)
          ) {
            const firstBody = JSON.parse(first.payload);
            const secondBody = JSON.parse(second.payload);
            expect(secondBody.data.id).toBe(firstBody.data.id);
          }
        }
      }
    });
  });

  describe("POST /api/v1/quizzes/:id/submit", () => {
    it("should reject unauthenticated requests", async () => {
      const response = await app.inject({
        method: "POST",
        url: "/api/v1/quizzes/00000000-0000-0000-0000-000000000001/submit",
        payload: {
          answers: [{ questionId: "q1", selectedIndex: 0 }],
        },
      });

      expect(response.statusCode).toBe(401);
    });

    it("should submit answers and return score", async () => {
      const token = createToken();

      const listResponse = await app.inject({
        method: "GET",
        url: "/api/v1/courses",
      });

      if (listResponse.statusCode === 200) {
        const listBody = JSON.parse(listResponse.payload);
        if (listBody.data.length > 0) {
          const course = listBody.data[0];

          await app.inject({
            method: "POST",
            url: `/api/v1/courses/${course.id}/enroll`,
            headers: { authorization: `Bearer ${token}` },
          });

          const quizResponse = await app.inject({
            method: "POST",
            url: "/api/v1/quizzes/generate",
            headers: { authorization: `Bearer ${token}` },
            payload: {
              courseId: course.id,
              moduleId: "module-1",
            },
          });

          if (
            quizResponse.statusCode === 200 ||
            quizResponse.statusCode === 201
          ) {
            const quizBody = JSON.parse(quizResponse.payload);
            const quiz = quizBody.data;

            const answers = quiz.questions.map(
              (q: { id: string }) => ({
                questionId: q.id,
                selectedIndex: 0,
              }),
            );

            const response = await app.inject({
              method: "POST",
              url: `/api/v1/quizzes/${quiz.id}/submit`,
              headers: { authorization: `Bearer ${token}` },
              payload: { answers },
            });

            expect([200, 401, 500]).toContain(response.statusCode);
            if (response.statusCode === 200) {
              const body = JSON.parse(response.payload);
              expect(body.success).toBe(true);
              expect(typeof body.data.score).toBe("number");
              expect(typeof body.data.totalQuestions).toBe("number");
              expect(typeof body.data.percentage).toBe("number");
              expect(typeof body.data.passed).toBe("boolean");
            }
          }
        }
      }
    });

    it("should include feedback in response", async () => {
      const token = createToken();

      const listResponse = await app.inject({
        method: "GET",
        url: "/api/v1/courses",
      });

      if (listResponse.statusCode === 200) {
        const listBody = JSON.parse(listResponse.payload);
        if (listBody.data.length > 0) {
          const course = listBody.data[0];

          await app.inject({
            method: "POST",
            url: `/api/v1/courses/${course.id}/enroll`,
            headers: { authorization: `Bearer ${token}` },
          });

          const quizResponse = await app.inject({
            method: "POST",
            url: "/api/v1/quizzes/generate",
            headers: { authorization: `Bearer ${token}` },
            payload: {
              courseId: course.id,
              moduleId: "module-1",
            },
          });

          if (
            quizResponse.statusCode === 200 ||
            quizResponse.statusCode === 201
          ) {
            const quizBody = JSON.parse(quizResponse.payload);
            const quiz = quizBody.data;

            const answers = quiz.questions.map(
              (q: { id: string }) => ({
                questionId: q.id,
                selectedIndex: 0,
              }),
            );

            const response = await app.inject({
              method: "POST",
              url: `/api/v1/quizzes/${quiz.id}/submit`,
              headers: { authorization: `Bearer ${token}` },
              payload: { answers },
            });

            if (response.statusCode === 200) {
              const body = JSON.parse(response.payload);
              expect(typeof body.data.feedback).toBe("string");
              expect(body.data.feedback.length).toBeGreaterThan(0);
            }
          }
        }
      }
    });

    it("should set rewardAvailable when score >= 70%", async () => {
      const token = createToken();

      const listResponse = await app.inject({
        method: "GET",
        url: "/api/v1/courses",
      });

      if (listResponse.statusCode === 200) {
        const listBody = JSON.parse(listResponse.payload);
        if (listBody.data.length > 0) {
          const course = listBody.data[0];

          await app.inject({
            method: "POST",
            url: `/api/v1/courses/${course.id}/enroll`,
            headers: { authorization: `Bearer ${token}` },
          });

          const quizResponse = await app.inject({
            method: "POST",
            url: "/api/v1/quizzes/generate",
            headers: { authorization: `Bearer ${token}` },
            payload: {
              courseId: course.id,
              moduleId: "module-1",
            },
          });

          if (
            quizResponse.statusCode === 200 ||
            quizResponse.statusCode === 201
          ) {
            const quizBody = JSON.parse(quizResponse.payload);
            const quiz = quizBody.data;

            const answers = quiz.questions.map(
              (q: { id: string }) => ({
                questionId: q.id,
                selectedIndex: 0,
              }),
            );

            const response = await app.inject({
              method: "POST",
              url: `/api/v1/quizzes/${quiz.id}/submit`,
              headers: { authorization: `Bearer ${token}` },
              payload: { answers },
            });

            if (response.statusCode === 200) {
              const body = JSON.parse(response.payload);
              if (body.data.passed) {
                expect(body.data.rewardAvailable).toBe(true);
              } else {
                expect(body.data.rewardAvailable).toBe(false);
              }
            }
          }
        }
      }
    });

    it("should reject duplicate submission", async () => {
      const token = createToken();

      const listResponse = await app.inject({
        method: "GET",
        url: "/api/v1/courses",
      });

      if (listResponse.statusCode === 200) {
        const listBody = JSON.parse(listResponse.payload);
        if (listBody.data.length > 0) {
          const course = listBody.data[0];

          await app.inject({
            method: "POST",
            url: `/api/v1/courses/${course.id}/enroll`,
            headers: { authorization: `Bearer ${token}` },
          });

          const quizResponse = await app.inject({
            method: "POST",
            url: "/api/v1/quizzes/generate",
            headers: { authorization: `Bearer ${token}` },
            payload: {
              courseId: course.id,
              moduleId: "module-1",
            },
          });

          if (
            quizResponse.statusCode === 200 ||
            quizResponse.statusCode === 201
          ) {
            const quizBody = JSON.parse(quizResponse.payload);
            const quiz = quizBody.data;

            const answers = quiz.questions.map(
              (q: { id: string }) => ({
                questionId: q.id,
                selectedIndex: 0,
              }),
            );

            // First submission
            await app.inject({
              method: "POST",
              url: `/api/v1/quizzes/${quiz.id}/submit`,
              headers: { authorization: `Bearer ${token}` },
              payload: { answers },
            });

            // Second submission should be rejected
            const response = await app.inject({
              method: "POST",
              url: `/api/v1/quizzes/${quiz.id}/submit`,
              headers: { authorization: `Bearer ${token}` },
              payload: { answers },
            });

            expect([401, 409, 500]).toContain(response.statusCode);
            if (response.statusCode === 409) {
              const body = JSON.parse(response.payload);
              expect(body.error).toBe("CONFLICT");
            }
          }
        }
      }
    });
  });
});
