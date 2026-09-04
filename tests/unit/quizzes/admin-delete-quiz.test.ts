import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("../../../src/config/database.js", () => {
  const mockDb = {
    select: vi.fn(),
    delete: vi.fn(),
    transaction: vi.fn(),
  };
  return { db: mockDb };
});

vi.mock("../../../src/utils/logger.js", () => ({
  logger: { info: vi.fn(), error: vi.fn(), warn: vi.fn(), debug: vi.fn() },
}));

vi.mock("../../../src/utils/lock.js", () => ({
  withLock: vi.fn(async (_key: string, fn: () => Promise<any>) => fn()),
}));

vi.mock("../../../src/audit/index.js", () => ({
  auditLog: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("../../../src/cache/index.js", () => ({
  cacheGet: vi.fn().mockResolvedValue(null),
  cacheSet: vi.fn().mockResolvedValue(undefined),
  cacheDel: vi.fn().mockResolvedValue(undefined),
  cacheInvalidatePattern: vi.fn().mockResolvedValue(undefined),
  cacheKey: (...parts: (string | number)[]) => parts.join(":"),
  cacheKeyPattern: (...parts: (string | number)[]) => `${parts.join(":")}:*`,
}));

vi.mock("../../../src/config/redis.js", () => ({
  redis: { incr: vi.fn(), expire: vi.fn(), ttl: vi.fn() },
}));

vi.mock("../../../src/modules/quizzes/ai-client.js", () => ({
  generateQuizFromAI: vi.fn(),
}));

vi.mock("../../../src/services/webhook-dispatcher.js", () => ({
  dispatchWebhook: vi.fn(),
}));

vi.mock("../../../src/stellar/signatures.js", () => ({
  createQuizProof: vi.fn(),
}));

import { db } from "../../../src/config/database.js";
import { auditLog } from "../../../src/audit/index.js";
import { cacheInvalidatePattern, cacheDel } from "../../../src/cache/index.js";
import { quizService } from "../../../src/modules/quizzes/quiz.service.js";
import { NotFoundError } from "../../../src/utils/errors.js";

const mockDb = vi.mocked(db);

function quizRow(overrides: Record<string, unknown> = {}) {
  return {
    id: "quiz-1",
    courseId: "course-1",
    moduleId: "m1",
    questions: [],
    generatedFor: null,
    createdAt: new Date(),
    ...overrides,
  };
}

describe("QuizService.deleteQuizByAdmin (#414)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("deletes the quiz inside a transaction and audits the submission count", async () => {
    const submissionCountRows = [{ value: 5 }];
    const txChain = {
      select: vi.fn().mockReturnValue({
        from: vi.fn()
          .mockReturnValueOnce({
            where: vi.fn().mockResolvedValue([quizRow()]),
          })
          .mockReturnValueOnce({
            where: vi.fn().mockResolvedValue(submissionCountRows),
          }),
      }),
      delete: vi.fn().mockReturnValue({
        where: vi.fn().mockResolvedValue(undefined),
      }),
    };
    mockDb.transaction.mockImplementationOnce(async (fn: any) => fn(txChain));

    const result = await quizService.deleteQuizByAdmin("course-1", "m1", "quiz-1");

    expect(result).toEqual({ deletedSubmissions: 5 });
    expect(txChain.delete).toHaveBeenCalled();
    expect(auditLog).toHaveBeenCalledWith(
      "quiz.deleted_by_admin",
      expect.objectContaining({ courseId: "course-1", moduleId: "m1", quizId: "quiz-1", total: 5 }),
    );
  });

  it("throws NotFoundError when the quiz does not exist", async () => {
    const txChain = {
      select: vi.fn().mockReturnValue({
        from: vi.fn().mockReturnValue({
          where: vi.fn().mockResolvedValue([]),
        }),
      }),
      delete: vi.fn(),
    };
    mockDb.transaction.mockImplementationOnce(async (fn: any) => fn(txChain));

    await expect(
      quizService.deleteQuizByAdmin("course-1", "m1", "missing-quiz"),
    ).rejects.toBeInstanceOf(NotFoundError);
  });

  it("throws NotFoundError when the quiz belongs to a different course/module", async () => {
    const txChain = {
      select: vi.fn().mockReturnValue({
        from: vi.fn().mockReturnValue({
          where: vi.fn().mockResolvedValue([quizRow({ courseId: "other-course", moduleId: "m2" })]),
        }),
      }),
      delete: vi.fn(),
    };
    mockDb.transaction.mockImplementationOnce(async (fn: any) => fn(txChain));

    await expect(
      quizService.deleteQuizByAdmin("course-1", "m1", "quiz-1"),
    ).rejects.toBeInstanceOf(NotFoundError);
    // Guard path — the delete must never be reached.
    expect(txChain.delete).not.toHaveBeenCalled();
  });

  it("invalidates the aggregate quiz-stats caches after a delete", async () => {
    const txChain = {
      select: vi.fn().mockReturnValue({
        from: vi.fn()
          .mockReturnValueOnce({ where: vi.fn().mockResolvedValue([quizRow()]) })
          .mockReturnValueOnce({ where: vi.fn().mockResolvedValue([{ value: 0 }]) }),
      }),
      delete: vi.fn().mockReturnValue({
        where: vi.fn().mockResolvedValue(undefined),
      }),
    };
    mockDb.transaction.mockImplementationOnce(async (fn: any) => fn(txChain));

    await quizService.deleteQuizByAdmin("course-1", "m1", "quiz-1");

    expect(cacheInvalidatePattern).toHaveBeenCalledWith("quizzes:stats:*");
    expect(cacheDel).toHaveBeenCalledWith("quizzes:stats:course-1");
    expect(cacheDel).toHaveBeenCalledWith("quizzes:stats:all");
  });
});
