import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("../../../src/config/database.js", () => ({
  db: { select: vi.fn() },
}));

vi.mock("../../../src/utils/logger.js", () => ({
  logger: { info: vi.fn(), error: vi.fn(), warn: vi.fn() },
}));

vi.mock("../../../src/utils/lock.js", () => ({
  withLock: vi.fn(async (_k: string, fn: () => Promise<any>) => fn()),
}));

vi.mock("../../../src/audit/index.js", () => ({ auditLog: vi.fn() }));

const cacheSet = vi.fn().mockResolvedValue(undefined);
vi.mock("../../../src/cache/index.js", () => ({
  cacheGet: vi.fn().mockResolvedValue(null),
  cacheSet: (...a: unknown[]) => cacheSet(...a),
  cacheDel: vi.fn().mockResolvedValue(undefined),
  cacheInvalidatePattern: vi.fn().mockResolvedValue(undefined),
  cacheKey: (...p: (string | number)[]) => p.join(":"),
}));

const getQueuedRewardJobs = vi.fn();
vi.mock("../../../src/services/retry-queue.js", () => ({
  enqueueReward: vi.fn(),
  getQueuedRewardJobs: (...a: unknown[]) => getQueuedRewardJobs(...a),
  estimateProcessingSeconds: (position: number) => (position + 1) * 5,
}));

// Stellar SDK / client are imported transitively by reward.service.
vi.mock("../../../src/stellar/transactions.js", () => ({ invokeContract: vi.fn() }));
vi.mock("../../../src/stellar/client.js", () => ({ stellarClient: {} }));
vi.mock("../../../src/stellar/signatures.js", () => ({ createQuizProof: vi.fn() }));
vi.mock("../../../src/stellar/resilience.js", () => ({ isCircuitBreakerError: vi.fn() }));

import { db } from "../../../src/config/database.js";
import { rewardService } from "../../../src/modules/rewards/reward.service.js";

const mockDb = vi.mocked(db, true);

function selectRows(result: unknown[]) {
  const chain: any = {};
  chain.select = vi.fn().mockReturnValue(chain);
  chain.from = vi.fn().mockReturnValue(chain);
  chain.innerJoin = vi.fn().mockReturnValue(chain);
  chain.where = vi.fn().mockResolvedValue(result);
  return chain;
}

describe("RewardService.getPendingRewards (#327)", () => {
  beforeEach(() => vi.clearAllMocks());

  it("returns queued claims first with a 1-based queue position", async () => {
    getQueuedRewardJobs.mockResolvedValue([
      { submissionId: "s-queued", userId: "u1", position: 0, readyAt: Date.now() },
      { submissionId: "s-other-user", userId: "u2", position: 1, readyAt: Date.now() },
    ]);

    mockDb.select
      // pendingRows (rewardPending = true)
      .mockReturnValueOnce(
        selectRows([
          {
            submissionId: "s-pending",
            courseTitle: "Stellar 101",
            rewardAmount: null,
            txHash: "pending_indexer_confirmation",
            submittedAt: new Date("2026-08-01"),
          },
        ]),
      )
      // queued submission metadata lookup
      .mockReturnValueOnce(
        selectRows([
          {
            submissionId: "s-queued",
            courseTitle: "Soroban Deep Dive",
            rewardAmount: 25,
            submittedAt: new Date("2026-08-10"),
          },
        ]),
      );

    const pending = await rewardService.getPendingRewards("u1");

    expect(pending).toHaveLength(2);
    expect(pending[0]).toMatchObject({
      submissionId: "s-queued",
      courseTitle: "Soroban Deep Dive",
      amount: 25,
      status: "queued",
      queuePosition: 1,
      estimatedProcessingSeconds: 5,
    });
    expect(pending[1]).toMatchObject({
      submissionId: "s-pending",
      status: "awaiting_confirmation",
      queuePosition: null,
      amount: 10,
    });
    expect(cacheSet).toHaveBeenCalledWith("rewards:pending:u1", pending, 10);
  });

  it("returns an empty list when nothing is pending", async () => {
    getQueuedRewardJobs.mockResolvedValue([]);
    mockDb.select.mockReturnValueOnce(selectRows([]));

    const pending = await rewardService.getPendingRewards("u1");
    expect(pending).toEqual([]);
  });
});
