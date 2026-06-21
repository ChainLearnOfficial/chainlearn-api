import { describe, it, expect, vi, beforeEach } from "vitest";
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

  beforeEach(() => {
    vi.resetAllMocks();
    sequenceCache.invalidate(accountId);
  });

  it("loads sequence from Horizon on first call and caches it", async () => {
    vi.mocked(stellarClient.getAccount).mockResolvedValueOnce({ sequence: "41" } as any);

    const seq1 = await sequenceCache.getNextSequence(accountId);
    expect(seq1).toBe("41");

    const seq2 = await sequenceCache.getNextSequence(accountId);
    expect(seq2).toBe("42"); // 41 + 1

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

    // Verify sequences are monotonic (100, 101, ..., 109)
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
              sequenceCache.invalidate(accountId);
              continue;
            }
            throw err;
          }
        }
      });
    };

    const finalSeq = await simulateTxSubmit();
    
    // First attempt got 100, failed with bad_seq, cache invalidated.
    // Second attempt hit Horizon, got 105, returned 105.
    expect(finalSeq).toBe("105");
    expect(stellarClient.getAccount).toHaveBeenCalledTimes(2);
  });
});
