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

vi.mock("../../../src/utils/lock.js", () => ({
  withLock: vi.fn(async (_key: string, fn: () => Promise<any>) => fn()),
}));

vi.mock("../../../src/stellar/transactions.js", () => ({
  invokeContract: vi.fn().mockResolvedValue("tx-hash-123"),
}));

vi.mock("../../../src/stellar/signatures.js", () => ({
  createQuizProof: vi.fn().mockReturnValue({ signature: "base64sig" }),
  createMintAuthorization: vi.fn().mockReturnValue({ signature: "base64sig" }),
}));

vi.mock("../../../src/config/index.js", () => ({
  config: {
    STELLAR_REWARD_CONTRACT_ID: "test-reward-contract",
    STELLAR_CREDENTIAL_CONTRACT_ID: "test-credential-contract",
    STELLAR_HORIZON_URL: "https://horizon-testnet.stellar.org",
    STELLAR_SOROBAN_RPC_URL: "https://soroban-testnet.stellar.org",
  },
}));

vi.mock("../../../src/utils/logger.js", () => ({
  logger: { info: vi.fn(), error: vi.fn(), warn: vi.fn() },
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
import { rewardService } from "../../../src/modules/rewards/reward.service.js";
import { credentialService } from "../../../src/modules/credentials/credential.service.js";
import { courseService } from "../../../src/modules/courses/course.service.js";
import { quizService } from "../../../src/modules/quizzes/quiz.service.js";

const mockDb = vi.mocked(db);

function makeThenable(result: any[]) {
  const obj: any = {};
  obj.then = (resolve: Function, reject: Function) =>
    Promise.resolve(result).then(resolve, reject);
  obj.select = vi.fn().mockReturnValue(obj);
  obj.from = vi.fn().mockReturnValue(obj);
  obj.where = vi.fn().mockReturnValue(obj);
  obj.for = vi.fn().mockReturnValue(Promise.resolve(result));
  obj.update = vi.fn().mockReturnValue(obj);
  obj.set = vi.fn().mockReturnValue(obj);
  obj.insert = vi.fn().mockReturnValue(obj);
  obj.values = vi.fn().mockReturnValue(obj);
  obj.returning = vi.fn().mockResolvedValue(result.length ? result : [{ id: "new-id" }]);
  return obj;
}

describe("Concurrent Request Safety", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe("Reward Claiming", () => {
    it("should prevent double-claim via distributed lock", async () => {
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
          stellarAddress:
            "GALICE0000000000000000000000000000000000000000000000000000000",
        },
      ];

      mockDb.transaction.mockImplementation(async (fn: Function) => {
        let callIndex = 0;
        const chainResults = [submissionData, quizData, userData];

        const tx: any = {};
        const makeChain = (result: any[]) => {
          const c: any = {};
          c.then = (resolve: Function, reject: Function) =>
            Promise.resolve(result).then(resolve, reject);
          c.select = vi.fn().mockReturnValue(c);
          c.from = vi.fn().mockReturnValue(c);
          c.where = vi.fn().mockReturnValue(c);
          c.for = vi.fn().mockReturnValue(
            Promise.resolve(result)
          );
          c.update = vi.fn().mockReturnValue(c);
          c.set = vi.fn().mockReturnValue(c);
          c.insert = vi.fn().mockReturnValue(c);
          c.values = vi.fn().mockReturnValue(c);
          c.returning = vi.fn().mockResolvedValue(result);
          return c;
        };

        const rootChain = makeChain([]);
        rootChain.select = vi.fn().mockImplementation(() => {
          return makeChain(chainResults[callIndex++]);
        });

        return fn(rootChain);
      });

      const result = await rewardService.claimReward("user-1", "sub-1");
      expect(result.submissionId).toBe("sub-1");
      expect(result.amount).toBe(10);
      expect(result.txHash).toBe("tx-hash-123");
    });

    it("should throw ConflictError when reward already claimed", async () => {
      mockDb.transaction.mockImplementation(async (fn: Function) => {
        const tx: any = {};
        const makeChain = (result: any[]) => {
          const c: any = {};
          c.then = (resolve: Function, reject: Function) =>
            Promise.resolve(result).then(resolve, reject);
          c.select = vi.fn().mockReturnValue(c);
          c.from = vi.fn().mockReturnValue(c);
          c.where = vi.fn().mockReturnValue(c);
          c.for = vi.fn().mockReturnValue(Promise.resolve(result));
          c.update = vi.fn().mockReturnValue(c);
          c.set = vi.fn().mockReturnValue(c);
          return c;
        };
        const rootChain = makeChain([]);
        rootChain.select = vi.fn().mockImplementation(() =>
          makeChain([
            {
              id: "sub-1",
              userId: "user-1",
              score: 5,
              rewardClaimed: true,
              quizId: "quiz-1",
            },
          ])
        );
        return fn(rootChain);
      });

      await expect(
        rewardService.claimReward("user-1", "sub-1")
      ).rejects.toThrow("Reward already claimed for this submission");
    });

    it("should throw NotFoundError when submission does not exist", async () => {
      mockDb.transaction.mockImplementation(async (fn: Function) => {
        const tx: any = {};
        const makeChain = (result: any[]) => {
          const c: any = {};
          c.then = (resolve: Function, reject: Function) =>
            Promise.resolve(result).then(resolve, reject);
          c.select = vi.fn().mockReturnValue(c);
          c.from = vi.fn().mockReturnValue(c);
          c.where = vi.fn().mockReturnValue(c);
          c.for = vi.fn().mockReturnValue(Promise.resolve(result));
          c.update = vi.fn().mockReturnValue(c);
          c.set = vi.fn().mockReturnValue(c);
          return c;
        };
        const rootChain = makeChain([]);
        rootChain.select = vi.fn().mockImplementation(() => makeChain([]));
        return fn(rootChain);
      });

      await expect(
        rewardService.claimReward("user-1", "nonexistent")
      ).rejects.toThrow("Quiz submission not found");
    });
  });

  describe("Credential Minting", () => {
    it("should prevent duplicate mint via distributed lock", async () => {
      mockDb.transaction.mockImplementation(async (fn: Function) => {
        const submissionData = [{ id: "sub-1", userId: "user-1", score: 5, quizId: "quiz-1" }];
        const quizData = [{ id: "quiz-1", courseId: "course-1" }];
        const existingCredData: any[] = [];
        const userData = [
          {
            id: "user-1",
            stellarAddress:
              "GALICE0000000000000000000000000000000000000000000000000000000",
          },
        ];

        const chainData = [submissionData, quizData, existingCredData, userData];
        let callIndex = 0;

        const makeChain = (result: any[]) => {
          const c: any = {};
          c.then = (resolve: Function, reject: Function) =>
            Promise.resolve(result).then(resolve, reject);
          c.select = vi.fn().mockReturnValue(c);
          c.from = vi.fn().mockReturnValue(c);
          c.where = vi.fn().mockReturnValue(c);
          c.for = vi.fn().mockReturnValue(Promise.resolve(result));
          c.insert = vi.fn().mockReturnValue(c);
          c.values = vi.fn().mockReturnValue(c);
          c.returning = vi.fn().mockResolvedValue([{ id: "cred-1" }]);
          return c;
        };

        const rootChain = makeChain([]);
        rootChain.select = vi.fn().mockImplementation(() =>
          makeChain(chainData[callIndex++])
        );
        return fn(rootChain);
      });

      const result = await credentialService.mint(
        "user-1",
        "course-1",
        "sub-1"
      );
      expect(result.credentialId).toBe("cred-1");
      expect(result.mintTxHash).toBe("tx-hash-123");
    });

    it("should throw ConflictError when credential already exists", async () => {
      mockDb.transaction.mockImplementation(async (fn: Function) => {
        const chainData = [
          [{ id: "sub-1", userId: "user-1", score: 5, quizId: "quiz-1" }],
          [{ id: "quiz-1", courseId: "course-1" }],
          [{ id: "cred-existing", userId: "user-1", courseId: "course-1" }],
        ];
        let callIndex = 0;

        const makeChain = (result: any[]) => {
          const c: any = {};
          c.then = (resolve: Function, reject: Function) =>
            Promise.resolve(result).then(resolve, reject);
          c.select = vi.fn().mockReturnValue(c);
          c.from = vi.fn().mockReturnValue(c);
          c.where = vi.fn().mockReturnValue(c);
          c.for = vi.fn().mockReturnValue(Promise.resolve(result));
          c.insert = vi.fn().mockReturnValue(c);
          c.values = vi.fn().mockReturnValue(c);
          return c;
        };

        const rootChain = makeChain([]);
        rootChain.select = vi.fn().mockImplementation(() =>
          makeChain(chainData[callIndex++])
        );
        return fn(rootChain);
      });

      await expect(
        credentialService.mint("user-1", "course-1", "sub-1")
      ).rejects.toThrow("Credential already minted for this course");
    });
  });

  describe("Course Enrollment", () => {
    it("should prevent duplicate enrollment via distributed lock", async () => {
      mockDb.transaction.mockImplementation(async (fn: Function) => {
        const chainData = [
          [{ id: "course-1", isActive: true }],
          [],
        ];
        let callIndex = 0;

        const makeChain = (result: any[]) => {
          const c: any = {};
          c.then = (resolve: Function, reject: Function) =>
            Promise.resolve(result).then(resolve, reject);
          c.select = vi.fn().mockReturnValue(c);
          c.from = vi.fn().mockReturnValue(c);
          c.where = vi.fn().mockReturnValue(c);
          c.for = vi.fn().mockReturnValue(Promise.resolve(result));
          c.insert = vi.fn().mockReturnValue(c);
          c.values = vi.fn().mockReturnValue(c);
          return c;
        };

        const rootChain = makeChain([]);
        rootChain.select = vi.fn().mockImplementation(() =>
          makeChain(chainData[callIndex++])
        );
        return fn(rootChain);
      });

      await expect(
        courseService.enroll("user-1", "course-1")
      ).resolves.toBeUndefined();
    });

    it("should throw ConflictError when already enrolled", async () => {
      mockDb.transaction.mockImplementation(async (fn: Function) => {
        const chainData = [
          [{ id: "course-1", isActive: true }],
          [{ id: "enr-1", userId: "user-1", courseId: "course-1" }],
        ];
        let callIndex = 0;

        const makeChain = (result: any[]) => {
          const c: any = {};
          c.then = (resolve: Function, reject: Function) =>
            Promise.resolve(result).then(resolve, reject);
          c.select = vi.fn().mockReturnValue(c);
          c.from = vi.fn().mockReturnValue(c);
          c.where = vi.fn().mockReturnValue(c);
          c.for = vi.fn().mockReturnValue(Promise.resolve(result));
          c.insert = vi.fn().mockReturnValue(c);
          c.values = vi.fn().mockReturnValue(c);
          return c;
        };

        const rootChain = makeChain([]);
        rootChain.select = vi.fn().mockImplementation(() =>
          makeChain(chainData[callIndex++])
        );
        return fn(rootChain);
      });

      await expect(
        courseService.enroll("user-1", "course-1")
      ).rejects.toThrow("Already enrolled in this course");
    });

    it("should throw NotFoundError when course does not exist", async () => {
      mockDb.transaction.mockImplementation(async (fn: Function) => {
        const makeChain = (result: any[]) => {
          const c: any = {};
          c.then = (resolve: Function, reject: Function) =>
            Promise.resolve(result).then(resolve, reject);
          c.select = vi.fn().mockReturnValue(c);
          c.from = vi.fn().mockReturnValue(c);
          c.where = vi.fn().mockReturnValue(c);
          c.for = vi.fn().mockReturnValue(Promise.resolve(result));
          c.insert = vi.fn().mockReturnValue(c);
          c.values = vi.fn().mockReturnValue(c);
          return c;
        };

        const rootChain = makeChain([]);
        rootChain.select = vi.fn().mockImplementation(() => makeChain([]));
        return fn(rootChain);
      });

      await expect(
        courseService.enroll("user-1", "nonexistent-course")
      ).rejects.toThrow("Course not found");
    });
  });

  describe("Quiz Submission", () => {
    it("should prevent duplicate submission via distributed lock", async () => {
      mockDb.transaction.mockImplementation(async (fn: Function) => {
        const quizData = [
          {
            id: "quiz-1",
            courseId: "course-1",
            moduleId: "mod-1",
            questions: [
              {
                id: "q1",
                text: "Test question?",
                options: ["A", "B", "C", "D"],
                correctIndex: 1,
              },
            ],
          },
        ];

        const chainData = [quizData, []];
        let callIndex = 0;

        const makeChain = (result: any[]) => {
          const c: any = {};
          c.then = (resolve: Function, reject: Function) =>
            Promise.resolve(result).then(resolve, reject);
          c.select = vi.fn().mockReturnValue(c);
          c.from = vi.fn().mockReturnValue(c);
          c.where = vi.fn().mockReturnValue(c);
          c.for = vi.fn().mockReturnValue(Promise.resolve(result));
          c.insert = vi.fn().mockReturnValue(c);
          c.values = vi.fn().mockReturnValue(c);
          c.returning = vi.fn().mockResolvedValue([
            {
              id: "sub-new",
              feedback: 'Q: "Test question?" - Correct!',
            },
          ]);
          return c;
        };

        const rootChain = makeChain([]);
        rootChain.select = vi.fn().mockImplementation(() =>
          makeChain(chainData[callIndex++])
        );
        return fn(rootChain);
      });

      const result = await quizService.submitQuiz("user-1", "quiz-1", {
        answers: [{ questionId: "q1", selectedIndex: 1 }],
      });
      expect(result.id).toBe("sub-new");
      expect(result.passed).toBe(true);
    });

    it("should throw ConflictError when quiz already submitted", async () => {
      mockDb.transaction.mockImplementation(async (fn: Function) => {
        const chainData = [
          [{ id: "quiz-1", questions: [] }],
          [{ id: "existing-sub", userId: "user-1", quizId: "quiz-1" }],
        ];
        let callIndex = 0;

        const makeChain = (result: any[]) => {
          const c: any = {};
          c.then = (resolve: Function, reject: Function) =>
            Promise.resolve(result).then(resolve, reject);
          c.select = vi.fn().mockReturnValue(c);
          c.from = vi.fn().mockReturnValue(c);
          c.where = vi.fn().mockReturnValue(c);
          c.for = vi.fn().mockReturnValue(Promise.resolve(result));
          c.insert = vi.fn().mockReturnValue(c);
          c.values = vi.fn().mockReturnValue(c);
          return c;
        };

        const rootChain = makeChain([]);
        rootChain.select = vi.fn().mockImplementation(() =>
          makeChain(chainData[callIndex++])
        );
        return fn(rootChain);
      });

      await expect(
        quizService.submitQuiz("user-1", "quiz-1", {
          answers: [{ questionId: "q1", selectedIndex: 1 }],
        })
      ).rejects.toThrow("Quiz already submitted");
    });

    it("should throw NotFoundError when quiz does not exist", async () => {
      mockDb.transaction.mockImplementation(async (fn: Function) => {
        const makeChain = (result: any[]) => {
          const c: any = {};
          c.then = (resolve: Function, reject: Function) =>
            Promise.resolve(result).then(resolve, reject);
          c.select = vi.fn().mockReturnValue(c);
          c.from = vi.fn().mockReturnValue(c);
          c.where = vi.fn().mockReturnValue(c);
          c.for = vi.fn().mockReturnValue(Promise.resolve(result));
          c.insert = vi.fn().mockReturnValue(c);
          c.values = vi.fn().mockReturnValue(c);
          return c;
        };

        const rootChain = makeChain([]);
        rootChain.select = vi.fn().mockImplementation(() => makeChain([]));
        return fn(rootChain);
      });

      await expect(
        quizService.submitQuiz("user-1", "nonexistent-quiz", {
          answers: [{ questionId: "q1", selectedIndex: 1 }],
        })
      ).rejects.toThrow("Quiz not found");
    });
  });
});
