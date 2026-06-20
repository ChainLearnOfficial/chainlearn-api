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
    update: vi.fn(),
  };
  return { db: mockDb };
});

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

import { db } from "../../../src/config/database.js";
import { processRewardClaim } from "../../../src/modules/rewards/reward.service.js";
import { invokeContract } from "../../../src/stellar/transactions.js";
import { createQuizProof } from "../../../src/stellar/signatures.js";

const mockDb = vi.mocked(db);
const mockInvokeContract = vi.mocked(invokeContract);
const mockCreateQuizProof = vi.mocked(createQuizProof);

function makeChain(result: any[]) {
  const chain: any = {};
  chain.then = (resolve: Function, reject: Function) =>
    Promise.resolve(result).then(resolve, reject);
  chain.from = vi.fn().mockReturnValue(chain);
  chain.where = vi.fn().mockReturnValue(chain);
  chain.set = vi.fn().mockReturnValue(chain);
  return chain;
}

function mockSelects(results: any[][]) {
  let callIndex = 0;
  mockDb.select.mockImplementation(() => makeChain(results[callIndex++]));
}

describe("processRewardClaim retry path", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockDb.update.mockImplementation(() => makeChain([]));
  });

  it("does not process a reward when the stored submission score is below 70 percent", async () => {
    mockSelects([
      [
        {
          id: "sub-1",
          userId: "user-1",
          quizId: "quiz-1",
          score: 2,
          rewardClaimed: false,
        },
      ],
      [
        {
          id: "quiz-1",
          questions: [{ id: "q1" }, { id: "q2" }, { id: "q3" }],
        },
      ],
    ]);

    const result = await processRewardClaim("sub-1", "user-1", 3);

    expect(result).toBe(true);
    expect(mockInvokeContract).not.toHaveBeenCalled();
    expect(mockCreateQuizProof).not.toHaveBeenCalled();
    expect(mockDb.update).not.toHaveBeenCalled();
  });

  it("processes a reward with the stored submission score when the submission passed", async () => {
    mockSelects([
      [
        {
          id: "sub-1",
          userId: "user-1",
          quizId: "quiz-1",
          score: 3,
          rewardClaimed: false,
        },
      ],
      [
        {
          id: "quiz-1",
          questions: [{ id: "q1" }, { id: "q2" }, { id: "q3" }],
        },
      ],
      [
        {
          id: "user-1",
          stellarAddress:
            "GALICE0000000000000000000000000000000000000000000000000000000",
        },
      ],
    ]);

    const result = await processRewardClaim("sub-1", "user-1", 1);

    expect(result).toBe(true);
    expect(mockCreateQuizProof).toHaveBeenCalledWith("user-1", "quiz-1", 3);
    expect(mockInvokeContract).toHaveBeenCalledOnce();
    expect(mockDb.update).toHaveBeenCalledTimes(2);
  });
});
