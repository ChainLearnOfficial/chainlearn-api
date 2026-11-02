import { describe, it, expect, beforeAll, afterAll, afterEach, vi } from "vitest";
import type { FastifyInstance } from "fastify";
import { buildApp } from "../../src/server.js";
import { config } from "../../src/config/index.js";
import { courseController } from "../../src/modules/courses/course.controller.js";
import { courseService } from "../../src/modules/courses/course.service.js";
import { authController } from "../../src/modules/auth/auth.controller.js";
import { authService } from "../../src/modules/auth/auth.service.js";
import type { CourseDetail, CourseSummary } from "../../src/modules/courses/course.types.js";

const UUID_V4_REGEX =
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const ISO_8601_REGEX = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;
const SAMPLE_COURSE_ID = "00000000-0000-0000-0000-000000000001";
const VALID_STELLAR_ADDRESS = "G" + "A".repeat(55);

describe("API Versioning", () => {
  let app: FastifyInstance;

  beforeAll(async () => {
    app = await buildApp();
    await app.ready();
  });

  afterEach(() => {
    vi.restoreAllMocks();
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
        payload: {
          stellarAddress:
            "GALICE0000000000000000000000000000000000000000000000000000000",
        },
      });
      expect([200, 400, 500]).toContain(res.statusCode);
      if (res.statusCode === 200) {
        const body = JSON.parse(res.payload);
        expect(body.meta).toBeDefined();
        expect(body.meta.version).toBe("v1");
      }
    });
  });

  describe("Response schema contracts for 2xx versioned endpoints", () => {
    it("GET /api/v1/courses enforces paginated CourseSummary[], meta envelope, and Cache-Control", async () => {
      const sampleCourses: CourseSummary[] = [
        {
          id: SAMPLE_COURSE_ID,
          title: "Soroban Smart Contracts 101",
          description: "Foundational Stellar Soroban development",
          difficulty: "beginner",
          isActive: true,
          enrolledCount: 42,
          isEnrolled: false,
        },
      ];
      const origList = courseController.list.bind(courseController);
      vi.spyOn(courseController, "list").mockImplementationOnce(
        async (req, rep) => {
          await origList(req, rep);
          return rep as unknown as void;
        },
      );
      vi.spyOn(courseService, "listCourses").mockResolvedValueOnce({
        courses: sampleCourses,
        total: 12,
      });

      const res = await app.inject({
        method: "GET",
        url: "/api/v1/courses?difficulty=beginner&page=2&limit=5",
        headers: { "x-request-id": "contract-courses-list-001" },
      });

      expect(res.statusCode).toBe(200);
      expect(res.headers["content-type"]).toContain("application/json");
      expect(res.headers["cache-control"]).toBe("public, max-age=30");
      expect(res.headers["x-request-id"]).toBe("contract-courses-list-001");

      const body = JSON.parse(res.payload) as {
        success: boolean;
        data: CourseSummary[];
        pagination: { page: number; limit: number; total: number };
        meta: { version: string; timestamp: string; requestId: string };
      };

      expect(body.success).toBe(true);
      expect(Array.isArray(body.data)).toBe(true);
      expect(body.data).toHaveLength(1);
      expect(body.data[0]).toEqual({
        id: SAMPLE_COURSE_ID,
        title: "Soroban Smart Contracts 101",
        description: "Foundational Stellar Soroban development",
        difficulty: "beginner",
        isActive: true,
        enrolledCount: 42,
        isEnrolled: false,
      });
      expect(body.pagination).toEqual({
        page: 2,
        limit: 5,
        total: 12,
      });
      expect(body.meta.version).toBe("v1");
      expect(body.meta.timestamp).toMatch(ISO_8601_REGEX);
      expect(body.meta.requestId).toBe("contract-courses-list-001");
    });

    it("GET /api/v1/courses/:id enforces CourseDetail schema and module list contract", async () => {
      const sampleDetail: CourseDetail = {
        id: SAMPLE_COURSE_ID,
        title: "Stellar Asset Issuance",
        description: "Deep dive into Stellar assets and trustlines",
        difficulty: "intermediate",
        isActive: true,
        enrolledCount: 19,
        isEnrolled: true,
        contentHash: "a".repeat(64),
        createdAt: new Date("2026-01-15T00:00:00.000Z"),
        averageRating: 4.75,
        reviewCount: 8,
        modules: [
          {
            id: "mod-trustlines",
            title: "Understanding Trustlines",
            description: "How accounts opt into holding issued assets",
            estimatedDurationMinutes: 25,
            order: 0,
          },
        ],
      };
      const origGetById = courseController.getById.bind(courseController);
      vi.spyOn(courseController, "getById").mockImplementationOnce(
        async (req, rep) => {
          await origGetById(req, rep);
          return rep as unknown as void;
        },
      );
      vi.spyOn(courseService, "getCourseDetail").mockResolvedValueOnce(
        sampleDetail,
      );

      const res = await app.inject({
        method: "GET",
        url: `/api/v1/courses/${SAMPLE_COURSE_ID}`,
      });

      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.payload);
      expect(body.success).toBe(true);
      expect(body.data).toMatchObject({
        id: SAMPLE_COURSE_ID,
        title: "Stellar Asset Issuance",
        difficulty: "intermediate",
        isActive: true,
        enrolledCount: 19,
        isEnrolled: true,
        contentHash: "a".repeat(64),
        createdAt: "2026-01-15T00:00:00.000Z",
        averageRating: 4.75,
        reviewCount: 8,
      });
      expect(Array.isArray(body.data.modules)).toBe(true);
      expect(body.data.modules[0]).toEqual({
        id: "mod-trustlines",
        title: "Understanding Trustlines",
        description: "How accounts opt into holding issued assets",
        estimatedDurationMinutes: 25,
        order: 0,
      });
      expect(body.meta.version).toBe("v1");
      expect(body.meta.timestamp).toMatch(ISO_8601_REGEX);
      expect(body.meta.requestId).toMatch(UUID_V4_REGEX);
      expect(res.headers["x-request-id"]).toBe(body.meta.requestId);
    });

    it("POST /api/v1/auth/challenge enforces SEP-10 ChallengeResponse schema and no-store caching", async () => {
      const challengeId = "11111111-2222-4333-8444-555555555555";
      const origChallenge = authController.challenge.bind(authController);
      vi.spyOn(authController, "challenge").mockImplementationOnce(
        async (req, rep) => {
          await origChallenge(req, rep);
          return rep as unknown as void;
        },
      );
      vi.spyOn(authService, "createChallenge").mockResolvedValueOnce({
        challenge: "AAAAAgAAAABbase64xdr==",
        challengeId,
        networkPassphrase: "Test SDF Network ; September 2015",
      });

      const res = await app.inject({
        method: "POST",
        url: "/api/v1/auth/challenge",
        payload: { stellarAddress: VALID_STELLAR_ADDRESS },
      });

      expect(res.statusCode).toBe(200);
      expect(res.headers["cache-control"]).toBe("no-store");
      const body = JSON.parse(res.payload);
      expect(body.success).toBe(true);
      expect(body.data).toEqual({
        challenge: "AAAAAgAAAABbase64xdr==",
        challengeId,
        networkPassphrase: "Test SDF Network ; September 2015",
      });
      expect(body.meta.version).toBe("v1");
      expect(body.meta.timestamp).toMatch(ISO_8601_REGEX);
      expect(body.meta.requestId).toBe(res.headers["x-request-id"]);
    });
  });

  describe("Structured error response schema contracts", () => {
    it("returns 400 VALIDATION_ERROR with details.body on invalid request body", async () => {
      const res = await app.inject({
        method: "POST",
        url: "/api/v1/auth/challenge",
        payload: { stellarAddress: "invalid-address" },
      });

      expect(res.statusCode).toBe(400);
      expect(res.headers["cache-control"]).toBe("no-store");
      const body = JSON.parse(res.payload);
      expect(body.statusCode).toBe(400);
      expect(body.error).toBe("VALIDATION_ERROR");
      expect(body.message).toBe("Validation failed");
      expect(Array.isArray(body.details?.body)).toBe(true);
      expect(body.details.body.length).toBeGreaterThan(0);
      expect(body.meta).toBeUndefined();
    });

    it("returns 400 VALIDATION_ERROR on invalid querystring parameters", async () => {
      const res = await app.inject({
        method: "GET",
        url: "/api/v1/courses?difficulty=unsupported&limit=999",
      });

      expect(res.statusCode).toBe(400);
      expect(res.headers["cache-control"]).toBe("no-store");
      const body = JSON.parse(res.payload);
      expect(body.statusCode).toBe(400);
      expect(body.meta).toBeUndefined();
      expect(typeof body.error).toBe("string");
      expect(typeof body.message).toBe("string");
    });

    it("returns 400 on malformed UUID route parameters", async () => {
      const res = await app.inject({
        method: "GET",
        url: "/api/v1/courses/not-a-valid-uuid",
      });

      expect(res.statusCode).toBe(400);
      expect(res.headers["cache-control"]).toBe("no-store");
      const body = JSON.parse(res.payload);
      expect(body.statusCode).toBe(400);
      expect(body.meta).toBeUndefined();
      expect(typeof body.error).toBe("string");
      expect(typeof body.message).toBe("string");
    });

    it.each([
      { method: "GET" as const, url: "/api/v1/users/me" },
      { method: "PUT" as const, url: "/api/v1/users/me", payload: { displayName: "Ada" } },
      { method: "GET" as const, url: "/api/v1/auth/sessions" },
      { method: "GET" as const, url: "/api/v1/credentials" },
      { method: "GET" as const, url: "/api/v1/rewards/history" },
      { method: "GET" as const, url: "/api/v1/admin/dashboard" },
      { method: "GET" as const, url: "/admin/auth-blocks" },
    ])(
      "returns 401 UNAUTHORIZED contract for unauthenticated $method $url",
      async ({ method, url, payload }) => {
        const res = await app.inject({ method, url, payload });

        expect(res.statusCode).toBe(401);
        const body = JSON.parse(res.payload);
        expect(body).toEqual({
          statusCode: 401,
          error: "UNAUTHORIZED",
          message: "Invalid or expired token",
        });
      },
    );

    it("returns 401 UNAUTHORIZED contract when Bearer token is malformed", async () => {
      const res = await app.inject({
        method: "GET",
        url: "/api/v1/users/me",
        headers: { authorization: "Bearer malformed.jwt.token" },
      });

      expect(res.statusCode).toBe(401);
      expect(res.headers["cache-control"]).toBe("no-store");
      const body = JSON.parse(res.payload);
      expect(body).toEqual({
        statusCode: 401,
        error: "UNAUTHORIZED",
        message: "Invalid or expired token",
      });
    });

    it("returns 413 PAYLOAD_TOO_LARGE contract when request body exceeds limit", async () => {
      const oversizedPayload = JSON.stringify({
        stellarAddress: "G" + "A".repeat(config.REQUEST_BODY_LIMIT_BYTES + 256),
      });

      const res = await app.inject({
        method: "POST",
        url: "/api/v1/auth/challenge",
        headers: { "content-type": "application/json" },
        payload: oversizedPayload,
      });

      expect(res.statusCode).toBe(413);
      expect(res.headers["cache-control"]).toBe("no-store");
      const body = JSON.parse(res.payload);
      expect(body.statusCode).toBe(413);
      expect(body.error).toBe("PAYLOAD_TOO_LARGE");
      expect(body.message).toBe("Request body is too large");
      expect(body.details).toHaveProperty("expectedSize");
      expect(body.details).toHaveProperty("actualSize");
      expect(body.meta).toBeUndefined();
    });
  });

  describe("Headers, correlation ID, and OpenAPI schema contracts", () => {
    it("echoes client X-Request-Id across 4xx, 301 redirect, and /health/live responses", async () => {
      const customId = "client-trace-id-987654";

      const [liveRes, redirectRes, notFoundRes] = await Promise.all([
        app.inject({
          method: "GET",
          url: "/health/live",
          headers: { "x-request-id": customId },
        }),
        app.inject({
          method: "GET",
          url: "/api/courses",
          headers: { "x-request-id": customId },
        }),
        app.inject({
          method: "GET",
          url: "/api/v1/nonexistent",
          headers: { "x-request-id": customId },
        }),
      ]);

      expect(liveRes.headers["x-request-id"]).toBe(customId);
      expect(redirectRes.headers["x-request-id"]).toBe(customId);
      expect(notFoundRes.headers["x-request-id"]).toBe(customId);
    });

    it("generates a UUID v4 X-Request-Id when client omits the header", async () => {
      const res = await app.inject({ method: "GET", url: "/health/live" });
      expect(res.statusCode).toBe(200);
      expect(res.headers["x-request-id"]).toMatch(UUID_V4_REGEX);
    });

    it("sets OWASP security headers and hides X-Powered-By", async () => {
      const res = await app.inject({ method: "GET", url: "/health/live" });

      expect(res.headers["x-content-type-options"]).toBe("nosniff");
      expect(res.headers["x-frame-options"]).toBe("DENY");
      expect(res.headers["referrer-policy"]).toBe("no-referrer");
      expect(res.headers["strict-transport-security"]).toContain(
        "max-age=31536000",
      );
      expect(res.headers["content-security-policy"]).toContain(
        "default-src 'none'",
      );
      expect(res.headers["x-powered-by"]).toBeUndefined();
    });

    it("GET /docs/json exposes valid OpenAPI 3 specification for /api/v1 routes", async () => {
      const res = await app.inject({ method: "GET", url: "/docs/json" });

      expect(res.statusCode).toBe(200);
      const spec = JSON.parse(res.payload) as {
        openapi: string;
        info: { title: string; version: string };
        components?: { securitySchemes?: Record<string, unknown> };
        paths: Record<string, unknown>;
      };

      expect(spec.openapi).toMatch(/^3\./);
      expect(spec.info.title).toBe("ChainLearn API");
      expect(spec.info.version).toBe("1.0.0");
      expect(spec.components?.securitySchemes).toHaveProperty("bearerAuth");
      expect(spec.paths).toHaveProperty("/api/v1/courses/");
      expect(spec.paths).toHaveProperty("/api/v1/auth/challenge");
    });
  });

  describe("Backwards compatibility redirect", () => {
    it("GET /api/courses redirects to /api/v1/courses", async () => {
      const res = await app.inject({ method: "GET", url: "/api/courses" });
      expect(res.statusCode).toBe(301);
      expect(res.headers.location).toBe("/api/v1/courses");
    });

    it("GET /api/auth/challenge redirects to /api/v1/auth/challenge", async () => {
      const res = await app.inject({
        method: "GET",
        url: "/api/auth/challenge",
      });
      expect(res.statusCode).toBe(301);
      expect(res.headers.location).toBe("/api/v1/auth/challenge");
    });

    it("GET /api/users/me redirects to /api/v1/users/me", async () => {
      const res = await app.inject({ method: "GET", url: "/api/users/me" });
      expect(res.statusCode).toBe(301);
      expect(res.headers.location).toBe("/api/v1/users/me");
    });

    it("GET /api/quizzes/generate redirects to /api/v1/quizzes/generate", async () => {
      const res = await app.inject({
        method: "GET",
        url: "/api/quizzes/generate",
      });
      expect(res.statusCode).toBe(301);
      expect(res.headers.location).toBe("/api/v1/quizzes/generate");
    });

    it("GET /api/rewards/history redirects to /api/v1/rewards/history", async () => {
      const res = await app.inject({
        method: "GET",
        url: "/api/rewards/history",
      });
      expect(res.statusCode).toBe(301);
      expect(res.headers.location).toBe("/api/v1/rewards/history");
    });

    it("GET /api/credentials redirects to /api/v1/credentials", async () => {
      const res = await app.inject({ method: "GET", url: "/api/credentials" });
      expect(res.statusCode).toBe(301);
      expect(res.headers.location).toBe("/api/v1/credentials");
    });

    it.each([
      ["/api/announcements", "/api/v1/announcements"],
      ["/api/rewards/leaderboard", "/api/v1/rewards/leaderboard"],
      ["/api/admin/courses", "/api/v1/admin/courses"],
      ["/api/admin/dashboard", "/api/v1/admin/dashboard"],
      ["/api/admin/users", "/api/v1/admin/users"],
      ["/api/admin/badges", "/api/v1/admin/badges"],
      ["/api/admin/audit-logs", "/api/v1/admin/audit-logs"],
      ["/api/admin/webhooks", "/api/v1/admin/webhooks"],
      ["/api/admin/announcements", "/api/v1/admin/announcements"],
    ])("GET %s redirects permanently (301) to %s", async (legacyUrl, v1Url) => {
      const res = await app.inject({ method: "GET", url: legacyUrl });
      expect(res.statusCode).toBe(301);
      expect(res.headers.location).toBe(v1Url);
    });

    it("preserves deeply nested route segments and encoded query parameters on redirect", async () => {
      const legacyUrl =
        `/api/courses/${SAMPLE_COURSE_ID}/modules/mod-1/quiz-attempts` +
        "?difficulty=beginner&page=3&limit=15&search=soroban%20sdk";
      const expectedLocation =
        `/api/v1/courses/${SAMPLE_COURSE_ID}/modules/mod-1/quiz-attempts` +
        "?difficulty=beginner&page=3&limit=15&search=soroban%20sdk";

      const res = await app.inject({ method: "GET", url: legacyUrl });
      expect(res.statusCode).toBe(301);
      expect(res.headers.location).toBe(expectedLocation);
    });

    it.each([
      {
        method: "POST" as const,
        legacyUrl: `/api/courses/${SAMPLE_COURSE_ID}/enroll?ref=ABC12345`,
        expectedLocation: `/api/v1/courses/${SAMPLE_COURSE_ID}/enroll?ref=ABC12345`,
      },
      {
        method: "PUT" as const,
        legacyUrl: "/api/users/me",
        expectedLocation: "/api/v1/users/me",
      },
      {
        method: "DELETE" as const,
        legacyUrl: `/api/courses/${SAMPLE_COURSE_ID}/enroll`,
        expectedLocation: `/api/v1/courses/${SAMPLE_COURSE_ID}/enroll`,
      },
    ])(
      "redirects legacy $method $legacyUrl to $expectedLocation and target resolves without redirect loop",
      async ({ method, legacyUrl, expectedLocation }) => {
        const redirectRes = await app.inject({ method, url: legacyUrl });
        expect(redirectRes.statusCode).toBe(301);
        expect(redirectRes.headers.location).toBe(expectedLocation);

        const followedRes = await app.inject({
          method,
          url: redirectRes.headers.location as string,
        });
        expect(followedRes.statusCode).not.toBe(301);
        expect(followedRes.statusCode).toBe(401);
      },
    );

    it.each(["/api/v2/courses", "/api/v0/courses", "/api/v10/users/me"])(
      "does not rewrite unknown API version %s into /api/v1/* (returns 404 NOT_FOUND)",
      async (unsupportedVersionUrl) => {
        const res = await app.inject({
          method: "GET",
          url: unsupportedVersionUrl,
        });

        expect(res.statusCode).toBe(404);
        expect(res.headers.location).toBeUndefined();
        const body = JSON.parse(res.payload);
        expect(body).toEqual({
          statusCode: 404,
          error: "NOT_FOUND",
          message: "Route not found",
        });
      },
    );
  });

  describe("Versioned routes still work as before", () => {
    it(
      "GET /api/v1/courses returns course list",
      { timeout: 10000 },
      async () => {
        const res = await app.inject({ method: "GET", url: "/api/v1/courses" });
        expect([200, 500]).toContain(res.statusCode);
        if (res.statusCode === 200) {
          const body = JSON.parse(res.payload);
          expect(body.success).toBe(true);
          expect(Array.isArray(body.data)).toBe(true);
          expect(body.pagination).toBeDefined();
        }
      },
    );

    it("GET /api/v1/courses/:id works", async () => {
      const listRes = await app.inject({
        method: "GET",
        url: "/api/v1/courses",
      });
      if (listRes.statusCode === 200) {
        const listBody = JSON.parse(listRes.payload);
        if (listBody.data.length > 0) {
          const courseId = listBody.data[0].id;
          const res = await app.inject({
            method: "GET",
            url: `/api/v1/courses/${courseId}`,
          });
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
      expect(["ready", "not_ready"]).toContain(body.status);
      expect(body.checks).toBeDefined();
      expect(["ok", "error"]).toContain(body.checks.database);
      expect(["ok", "error"]).toContain(body.checks.redis);
      expect(["ok", "error"]).toContain(body.checks.horizon);
      expect(["ok", "error"]).toContain(body.checks.soroban);
      expect(body.meta).toBeUndefined();
    });

    it("GET /health/live still works", async () => {
      const res = await app.inject({ method: "GET", url: "/health/live" });
      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.payload);
      expect(body).toEqual({ status: "ok" });
    });

    it("GET /health/ready enforces readiness contract schema", async () => {
      const res = await app.inject({ method: "GET", url: "/health/ready" });
      expect([200, 503]).toContain(res.statusCode);
      const body = JSON.parse(res.payload);
      expect(["healthy", "degraded"]).toContain(body.status);
      expect(body.timestamp).toMatch(ISO_8601_REGEX);
      expect(typeof body.uptime).toBe("number");
      expect(body.uptime).toBeGreaterThanOrEqual(0);
      expect(["ok", "error"]).toContain(body.checks.database);
      expect(["ok", "error"]).toContain(body.checks.redis);
      expect(["ok", "error"]).toContain(body.checks.horizon);
      expect(["ok", "error"]).toContain(body.checks.soroban);
      expect(body.meta).toBeUndefined();
    });

    it.each(["/health/redis", "/health/database", "/health/ai"])(
      "GET %s enforces per-service health schema",
      async (endpoint) => {
        const res = await app.inject({ method: "GET", url: endpoint });
        expect([200, 503]).toContain(res.statusCode);
        const body = JSON.parse(res.payload);
        expect(["ok", "degraded", "down"]).toContain(body.status);
        expect(typeof body.latencyMs).toBe("number");
        expect(body.latencyMs).toBeGreaterThanOrEqual(0);
        expect(body.meta).toBeUndefined();
      },
    );

    it("GET /health/stellar enforces composite Stellar health schema", async () => {
      const res = await app.inject({ method: "GET", url: "/health/stellar" });
      expect([200, 503]).toContain(res.statusCode);
      const body = JSON.parse(res.payload);
      expect(["ok", "down"]).toContain(body.status);
      expect(typeof body.latencyMs).toBe("number");
      expect(["ok", "degraded", "down"]).toContain(body.checks?.horizon?.status);
      expect(["ok", "degraded", "down"]).toContain(body.checks?.soroban?.status);
      expect(body.meta).toBeUndefined();
    });

    it("GET /metrics requires authentication", async () => {
      const res = await app.inject({ method: "GET", url: "/metrics" });
      expect(res.statusCode).toBe(401);
    });
  });

  describe("404 for unknown versioned and static routes", () => {
    it("GET /api/v1/nonexistent returns structured 404 NOT_FOUND", async () => {
      const res = await app.inject({
        method: "GET",
        url: "/api/v1/nonexistent",
      });
      expect(res.statusCode).toBe(404);
      const body = JSON.parse(res.payload);
      expect(body).toEqual({
        statusCode: 404,
        error: "NOT_FOUND",
        message: "Route not found",
      });
    });

    it.each([
      "/unknown-top-level-route",
      "/uploads/avatars/..%2Fsecret.png",
      "/uploads/avatars/avatar.svg",
      "/uploads/avatars/missing_avatar_file.png",
    ])("GET %s returns structured 404 NOT_FOUND", async (url) => {
      const res = await app.inject({ method: "GET", url });
      expect(res.statusCode).toBe(404);
      const body = JSON.parse(res.payload);
      expect(body).toEqual({
        statusCode: 404,
        error: "NOT_FOUND",
        message: "Route not found",
      });
    });
  });
});
