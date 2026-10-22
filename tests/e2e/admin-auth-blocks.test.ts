import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { eq } from "drizzle-orm";
import { buildApp } from "../../src/server.js";
import { db } from "../../src/config/database.js";
import { redis } from "../../src/config/redis.js";
import { users } from "../../src/database/schema.js";

describe("Admin auth blocks E2E API (#661)", () => {
  let app: FastifyInstance;

  const adminUserId = "a6610000-0000-4000-8000-000000000001";
  const adminAddress = "GADMINAUTHBLOCKS0000000000000000000000000000000000000000".slice(0, 56);
  const learnerUserId = "a6610000-0000-4000-8000-000000000002";
  const learnerAddress = "GUSERAUTHBLOCKS00000000000000000000000000000000000000000".slice(0, 56);
  const listedIp = "203.0.113.61";
  const injectedIp = "127.0.0.1";
  const blockKey = (ip: string) => `auth:block:${ip}`;

  beforeAll(async () => {
    app = await buildApp();
    await app.ready();

    await db
      .insert(users)
      .values({ id: adminUserId, stellarAddress: adminAddress, displayName: "Auth Block Admin", isAdmin: true })
      .onConflictDoNothing();
    await db
      .insert(users)
      .values({ id: learnerUserId, stellarAddress: learnerAddress, displayName: "Auth Block Learner", isAdmin: false })
      .onConflictDoNothing();
  });

  afterAll(async () => {
    await redis.del(blockKey(listedIp), blockKey(injectedIp));
    await db.delete(users).where(eq(users.id, adminUserId));
    await db.delete(users).where(eq(users.id, learnerUserId));
    await app.close();
  });

  const adminHeaders = () => ({
    authorization: `Bearer ${app.jwt.sign({ sub: adminUserId, stellarAddress: adminAddress })}`,
  });
  const learnerHeaders = () => ({
    authorization: `Bearer ${app.jwt.sign({ sub: learnerUserId, stellarAddress: learnerAddress })}`,
  });

  it("requires an authenticated admin to list or clear blocked IPs", async () => {
    const unauthenticated = await app.inject({ method: "GET", url: "/admin/auth-blocks" });
    expect(unauthenticated.statusCode).toBe(401);

    const learnerList = await app.inject({ method: "GET", url: "/admin/auth-blocks", headers: learnerHeaders() });
    expect(learnerList.statusCode).toBe(403);

    const learnerClear = await app.inject({ method: "DELETE", url: `/admin/auth-blocks/${listedIp}`, headers: learnerHeaders() });
    expect(learnerClear.statusCode).toBe(403);
  });

  it("lists active IP blocks and clears a selected block", async () => {
    await redis.setex(blockKey(listedIp), 120, "1");

    const listResponse = await app.inject({ method: "GET", url: "/admin/auth-blocks", headers: adminHeaders() });
    expect(listResponse.statusCode).toBe(200);
    const { blocks } = listResponse.json<{ blocks: Array<{ ip: string; ttl: number }> }>();
    expect(blocks).toEqual(expect.arrayContaining([expect.objectContaining({ ip: listedIp })]));
    expect(blocks.find((block) => block.ip === listedIp)?.ttl).toBeGreaterThan(0);

    const clearResponse = await app.inject({ method: "DELETE", url: `/admin/auth-blocks/${listedIp}`, headers: adminHeaders() });
    expect(clearResponse.statusCode).toBe(200);
    expect(clearResponse.json()).toEqual({ cleared: true });
    expect(await redis.get(blockKey(listedIp))).toBeNull();
  });

  it("blocks authentication requests from a blocked IP and allows them after an admin clears it", async () => {
    await redis.setex(blockKey(injectedIp), 120, "1");
    const verifyRequest = {
      method: "POST" as const,
      url: "/api/v1/auth/verify",
      payload: {
        stellarAddress: "GTEST00000000000000000000000000000000000000000000000000",
        challengeId: "a6610000-0000-4000-8000-000000000003",
        signedChallenge: "invalid-signature",
      },
    };

    const blocked = await app.inject(verifyRequest);
    expect(blocked.statusCode).toBe(429);
    expect(Number(blocked.headers["retry-after"])).toBeGreaterThan(0);

    const clear = await app.inject({
      method: "DELETE",
      url: `/admin/auth-blocks/${injectedIp}`,
      headers: adminHeaders(),
    });
    expect(clear.statusCode).toBe(200);

    const allowedThroughBlockCheck = await app.inject(verifyRequest);
    expect(allowedThroughBlockCheck.statusCode).not.toBe(429);
    expect(allowedThroughBlockCheck.statusCode).toBe(401);
  });
});
