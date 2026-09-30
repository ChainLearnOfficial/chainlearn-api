/**
 * #275 — JWT refresh mechanism (API side).
 *
 * Exercises issuance, rotation, single-use enforcement and reuse-detection
 * in refresh-token.service.ts with an in-memory Redis stub, following the
 * same approach as jwt-revocation.test.ts so it runs without live infra.
 */
import { describe, it, expect, beforeEach, vi } from "vitest";

// ─── In-memory Redis stub ───────────────────────────────────────────────────

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

vi.mock("../../../src/utils/logger.js", () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

// ─── Import after mocks are registered ──────────────────────────────────────

import {
  issueRefreshToken,
  rotateRefreshToken,
  revokeRefreshToken,
  REFRESH_TOKEN_TTL_SECONDS,
} from "../../../src/modules/auth/refresh-token.service.js";
import { UnauthorizedError } from "../../../src/utils/errors.js";

const USER_ID = "11111111-1111-4111-8111-111111111111";
const STELLAR_ADDRESS = "GREFRESHTEST00000000000000000000000000000000000000000";

function activeKeys(): string[] {
  return [...store.keys()].filter((k) => k.startsWith("auth:refresh:active:"));
}

describe("refresh token service (#275)", () => {
  beforeEach(() => {
    store.clear();
    vi.clearAllMocks();
  });

  it("refresh token expiry is 7 days", () => {
    expect(REFRESH_TOKEN_TTL_SECONDS).toBe(7 * 24 * 60 * 60);
    expect(REFRESH_TOKEN_TTL_SECONDS).toBe(604_800);
  });

  it("issues an opaque token that is never stored raw", async () => {
    const issued = await issueRefreshToken(USER_ID, STELLAR_ADDRESS);

    expect(issued.token).toMatch(/^[A-Za-z0-9_-]+$/);
    expect(issued.familyId).toMatch(/^[0-9a-f-]{36}$/);
    expect(activeKeys()).toHaveLength(1);
    // The raw token must not appear anywhere in the Redis keyspace or values.
    for (const [k, v] of store) {
      expect(k).not.toContain(issued.token);
      expect(v).not.toContain(issued.token);
    }
  });

  it("rotates a valid token: returns a new token and the record, old token is dead", async () => {
    const issued = await issueRefreshToken(USER_ID, STELLAR_ADDRESS);

    const { record, next } = await rotateRefreshToken(issued.token);

    expect(record.userId).toBe(USER_ID);
    expect(record.stellarAddress).toBe(STELLAR_ADDRESS);
    expect(next.token).not.toBe(issued.token);
    // Same rotation lineage.
    expect(next.familyId).toBe(issued.familyId);
    // Exactly one active token remains — the replacement.
    expect(activeKeys()).toHaveLength(1);

    // The consumed token can no longer be rotated.
    await expect(rotateRefreshToken(issued.token)).rejects.toBeInstanceOf(
      UnauthorizedError,
    );
  });

  it("is single-use under concurrency: only one of two racing rotations wins", async () => {
    const issued = await issueRefreshToken(USER_ID, STELLAR_ADDRESS);

    const results = await Promise.allSettled([
      rotateRefreshToken(issued.token),
      rotateRefreshToken(issued.token),
    ]);

    const fulfilled = results.filter((r) => r.status === "fulfilled");
    const rejected = results.filter((r) => r.status === "rejected");
    expect(fulfilled).toHaveLength(1);
    expect(rejected).toHaveLength(1);
  });

  it("detects reuse of an already-rotated token and burns the whole family", async () => {
    const issued = await issueRefreshToken(USER_ID, STELLAR_ADDRESS);

    // Legitimate rotation → token2.
    const { next: gen2 } = await rotateRefreshToken(issued.token);
    // Attacker replays the stolen, already-rotated token1.
    await expect(rotateRefreshToken(issued.token)).rejects.toBeInstanceOf(
      UnauthorizedError,
    );

    // token2 — a valid, never-used token in the same family — is now dead too.
    await expect(rotateRefreshToken(gen2.token)).rejects.toThrow(/revoked/i);
  });

  it("rejects an unknown token without revoking anything", async () => {
    // A live, unrelated family that must survive.
    const survivor = await issueRefreshToken(USER_ID, STELLAR_ADDRESS);

    await expect(rotateRefreshToken("not-a-real-token")).rejects.toBeInstanceOf(
      UnauthorizedError,
    );

    // Survivor still rotates fine.
    await expect(rotateRefreshToken(survivor.token)).resolves.toMatchObject({
      record: { familyId: survivor.familyId },
    });
  });

  it("rejects a token whose record has passed its expiry", async () => {
    const issued = await issueRefreshToken(USER_ID, STELLAR_ADDRESS);

    // Age the stored record past expiresAt.
    const [key] = activeKeys();
    const rec = JSON.parse(store.get(key)!);
    rec.expiresAt = Math.floor(Date.now() / 1000) - 1;
    store.set(key, JSON.stringify(rec));

    await expect(rotateRefreshToken(issued.token)).rejects.toBeInstanceOf(
      UnauthorizedError,
    );
  });

  it("revokeRefreshToken (logout) kills the token and its family", async () => {
    const issued = await issueRefreshToken(USER_ID, STELLAR_ADDRESS);
    const { next: gen2 } = await rotateRefreshToken(issued.token);

    await revokeRefreshToken(gen2.token);

    await expect(rotateRefreshToken(gen2.token)).rejects.toBeInstanceOf(
      UnauthorizedError,
    );
  });

  it("revokeRefreshToken is a silent no-op for an unknown token", async () => {
    await expect(revokeRefreshToken("nope")).resolves.toBeUndefined();
  });

  it("carries identity across a multi-step rotation chain", async () => {
    let current = await issueRefreshToken(USER_ID, STELLAR_ADDRESS);
    const familyId = current.familyId;

    for (let i = 0; i < 5; i++) {
      const { record, next } = await rotateRefreshToken(current.token);
      expect(record.userId).toBe(USER_ID);
      expect(record.stellarAddress).toBe(STELLAR_ADDRESS);
      expect(next.familyId).toBe(familyId);
      current = next;
    }

    expect(activeKeys()).toHaveLength(1);
  });
});
