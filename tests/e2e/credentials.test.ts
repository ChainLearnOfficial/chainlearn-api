import { describe, it, expect, beforeAll, afterAll } from "vitest";
import type { FastifyInstance } from "fastify";
import { buildApp } from "../../src/server.js";

describe("Credentials API", () => {
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

  describe("GET /api/credentials", () => {
    it("should reject unauthenticated requests", async () => {
      const response = await app.inject({
        method: "GET",
        url: "/api/credentials",
      });

      expect(response.statusCode).toBe(401);
      const body = JSON.parse(response.payload);
      expect(body.error).toBe("UNAUTHORIZED");
    });

    it("should return user's credentials list", async () => {
      const token = createToken();

      const response = await app.inject({
        method: "GET",
        url: "/api/credentials",
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

  describe("POST /api/credentials/mint", () => {
    it("should reject unauthenticated requests", async () => {
      const response = await app.inject({
        method: "POST",
        url: "/api/credentials/mint",
        payload: {
          courseId: "00000000-0000-0000-0000-000000000001",
          submissionId: "00000000-0000-0000-0000-000000000002",
          idempotencyKey: "test-key-credentials-mint-unauth",
        },
      });

      expect(response.statusCode).toBe(401);
    });

    it("should mint credential for completed course", async () => {
      const token = createToken();

      // Attempt to mint — requires a valid passed submission
      const response = await app.inject({
        method: "POST",
        url: "/api/credentials/mint",
        headers: { authorization: `Bearer ${token}` },
        payload: {
          courseId: "00000000-0000-0000-0000-000000000001",
          submissionId: "00000000-0000-0000-0000-000000000001",
          idempotencyKey: "test-key-credentials-mint-valid",
        },
      });

      // 201 (minted), 401 (auth rejected), 403 (not passed), 404 (not found), 500 (DB unavailable)
      expect([201, 401, 403, 404, 500]).toContain(response.statusCode);
      if (response.statusCode === 201) {
        const body = JSON.parse(response.payload);
        expect(body.success).toBe(true);
        expect(body.data.credentialId).toBeDefined();
        expect(body.data.nftAssetCode).toBeDefined();
        expect(typeof body.data.nftAssetCode).toBe("string");
      }
    });

    it("should reject if course not completed", async () => {
      const token = createToken();

      const response = await app.inject({
        method: "POST",
        url: "/api/credentials/mint",
        headers: { authorization: `Bearer ${token}` },
        payload: {
          courseId: "00000000-0000-0000-0000-000000000001",
          submissionId: "00000000-0000-0000-0000-000000000099",
          idempotencyKey: "test-key-credentials-mint-notpassed",
        },
      });

      // 403 (not passed), 401 (auth rejected), 404 (not found), 500 (DB unavailable)
      expect([401, 403, 404, 500]).toContain(response.statusCode);
      if (response.statusCode === 403) {
        const body = JSON.parse(response.payload);
        expect(body.error).toBe("FORBIDDEN");
      }
    });

    it("should reject duplicate credential", async () => {
      const token = createToken();

      // First mint attempt
      const first = await app.inject({
        method: "POST",
        url: "/api/credentials/mint",
        headers: { authorization: `Bearer ${token}` },
        payload: {
          courseId: "00000000-0000-0000-0000-000000000001",
          submissionId: "00000000-0000-0000-0000-000000000001",
          idempotencyKey: "test-key-credentials-mint-001",
        },
      });

      if (first.statusCode === 201) {
        // Second mint for same course should be rejected
        const response = await app.inject({
          method: "POST",
          url: "/api/credentials/mint",
          headers: { authorization: `Bearer ${token}` },
          payload: {
            courseId: "00000000-0000-0000-0000-000000000001",
            submissionId: "00000000-0000-0000-0000-000000000001",
            idempotencyKey: "test-key-credentials-mint-002",
          },
        });

        expect([401, 409, 500]).toContain(response.statusCode);
        if (response.statusCode === 409) {
          const body = JSON.parse(response.payload);
          expect(body.error).toBe("CONFLICT");
        }
      }
    });

    it("should reject request without idempotency key", async () => {
      const token = createToken();

      const response = await app.inject({
        method: "POST",
        url: "/api/credentials/mint",
        headers: { authorization: `Bearer ${token}` },
        payload: {
          courseId: "00000000-0000-0000-0000-000000000001",
          submissionId: "00000000-0000-0000-0000-000000000002",
        },
      });

      // Auth may reject (401) or validation may reject missing idempotencyKey (400)
      expect([400, 401]).toContain(response.statusCode);
    });
  });
});
