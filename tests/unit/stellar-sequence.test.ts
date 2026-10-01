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

    // After the fix: cache-miss returns the *current* sequence (41), not 42.
    // Callers pass this to `new Account(publicKey, 41)` and TransactionBuilder
    // builds the transaction with sequence 42 — correct for account at seq 41.
    const seq1 = await sequenceCache.getNextSequence(accountId);
    expect(seq1).toBe("41");

    // Subsequent calls hit the cache; INCR produces the next usable value.
    const seq2 = await sequenceCache.getNextSequence(accountId);
    expect(seq2).toBe("42");

    expect(stellarClient.getAccount).toHaveBeenCalledTimes(1);
  });

  it("cache-miss returns on-chain sequence (not seq+1) — regression for #206", async () => {
    vi.mocked(stellarClient.getAccount).mockResolvedValueOnce({ sequence: "999" } as any);

    const seq = await sequenceCache.getNextSequence(accountId);

    // Must equal the account sequence from Horizon — NOT 1000.
    // Account(publicKey, 999) → TransactionBuilder → tx sequence 1000 ✓
    expect(seq).toBe("999");
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

    // Sequences must be monotonic starting from the on-chain value (100).
    // First call returns 100 (current); subsequent calls increment from there.
    expect(sequences).toEqual([
      "100",
      "101",
      "102",
      "103",
      "104",
      "105",
      "106",
      "107",
      "108",
      "109",
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

    // First attempt: cache miss → Horizon gives 100 → return 100 (seq, not seq+1).
    // That attempt throws bad_seq → cache invalidated.
    // Second attempt: cache miss again → Horizon gives 105 → return 105.
    expect(finalSeq).toBe("105");
    expect(stellarClient.getAccount).toHaveBeenCalledTimes(2);
  });

  it("re-syncs with Horizon after the cache entry expires (TTL)", async () => {
    const { redis } = await import("../../src/config/redis.js");

    vi.mocked(stellarClient.getAccount).mockResolvedValueOnce({ sequence: "200" } as any);
    const seq1 = await sequenceCache.getNextSequence(accountId);
    expect(seq1).toBe("200");

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
    expect(seq2).toBe("999");
    expect(stellarClient.getAccount).toHaveBeenCalledTimes(2);
  });

  it("shares the cached sequence across separate SequenceCache instances (multi-process safety)", async () => {
    const { SequenceCache } = await import("../../src/stellar/sequence-cache.js");
    const otherInstance = new SequenceCache();

    vi.mocked(stellarClient.getAccount).mockResolvedValueOnce({ sequence: "500" } as any);

    // First instance: cache miss → Horizon gives 500 → seed 500, return 500.
    const seqFromFirst = await sequenceCache.getNextSequence(accountId);
    expect(seqFromFirst).toBe("500");

    // Second instance: cache hit → INCR 500 → 501.
    const seqFromSecond = await otherInstance.getNextSequence(accountId);
    expect(seqFromSecond).toBe("501");
    expect(stellarClient.getAccount).toHaveBeenCalledTimes(1);
  });
});
