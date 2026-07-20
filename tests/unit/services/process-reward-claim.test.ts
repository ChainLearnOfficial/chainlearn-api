import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("@stellar/stellar-sdk", async () => {
  const actual = await vi.importActual<typeof import("@stellar/stellar-sdk")>("@stellar/stellar-sdk");
  return {
    ...actual,
    default: {
      ...actual.default,
      Address: {
        fromString: vi.fn().mockReturnValue({
          toScVal: vi.fn().mockReturnValue("mock-sc-val"),
        }),
      },
      nativeToScVal: vi.fn().mockReturnValue("mock-native-val"),
    },
  };
});

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
    STELLAR_HORIZON_URL: "https://horizon-testnet.stellar.org",
    STELLAR_SOROBAN_RPC_URL: "https://soroban-testnet.stellar.org",
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

vi.mock("../../../src/cache/index.js", () => ({
  cacheGet: vi.fn().mockResolvedValue(null),
  cacheSet: vi.fn().mockResolvedValue(undefined),
  cacheDel: vi.fn().mockResolvedValue(undefined),
  cacheKey: vi.fn((...parts: string[]) => parts.join(":")),
  cacheInvalidatePattern: vi.fn().mockResolvedValue(undefined),
  cacheHits: { labels: vi.fn().mockReturnValue({ inc: vi.fn() }) },
  cacheMisses: { labels: vi.fn().mockReturnValue({ inc: vi.fn() }) },
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
  obj.for = vi.fn().mockReturnValue(Promise.resolve(result)); // Add this line  
  obj.update = vi.fn().mockReturnValue(obj);  
  obj.set = vi.fn().mockReturnValue(obj);  
  return obj;  
}

describe("processRewardClaim", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

 it("should return true when submission does not exist", async () => {  
  mockDb.transaction.mockImplementation(async (fn: Function) => {  
    const tx: any = {};  
    const makeChain = (result: any[]) => {  
      const c: any = {};  
      c.then = (resolve: Function) => Promise.resolve(result).then(resolve);  
      c.select = vi.fn().mockReturnValue(c);  
      c.from = vi.fn().mockReturnValue(c);  
      c.where = vi.fn().mockReturnValue(c);  
      c.for = vi.fn().mockReturnValue(Promise.resolve(result));  
      return c;  
    };  
    const submissionChain = makeChain([]);  
    submissionChain.select = vi.fn().mockReturnValue(submissionChain);  
    return fn(tx);  
  });  
  
  const result = await processRewardClaim("sub-1", "user-1", 5);  
  expect(result).toBe(true);  
});

  it("should return true when quiz does not exist", async () => {  
  mockDb.transaction.mockImplementation(async (fn: Function) => {  
    const tx: any = {};  
    const makeChain = (result: any[]) => {  
      const c: any = {};  
      c.then = (resolve: Function) => Promise.resolve(result).then(resolve);  
      c.select = vi.fn().mockReturnValue(c);  
      c.from = vi.fn().mockReturnValue(c);  
      c.where = vi.fn().mockReturnValue(c);  
      c.for = vi.fn().mockReturnValue(Promise.resolve(result));  
      return c;  
    };  
  
    const chainResults = [  
      [{ id: "sub-1", userId: "user-1", score: 5, rewardClaimed: false, quizId: "quiz-1" }],  
      []  
    ];  
    let callIndex = 0;  
    const rootChain = makeChain([]);  
    rootChain.select = vi.fn().mockImplementation(() => {  
      return makeChain(chainResults[callIndex++]);  
    });  
  
    return fn(rootChain);  
  });  
  
  const result = await processRewardClaim("sub-1", "user-1", 5);  
  expect(result).toBe(true);  
});

 it("should return true when user does not exist", async () => {  
  mockDb.transaction.mockImplementation(async (fn: Function) => {  
    const tx: any = {};  
    const makeChain = (result: any[]) => {  
      const c: any = {};  
      c.then = (resolve: Function) => Promise.resolve(result).then(resolve);  
      c.select = vi.fn().mockReturnValue(c);  
      c.from = vi.fn().mockReturnValue(c);  
      c.where = vi.fn().mockReturnValue(c);  
      c.for = vi.fn().mockReturnValue(Promise.resolve(result));  
      return c;  
    };  
  
    const chainResults = [  
      [{ id: "sub-1", userId: "user-1", score: 5, rewardClaimed: false, quizId: "quiz-1" }],  
      [{ id: "quiz-1", courseId: "course-1", questions: [{ id: "q1" }] }],  
      []  
    ];  
    let callIndex = 0;  
    const rootChain = makeChain([]);  
    rootChain.select = vi.fn().mockImplementation(() => {  
      return makeChain(chainResults[callIndex++]);  
    });  
  
    return fn(rootChain);  
  });  
  
  const result = await processRewardClaim("sub-1", "user-1", 5);  
  expect(result).toBe(true);  
});
 it("should successfully process claim and update DB in transaction", async () => {  
  mockDb.transaction.mockImplementation(async (fn: Function) => {  
    const tx: any = {};  
    const makeChain = (result: any[]) => {  
      const c: any = {};  
      c.then = (resolve: Function) => Promise.resolve(result).then(resolve);  
      c.select = vi.fn().mockReturnValue(c);  
      c.from = vi.fn().mockReturnValue(c);  
      c.where = vi.fn().mockReturnValue(c);  
      c.for = vi.fn().mockReturnValue(Promise.resolve(result));  
      c.update = vi.fn().mockReturnValue(c);  
      c.set = vi.fn().mockReturnValue(c);  
      return c;  
    };  
  
    const chainResults = [  
      [{ id: "sub-1", userId: "user-1", score: 5, rewardClaimed: false, quizId: "quiz-1" }],  
      [{ id: "quiz-1", courseId: "course-1", questions: [{ id: "q1" }] }],  
      [{ id: "user-1", stellarAddress: "GALICE0000000000000000000000000000000000000000000000000000000" }]  
    ];  
    let callIndex = 0;  
    const rootChain = makeChain([]);  
    rootChain.select = vi.fn().mockImplementation(() => {  
      return makeChain(chainResults[callIndex++]);  
    });  
  
    return fn(rootChain);  
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
  mockDb.transaction.mockImplementation(async (fn: Function) => {  
    const tx: any = {};  
    const makeChain = (result: any[]) => {  
      const c: any = {};  
      c.then = (resolve: Function) => Promise.resolve(result).then(resolve);  
      c.select = vi.fn().mockReturnValue(c);  
      c.from = vi.fn().mockReturnValue(c);  
      c.where = vi.fn().mockReturnValue(c);  
      c.for = vi.fn().mockReturnValue(Promise.resolve(result));  
      return c;  
    };  
  
    const chainResults = [  
      [{ id: "sub-1", userId: "user-1", score: 5, rewardClaimed: false, quizId: "quiz-1" }],  
      [{ id: "quiz-1", courseId: "course-1", questions: [{ id: "q1" }] }],  
      [{ id: "user-1", stellarAddress: "GALICE0000000000000000000000000000000000000000000000000000000" }]  
    ];  
    let callIndex = 0;  
    const rootChain = makeChain([]);  
    rootChain.select = vi.fn().mockImplementation(() => {  
      return makeChain(chainResults[callIndex++]);  
    });  
  
    return fn(rootChain);  
  });  
  
  vi.mocked(invokeContract).mockRejectedValue(new Error("Stellar error"));  
  
  await expect(  
    processRewardClaim("sub-1", "user-1", 5)  
  ).rejects.toThrow("Stellar error");  
});
  it("should prevent double-claim with concurrent calls", async () => {  
  const submissionData = [  
    {  
      id: "sub-1",  
      userId: "user-1",  
      score: 5,  
      rewardClaimed: false,  
      quizId: "quiz-1",  
    },  
  ];  
  const quizData = [{ id: "quiz-1", courseId: "course-1", questions: [{ id: "q1" }] }];  
  const userData = [  
    {  
      id: "user-1",  
      stellarAddress: "GALICE0000000000000000000000000000000000000000000000000000000",  
    },  
  ];  
  
  let transactionCallCount = 0;  
  mockDb.transaction.mockImplementation(async (fn: Function) => {  
    transactionCallCount++;  
    const tx: any = {};  
    const makeChain = (result: any[]) => {  
      const c: any = {};  
      c.then = (resolve: Function) => Promise.resolve(result).then(resolve);  
      c.select = vi.fn().mockReturnValue(c);  
      c.from = vi.fn().mockReturnValue(c);  
      c.where = vi.fn().mockReturnValue(c);  
      c.for = vi.fn().mockReturnValue(Promise.resolve(result));  
      c.update = vi.fn().mockReturnValue(c);  
      c.set = vi.fn().mockReturnValue(c);  
      return c;  
    };  
  
    const chainResults = [submissionData, quizData, userData];  
    let callIndex = 0;  
    const rootChain = makeChain([]);  
    rootChain.select = vi.fn().mockImplementation(() => {  
      return makeChain(chainResults[callIndex++]);  
    });  
  
    return fn(rootChain);  
  });  
  
  const [result1, result2] = await Promise.all([  
    processRewardClaim("sub-1", "user-1", 5),  
    processRewardClaim("sub-1", "user-1", 5),  
  ]);  
  
  expect(result1).toBe(true);  
  expect(result2).toBe(true);  
  expect(mockDb.transaction).toHaveBeenCalledTimes(2);  
  expect(invokeContract).toHaveBeenCalledTimes(1); // Only one Stellar call  
});
});
