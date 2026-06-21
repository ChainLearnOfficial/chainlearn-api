import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("@stellar/stellar-sdk", () => ({
  default: {
    Address: {
      fromString: vi.fn().mockReturnValue({
        toScVal: vi.fn().mockReturnValue("mock-sc-val"),
      }),
    },
    nativeToScVal: vi.fn().mockReturnValue("mock-native-val"),
  },
}));

vi.mock("../../../src/config/database.js", () => {
  const mockDb = {
    select: vi.fn(),
    from: vi.fn(),
    where: vi.fn(),
    update: vi.fn(),
    insert: vi.fn(),
    transaction: vi.fn(),
  };
  return { db: mockDb };
});

vi.mock("../../../src/stellar/transactions.js", () => ({
  invokeContract: vi.fn().mockResolvedValue("tx-hash-123"),
}));

vi.mock("../../../src/stellar/signatures.js", () => ({
  createQuizProof: vi.fn().mockReturnValue({ signature: "base64sig" }),
}));

vi.mock("../../../src/stellar/resilience.js", () => ({
  isCircuitBreakerError: vi.fn().mockReturnValue(false),
}));

vi.mock("../../../src/config/index.js", () => ({
  config: {
    STELLAR_REWARD_CONTRACT_ID: "test-reward-contract",
  },
}));

vi.mock("../../../src/utils/logger.js", () => ({
  logger: { info: vi.fn(), error: vi.fn(), warn: vi.fn() },
}));

vi.mock("../../../src/services/retry-queue.js", () => ({
  enqueueReward: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("../../../src/audit/index.js", () => ({
  auditLog: vi.fn(),
}));

vi.mock("../../../src/metrics/index.js", () => ({
  rewardClaimsTotal: { inc: vi.fn() },
  stellarTxDurationSeconds: { observe: vi.fn() },
}));

import { db } from "../../../src/config/database.js";
import { processRewardClaim } from "../../../src/modules/rewards/reward.service.js";
import { invokeContract } from "../../../src/stellar/transactions.js";

const mockDb = vi.mocked(db);

function makeThenable(result: any[]) {
  const obj: any = {};
  obj.then = (resolve: Function, reject: Function) =>
    Promise.resolve(result).then(resolve, reject);
  obj.select = vi.fn().mockReturnValue(obj);
  obj.from = vi.fn().mockReturnValue(obj);
  obj.where = vi.fn().mockReturnValue(obj);
  obj.update = vi.fn().mockReturnValue(obj);
  obj.set = vi.fn().mockReturnValue(obj);
  return obj;
}

describe("processRewardClaim", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("should return true when submission does not exist", async () => {
    const submissionChain = makeThenable([]);

    mockDb.select.mockReturnValue(submissionChain);

    const result = await processRewardClaim("sub-1", "user-1", 5);
    expect(result).toBe(true);
  });

  it("should return true when reward is already claimed", async () => {
    const submissionChain = makeThenable([
      {
        id: "sub-1",
        userId: "user-1",
        score: 5,
        rewardClaimed: true,
        quizId: "quiz-1",
      },
    ]);

    mockDb.select.mockReturnValue(submissionChain);

    const result = await processRewardClaim("sub-1", "user-1", 5);
    expect(result).toBe(true);
  });

  it("should return true when quiz does not exist", async () => {
    const submissionChain = makeThenable([
      {
        id: "sub-1",
        userId: "user-1",
        score: 5,
        rewardClaimed: false,
        quizId: "quiz-1",
      },
    ]);
    const quizChain = makeThenable([]);

    mockDb.select
      .mockReturnValueOnce(submissionChain)
      .mockReturnValueOnce(quizChain);

    const result = await processRewardClaim("sub-1", "user-1", 5);
    expect(result).toBe(true);
  });

  it("should return true when user does not exist", async () => {
    const submissionChain = makeThenable([
      {
        id: "sub-1",
        userId: "user-1",
        score: 5,
        rewardClaimed: false,
        quizId: "quiz-1",
      },
    ]);
    const quizChain = makeThenable([{ id: "quiz-1", courseId: "course-1" }]);
    const userChain = makeThenable([]);

    mockDb.select
      .mockReturnValueOnce(submissionChain)
      .mockReturnValueOnce(quizChain)
      .mockReturnValueOnce(userChain);

    const result = await processRewardClaim("sub-1", "user-1", 5);
    expect(result).toBe(true);
  });

  it("should successfully process claim and update DB in transaction", async () => {
    const submissionChain = makeThenable([
      {
        id: "sub-1",
        userId: "user-1",
        score: 5,
        rewardClaimed: false,
        quizId: "quiz-1",
      },
    ]);
    const quizChain = makeThenable([{ id: "quiz-1", courseId: "course-1" }]);
    const userChain = makeThenable([
      {
        id: "user-1",
        stellarAddress:
          "GALICE0000000000000000000000000000000000000000000000000000000",
      },
    ]);

    mockDb.select
      .mockReturnValueOnce(submissionChain)
      .mockReturnValueOnce(quizChain)
      .mockReturnValueOnce(userChain);

    mockDb.transaction.mockImplementation(async (fn: Function) => {
      const tx: any = {};
      tx.update = vi.fn().mockReturnValue({
        set: vi.fn().mockReturnValue({
          where: vi.fn().mockResolvedValue(undefined),
        }),
      });
      return fn(tx);
    });

    const result = await processRewardClaim("sub-1", "user-1", 5);

    expect(result).toBe(true);
    expect(mockDb.transaction).toHaveBeenCalledTimes(1);
    expect(invokeContract).toHaveBeenCalledWith(
      "test-reward-contract",
      "claim_reward",
      expect.any(Array)
    );
  });

  it("should throw when on-chain transaction fails", async () => {
    const submissionChain = makeThenable([
      {
        id: "sub-1",
        userId: "user-1",
        score: 5,
        rewardClaimed: false,
        quizId: "quiz-1",
      },
    ]);
    const quizChain = makeThenable([{ id: "quiz-1", courseId: "course-1" }]);
    const userChain = makeThenable([
      {
        id: "user-1",
        stellarAddress:
          "GALICE0000000000000000000000000000000000000000000000000000000",
      },
    ]);

    mockDb.select
      .mockReturnValueOnce(submissionChain)
      .mockReturnValueOnce(quizChain)
      .mockReturnValueOnce(userChain);

    vi.mocked(invokeContract).mockRejectedValue(new Error("Stellar error"));

    await expect(
      processRewardClaim("sub-1", "user-1", 5)
    ).rejects.toThrow("Stellar error");
  });
});
