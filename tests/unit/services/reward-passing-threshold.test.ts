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
    transaction: vi.fn(),
  };
  return { db: mockDb };
});

vi.mock("../../../src/utils/lock.js", () => ({
  withLock: vi.fn(async (_key: string, fn: () => Promise<any>) => fn()),
}));

vi.mock("../../../src/stellar/transactions.js", () => ({
  invokeContract: vi.fn().mockResolvedValue("tx-hash-123"),
}));

vi.mock("../../../src/stellar/signatures.js", () => ({
  createQuizProof: vi.fn().mockReturnValue({ signature: "base64sig" }),
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
  enqueueReward: vi.fn(),
}));

vi.mock("../../../src/audit/index.js", () => ({
  auditLog: vi.fn(),
}));

vi.mock("../../../src/metrics/index.js", () => ({
  stellarTxDurationSeconds: {
    observe: vi.fn(),
  },
  rewardClaimsTotal: {
    inc: vi.fn(),
  },
}));

import { db } from "../../../src/config/database.js";
import { invokeContract } from "../../../src/stellar/transactions.js";
import {
  isPassingRewardScore,
  rewardService,
} from "../../../src/modules/rewards/reward.service.js";

const mockDb = vi.mocked(db);
const mockInvokeContract = vi.mocked(invokeContract);

const threeQuestionQuiz = {
  id: "quiz-1",
  questions: [
    { id: "q1", text: "Question 1", options: ["A", "B"], correctIndex: 0 },
    { id: "q2", text: "Question 2", options: ["A", "B"], correctIndex: 0 },
    { id: "q3", text: "Question 3", options: ["A", "B"], correctIndex: 0 },
  ],
};

function makeChain(result: any[]) {
  const chain: any = {};
  chain.then = (resolve: Function, reject: Function) =>
    Promise.resolve(result).then(resolve, reject);
  chain.select = vi.fn().mockReturnValue(chain);
  chain.from = vi.fn().mockReturnValue(chain);
  chain.where = vi.fn().mockReturnValue(chain);
  chain.for = vi.fn().mockReturnValue(Promise.resolve(result));
  chain.update = vi.fn().mockReturnValue(chain);
  chain.set = vi.fn().mockReturnValue(chain);
  return chain;
}

function mockClaimTransaction(submission: Record<string, unknown>) {
  mockDb.transaction.mockImplementation(async (fn: Function) => {
    const results = [
      [submission],
      [threeQuestionQuiz],
      [
        {
          id: "user-1",
          stellarAddress:
            "GALICE0000000000000000000000000000000000000000000000000000000",
        },
      ],
    ];
    let callIndex = 0;
    const rootChain = makeChain([]);
    rootChain.select = vi.fn().mockImplementation(() => {
      return makeChain(results[callIndex++] ?? []);
    });
    return fn(rootChain);
  });
}

describe("reward passing threshold", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("matches the quiz service 70 percent passing threshold", () => {
    expect(isPassingRewardScore(1, 3)).toBe(false);
    expect(isPassingRewardScore(2, 3)).toBe(false);
    expect(isPassingRewardScore(3, 3)).toBe(true);
  });

  it("rejects reward claims for failed quiz submissions", async () => {
    mockClaimTransaction({
      id: "sub-1",
      userId: "user-1",
      score: 1,
      rewardClaimed: false,
      quizId: "quiz-1",
    });

    await expect(rewardService.claimReward("user-1", "sub-1")).rejects.toThrow(
      "Quiz not passed"
    );
    expect(mockInvokeContract).not.toHaveBeenCalled();
  });

  it("allows reward claims only when the submission meets the threshold", async () => {
    mockClaimTransaction({
      id: "sub-1",
      userId: "user-1",
      score: 3,
      rewardClaimed: false,
      quizId: "quiz-1",
    });

    const result = await rewardService.claimReward("user-1", "sub-1");

    expect(result.submissionId).toBe("sub-1");
    expect(result.amount).toBe(10);
    expect(result.txHash).toBe("tx-hash-123");
    expect(mockInvokeContract).toHaveBeenCalledTimes(1);
  });
});
