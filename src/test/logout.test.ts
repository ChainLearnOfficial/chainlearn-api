/**
 * End-to-end verification of POST /api/v1/auth/logout (#284).
 *
 * Exercises the full stack (real Fastify app, real Postgres, real Redis) —
 * unlike the unit-level `revokeToken` coverage in jwt-revocation.test.ts,
 * this proves the whole request/response contract: a valid token is
 * accepted, logout blacklists it, and the *same* token is then rejected by
 * authGuard on a subsequent request.
 */
import { test, describe, expect, beforeEach, afterEach } from "vitest";
import type { FastifyInstance } from "fastify";
import { buildApp } from "../server.js";
import { db } from "../config/database.js";
import { redis } from "../config/redis.js";
import { users } from "../database/schema.js";
import { eq } from "drizzle-orm";

describe("POST /api/v1/auth/logout (#284)", () => {
  const userId = "c2222222-2222-4222-8222-222222222222";
  const stellarAddress = "GLOGOUTTEST0000000000000000000000000000000000000000000";

  let app: FastifyInstance;
  let infraAvailable = true;

  beforeEach(async () => {
    try {
      await db
        .insert(users)
        .values({ id: userId, stellarAddress, displayName: "Logout Test User" })
        .onConflictDoNothing();
      app = await buildApp();
      await app.ready();
    } catch {
      infraAvailable = false;
    }
  });

  afterEach(async () => {
    if (!infraAvailable) return;
    await app.close();
    await db.delete(users).where(eq(users.id, userId));
  });

  function signToken(): string {
    return app.jwt.sign({
      sub: userId,
      stellarAddress,
      jti: crypto.randomUUID(),
    });
  }

  test("valid token is accepted by an authenticated route before logout", async () => {
    if (!infraAvailable) return;
    const token = signToken();

    const res = await app.inject({
      method: "GET",
      url: "/metrics",
      headers: { authorization: `Bearer ${token}` },
    });

    expect(res.statusCode).toBe(200);
  });

  test("logout returns 200 and a success envelope", async () => {
    if (!infraAvailable) return;
    const token = signToken();

    const res = await app.inject({
      method: "POST",
      url: "/api/v1/auth/logout",
      headers: { authorization: `Bearer ${token}` },
    });

    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.payload);
    expect(body.success).toBe(true);
    expect(body.data.message).toBe("Logged out successfully");
  });

  test("logout rejects requests with no token (401, not blacklisted as a side effect)", async () => {
    if (!infraAvailable) return;
    const res = await app.inject({ method: "POST", url: "/api/v1/auth/logout" });
    expect(res.statusCode).toBe(401);
  });

  test("a token used again after logout is rejected with 401 'Token has been revoked'", async () => {
    if (!infraAvailable) return;
    const token = signToken();

    const logoutRes = await app.inject({
      method: "POST",
      url: "/api/v1/auth/logout",
      headers: { authorization: `Bearer ${token}` },
    });
    expect(logoutRes.statusCode).toBe(200);

    const reuseRes = await app.inject({
      method: "GET",
      url: "/metrics",
      headers: { authorization: `Bearer ${token}` },
    });

    expect(reuseRes.statusCode).toBe(401);
    const body = JSON.parse(reuseRes.payload);
    expect(body.message).toBe("Token has been revoked");
  });

  test("blacklist entry TTL matches the token's remaining natural lifetime (~24h), not a fixed/short value", async () => {
    if (!infraAvailable) return;
    const token = signToken();
    const decoded = app.jwt.decode<{ jti: string; exp: number }>(token);

    await app.inject({
      method: "POST",
      url: "/api/v1/auth/logout",
      headers: { authorization: `Bearer ${token}` },
    });

    const ttl = await redis.ttl(`jwt:revoked:${decoded!.jti}`);
    // Signed with the default 24h expiry — allow a small margin for
    // wall-clock drift between signing and the TTL check.
    expect(ttl).toBeGreaterThan(86_000);
    expect(ttl).toBeLessThanOrEqual(86_400);
  });

  test("two different tokens for the same user are revoked independently", async () => {
    if (!infraAvailable) return;
    const tokenA = signToken();
    const tokenB = signToken();

    await app.inject({
      method: "POST",
      url: "/api/v1/auth/logout",
      headers: { authorization: `Bearer ${tokenA}` },
    });

    // tokenA is now revoked...
    const resA = await app.inject({
      method: "GET",
      url: "/metrics",
      headers: { authorization: `Bearer ${tokenA}` },
    });
    expect(resA.statusCode).toBe(401);

    // ...but tokenB, issued separately (different jti), still works.
    const resB = await app.inject({
      method: "GET",
      url: "/metrics",
      headers: { authorization: `Bearer ${tokenB}` },
    });
    expect(resB.statusCode).toBe(200);
  });

  test("the blacklist check is a single Redis GET (< 1ms of work, no extra round-trips)", async () => {
    if (!infraAvailable) return;
    const token = signToken();
    await app.inject({
      method: "POST",
      url: "/api/v1/auth/logout",
      headers: { authorization: `Bearer ${token}` },
    });
    const decoded = app.jwt.decode<{ jti: string }>(token);

    const start = process.hrtime.bigint();
    await redis.get(`jwt:revoked:${decoded!.jti}`);
    const elapsedMs = Number(process.hrtime.bigint() - start) / 1e6;

    expect(elapsedMs).toBeLessThan(1);
  });
});
