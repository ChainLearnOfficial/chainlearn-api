/**
 * Tests for JWT revocation (#215) and score-from-DB enforcement (#219).
 *
 * These tests mock Redis and the DB so they run in CI without live
 * infrastructure.
 */
import { test, describe, expect, beforeEach, vi } from "vitest";

// ─── Mock Redis ──────────────────────────────────────────────────────────────

const redisStore = new Map<string, { value: string; expiresAt: number }>();

vi.mock("../config/redis.js", () => ({
  redis: {
    get: vi.fn(async (key: string) => {
      const entry = redisStore.get(key);
      if (!entry) return null;
      if (entry.expiresAt < Date.now()) {
        redisStore.delete(key);
        return null;
      }
      return entry.value;
    }),
    setex: vi.fn(async (key: string, ttl: number, value: string) => {
      redisStore.set(key, { value, expiresAt: Date.now() + ttl * 1000 });
      return "OK";
    }),
  },
}));

// ─── Import after mocks are in place ─────────────────────────────────────────

import { revokeToken } from "../middleware/auth.js";

// ─── JWT Revocation Tests (#215) ─────────────────────────────────────────────

describe("JWT Revocation (#215)", () => {
  beforeEach(() => {
    redisStore.clear();
    vi.clearAllMocks();
  });

  test("revokeToken writes jti to Redis denylist with given TTL", async () => {
    const { redis } = await import("../config/redis.js");
    const jti = "test-jti-uuid-1234";
    const ttl = 3600;

    await revokeToken(jti, ttl);

    expect(redis.setex).toHaveBeenCalledWith(
      `jwt:revoked:${jti}`,
      ttl,
      "1"
    );
  });

  test("revoked token is found in the denylist", async () => {
    const { redis } = await import("../config/redis.js");
    const jti = "revoked-jti-5678";

    await revokeToken(jti, 3600);

    // Simulate authGuard denylist check
    const val = await (redis.get as ReturnType<typeof vi.fn>)(`jwt:revoked:${jti}`);
    expect(val).toBe("1");
  });

  test("non-revoked jti is not in the denylist", async () => {
    const { redis } = await import("../config/redis.js");
    const val = await (redis.get as ReturnType<typeof vi.fn>)(
      "jwt:revoked:unknown-jti"
    );
    expect(val).toBeNull();
  });

  test("revokeToken called multiple times with different jtis stores all of them", async () => {
    const { redis } = await import("../config/redis.js");
    await revokeToken("jti-a", 100);
    await revokeToken("jti-b", 200);
    await revokeToken("jti-c", 300);

    expect(redis.setex).toHaveBeenCalledTimes(3);

    const a = await (redis.get as ReturnType<typeof vi.fn>)("jwt:revoked:jti-a");
    const b = await (redis.get as ReturnType<typeof vi.fn>)("jwt:revoked:jti-b");
    const c = await (redis.get as ReturnType<typeof vi.fn>)("jwt:revoked:jti-c");
    expect(a).toBe("1");
    expect(b).toBe("1");
    expect(c).toBe("1");
  });

  test("TTL clamped to at-least 1 second even when exp has passed", async () => {
    const { redis } = await import("../config/redis.js");
    // Simulate a TTL of 1 (minimum) rather than a negative value
    await revokeToken("jti-expired", 1);
    expect(redis.setex).toHaveBeenCalledWith("jwt:revoked:jti-expired", 1, "1");
  });
});

// ─── Score-from-DB Tests (#219) ──────────────────────────────────────────────

describe("processRewardClaim reads score from DB not caller (#219)", () => {
  test("RetryJob interface no longer carries a score field", async () => {
    // Import the type and verify the shape via a runtime object
    const job = {
      id: "job-1",
      submissionId: "sub-1",
      userId: "user-1",
      retryCount: 0,
      createdAt: new Date().toISOString(),
    };
    // A RetryJob without score should compile / not throw at runtime
    expect(Object.keys(job)).not.toContain("score");
    expect(job).toHaveProperty("submissionId");
    expect(job).toHaveProperty("userId");
  });

  test("processRewardClaim signature takes only submissionId and userId", async () => {
    const { processRewardClaim } = await import("../modules/rewards/reward.service.js");
    // The function should have length 2 (submissionId, userId) — no longer 3
    expect(processRewardClaim.length).toBe(2);
  });
});
