/**
 * #275 — HTTP-path coverage for the refresh flow.
 *
 * buildApp() can't be used here (pre-existing Fastify v5 `logger` vs
 * `loggerInstance` bug in src/server.ts breaks every e2e suite), so this
 * stands up a minimal Fastify app with the real @fastify/jwt plugin, the
 * real error handler and the real authRoutes, and drives it over
 * app.inject(). Redis and the SEP-10 verify step are stubbed; everything
 * from route → validation → controller → refresh-token.service is real.
 *
 * The equivalent full-stack assertions are also added to
 * tests/e2e/auth.test.ts for when that suite is unblocked.
 */
import { describe, it, expect, beforeEach, vi } from "vitest";
import Fastify, { type FastifyInstance } from "fastify";
import fastifyJwt from "@fastify/jwt";

const store = new Map<string, string>();

vi.mock("../../../src/config/redis.js", () => ({
  redis: {
    setex: vi.fn(async (key: string, _ttl: number, value: string) => {
      store.set(key, value);
      return "OK";
    }),
    get: vi.fn(async (key: string) => store.get(key) ?? null),
    getdel: vi.fn(async (key: string) => {
      const value = store.get(key) ?? null;
      store.delete(key);
      return value;
    }),
  },
}));

const { findFirst } = vi.hoisted(() => ({ findFirst: vi.fn() }));
vi.mock("../../../src/config/database.js", () => ({
  db: { query: { users: { findFirst } } },
}));

vi.mock("../../../src/utils/logger.js", () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

vi.mock("../../../src/modules/auth/auth.service.js", () => ({
  authService: { verifyChallenge: vi.fn() },
}));

import { authRoutes } from "../../../src/modules/auth/auth.routes.js";
import { registerErrorHandler } from "../../../src/middleware/error-handler.js";
import { authService } from "../../../src/modules/auth/auth.service.js";

const USER = {
  id: "33333333-3333-4333-8333-333333333333",
  // 56-char, G-prefixed — satisfies verifySchema's shape checks.
  stellarAddress: "G" + "A".repeat(55),
  displayName: null,
  isNewUser: false,
};

const VERIFY_BODY = {
  stellarAddress: USER.stellarAddress,
  challengeId: "b2f6c271-11a3-4b92-b60d-8848db490a22",
  signedChallenge: "signed-challenge-envelope",
};

async function buildTestApp(): Promise<FastifyInstance> {
  const app = Fastify({ logger: false });
  await app.register(fastifyJwt, {
    secret: "test-secret-key-that-is-at-least-64-characters-long-for-testing-only",
    sign: { expiresIn: "24h" },
  });
  registerErrorHandler(app);
  await app.register(authRoutes, { prefix: "/api/v1/auth" });
  await app.ready();
  return app;
}

describe("POST /api/v1/auth/refresh (#275)", () => {
  let app: FastifyInstance;

  beforeEach(async () => {
    store.clear();
    vi.clearAllMocks();
    vi.mocked(authService.verifyChallenge).mockResolvedValue({
      token: "",
      user: USER,
    });
    // authGuard (on /logout) re-fetches the user row.
    findFirst.mockResolvedValue({
      id: USER.id,
      stellarAddress: USER.stellarAddress,
      deletedAt: null,
      bannedAt: null,
    });
    app = await buildTestApp();
  });

  async function login(): Promise<{ token: string; refreshToken: string }> {
    const res = await app.inject({
      method: "POST",
      url: "/api/v1/auth/verify",
      payload: VERIFY_BODY,
    });
    expect(res.statusCode).toBe(200);
    return JSON.parse(res.payload).data;
  }

  it("verify issues an access token and a refresh token together", async () => {
    const data = await login();
    expect(typeof data.token).toBe("string");
    expect(data.token).toContain("."); // JWT: header.payload.signature
    expect(typeof data.refreshToken).toBe("string");
    expect(data.refreshToken.length).toBeGreaterThan(20);
  });

  it("refresh returns a new access token and rotates the refresh token", async () => {
    const first = await login();

    const res = await app.inject({
      method: "POST",
      url: "/api/v1/auth/refresh",
      payload: { refreshToken: first.refreshToken },
    });

    expect(res.statusCode).toBe(200);
    const data = JSON.parse(res.payload).data;
    expect(typeof data.token).toBe("string");
    expect(data.token).toContain(".");
    expect(data.refreshToken).toBeTypeOf("string");
    expect(data.refreshToken).not.toBe(first.refreshToken);
  });

  it("a refresh token is single-use — replay is rejected", async () => {
    const first = await login();

    const ok = await app.inject({
      method: "POST",
      url: "/api/v1/auth/refresh",
      payload: { refreshToken: first.refreshToken },
    });
    expect(ok.statusCode).toBe(200);

    const replay = await app.inject({
      method: "POST",
      url: "/api/v1/auth/refresh",
      payload: { refreshToken: first.refreshToken },
    });
    expect(replay.statusCode).toBe(401);
  });

  it("replaying a rotated token revokes the whole family", async () => {
    const first = await login();

    const rotated = JSON.parse(
      (
        await app.inject({
          method: "POST",
          url: "/api/v1/auth/refresh",
          payload: { refreshToken: first.refreshToken },
        })
      ).payload,
    ).data;

    // Attacker replays the stolen original.
    await app.inject({
      method: "POST",
      url: "/api/v1/auth/refresh",
      payload: { refreshToken: first.refreshToken },
    });

    // The legitimate, never-used rotated token is now dead too.
    const afterBurn = await app.inject({
      method: "POST",
      url: "/api/v1/auth/refresh",
      payload: { refreshToken: rotated.refreshToken },
    });
    expect(afterBurn.statusCode).toBe(401);
  });

  it("rejects an unknown refresh token with 401", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/api/v1/auth/refresh",
      payload: { refreshToken: "not-a-real-token" },
    });
    expect(res.statusCode).toBe(401);
  });

  it("rejects a missing refresh token with 400", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/api/v1/auth/refresh",
      payload: {},
    });
    expect(res.statusCode).toBe(400);
  });

  it("logout still works with only the Authorization header (no body)", async () => {
    const { token } = await login();
    const res = await app.inject({
      method: "POST",
      url: "/api/v1/auth/logout",
      headers: { authorization: `Bearer ${token}` },
    });
    expect(res.statusCode).toBe(200);
  });

  it("logout with the refresh token kills that session's refresh family", async () => {
    const { token, refreshToken } = await login();

    const res = await app.inject({
      method: "POST",
      url: "/api/v1/auth/logout",
      headers: { authorization: `Bearer ${token}` },
      payload: { refreshToken },
    });
    expect(res.statusCode).toBe(200);

    const afterLogout = await app.inject({
      method: "POST",
      url: "/api/v1/auth/refresh",
      payload: { refreshToken },
    });
    expect(afterLogout.statusCode).toBe(401);
  });
});
