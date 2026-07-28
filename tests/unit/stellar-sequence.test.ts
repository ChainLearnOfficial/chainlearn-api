import { describe, it, expect, vi, beforeEach } from "vitest";

// Fake Redis that implements just enough of the real command semantics
// (EXISTS/INCR/EXPIRE via a Lua script, SET NX/EX, DEL) for the sequence
// cache's atomic scripts to behave the same way the real server would.
vi.mock("../../src/config/redis.js", () => {
  const store = new Map<string, string>();
  return {
    redis: {
      eval: vi.fn(async (script: string, _numKeys: number, key: string, ...args: unknown[]) => {
        if (script.includes("EXISTS")) {
          if (!store.has(key)) return null;
          const next = (BigInt(store.get(key)!) + 1n).toString();
          store.set(key, next);
          return next;
        }
        // Seed-and-increment script: SET NX, falling back to INCR.
        const seedValue = String(args[1]);
        if (!store.has(key)) {
          store.set(key, seedValue);
          return seedValue;
        }
        const next = (BigInt(store.get(key)!) + 1n).toString();
        store.set(key, next);
        return next;
      }),
      del: vi.fn(async (key: string) => {
        const existed = store.delete(key);
        return existed ? 1 : 0;
      }),
      set: vi.fn(async (key: string, value: string) => {
        store.set(key, String(value));
        return "OK";
      }),
    },
  };
});

import { sequenceCache } from "../../src/stellar/sequence-cache.js";
import { stellarClient } from "../../src/stellar/client.js";
import { withAccountLock } from "../../src/utils/account-lock.js";
import { StellarError } from "../../src/utils/errors.js";

// Mock the external client so we don't hit real Horizon
vi.mock("../../src/stellar/client.js", () => ({
  stellarClient: {
    getAccount: vi.fn(),
    submitTransaction: vi.fn(),
  },
}));

describe("Stellar Sequence Number Management", () => {
  const accountId = "GBZ5...TEST";

  beforeEach(async () => {
    vi.resetAllMocks();
    await sequenceCache.invalidate(accountId);
  });

  it("loads sequence from Horizon on first call and caches it", async () => {
    vi.mocked(stellarClient.getAccount).mockResolvedValueOnce({ sequence: "41" } as any);

    const seq1 = await sequenceCache.getNextSequence(accountId);
    expect(seq1).toBe("42"); // First call returns seq + 1 (41 + 1 = 42)

    const seq2 = await sequenceCache.getNextSequence(accountId);
    expect(seq2).toBe("43"); // Second call returns 42 + 1 = 43

    expect(stellarClient.getAccount).toHaveBeenCalledTimes(1);
  });

  it("handles 10 concurrent transactions (account lock + monotonic sequence)", async () => {
    // 1. Mock Horizon returning a stale sequence of 100
    vi.mocked(stellarClient.getAccount).mockResolvedValue({ sequence: "100" } as any);

    let activeOperations = 0;
    let maxConcurrent = 0;

    const runTx = async (index: number) => {
      return withAccountLock(accountId, async () => {
        // Track concurrency to verify lock serialization
        activeOperations++;
        maxConcurrent = Math.max(maxConcurrent, activeOperations);

        // Wait a tiny bit to make concurrency overlaps likely if lock didn't work
        await new Promise((r) => setTimeout(r, 10));

        const seq = await sequenceCache.getNextSequence(accountId);

        activeOperations--;
        return seq;
      });
    };

    // Fire 10 transactions concurrently
    const promises = Array.from({ length: 10 }, (_, i) => runTx(i));
    const sequences = await Promise.all(promises);

    // Verify all 10 succeeded
    expect(sequences.length).toBe(10);

    // Verify sequences are monotonic (101, 102, ..., 110)
    expect(sequences).toEqual([
      "101",
      "102",
      "103",
      "104",
      "105",
      "106",
      "107",
      "108",
      "109",
      "110",
    ]);

    // Verify account lock serialization: max concurrent should be exactly 1
    expect(maxConcurrent).toBe(1);

    // Verify Horizon was only hit once
    expect(stellarClient.getAccount).toHaveBeenCalledTimes(1);
  });

  it("retries on bad_seq and invalidates cache", async () => {
    // Mock Horizon returning 100 on first call, 105 on second call
    vi.mocked(stellarClient.getAccount)
      .mockResolvedValueOnce({ sequence: "100" } as any)
      .mockResolvedValueOnce({ sequence: "105" } as any);

    // Simulate an API flow that uses the retry loop mechanism
    let attempt = 0;
    const simulateTxSubmit = async () => {
      return withAccountLock(accountId, async () => {
        for (let i = 0; i < 3; i++) {
          try {
            attempt++;
            const seq = await sequenceCache.getNextSequence(accountId);

            if (attempt === 1) {
              // Simulate submitting with bad sequence
              throw new StellarError("tx failed: [\"tx_bad_seq\"]");
            }

            return seq; // Success
          } catch (err: any) {
            if (err instanceof StellarError && err.message.includes("bad_seq")) {
              await sequenceCache.invalidate(accountId);
              continue;
            }
            throw err;
          }
        }
      });
    };

    const finalSeq = await simulateTxSubmit();

    // First attempt got 101 (100 + 1), failed with bad_seq, cache invalidated.
    // Second attempt hit Horizon, got 105, returned 106 (105 + 1).
    expect(finalSeq).toBe("106");
    expect(stellarClient.getAccount).toHaveBeenCalledTimes(2);
  });

  it("re-syncs with Horizon after the cache entry expires (TTL)", async () => {
    const { redis } = await import("../../src/config/redis.js");

    vi.mocked(stellarClient.getAccount).mockResolvedValueOnce({ sequence: "200" } as any);
    const seq1 = await sequenceCache.getNextSequence(accountId);
    expect(seq1).toBe("201");

    // Every write to the cache must carry a TTL so a stale entry can't live forever.
    const seedCall = vi.mocked(redis.eval).mock.calls.find(([script]) =>
      (script as string).includes("SET")
    );
    expect(seedCall).toBeDefined();
    expect(seedCall![3]).toBeGreaterThan(0); // TTL seconds argument

    // Simulate the entry expiring out of Redis (TTL elapsed).
    await sequenceCache.invalidate(accountId);

    vi.mocked(stellarClient.getAccount).mockResolvedValueOnce({ sequence: "999" } as any);
    const seq2 = await sequenceCache.getNextSequence(accountId);
    expect(seq2).toBe("1000");
    expect(stellarClient.getAccount).toHaveBeenCalledTimes(2);
  });

  it("shares the cached sequence across separate SequenceCache instances (multi-process safety)", async () => {
    const { SequenceCache } = await import("../../src/stellar/sequence-cache.js");
    const otherInstance = new SequenceCache();

    vi.mocked(stellarClient.getAccount).mockResolvedValueOnce({ sequence: "500" } as any);

    const seqFromFirst = await sequenceCache.getNextSequence(accountId);
    expect(seqFromFirst).toBe("501");

    // A second instance (standing in for a second process) must observe the
    // same shared state via Redis rather than loading its own fresh copy.
    const seqFromSecond = await otherInstance.getNextSequence(accountId);
    expect(seqFromSecond).toBe("502");
    expect(stellarClient.getAccount).toHaveBeenCalledTimes(1);
  });
});
