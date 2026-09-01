import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("../../../src/config/database.js", () => ({
  db: {
    select: vi.fn(),
    insert: vi.fn(),
    query: {
      quizzes: { findFirst: vi.fn() },
      quizFeedback: { findFirst: vi.fn() },
    },
  },
}));

vi.mock("../../../src/utils/logger.js", () => ({
  logger: { info: vi.fn(), error: vi.fn(), warn: vi.fn() },
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
  cacheKeyPattern: (...p: (string | number)[]) => `${p.join(":")}:*`,
  cacheInvalidatePattern: vi.fn().mockResolvedValue(undefined),
  cacheKey: (...p: (string | number)[]) => p.join(":"),
}));

import { db } from "../../../src/config/database.js";
import { auditLog } from "../../../src/audit/index.js";
import { quizService } from "../../../src/modules/quizzes/quiz.service.js";
import { NotFoundError, ConflictError } from "../../../src/utils/errors.js";

const mockDb = vi.mocked(db, true);

const QUIZ = {
  id: "quiz-1",
  courseId: "course-1",
  questions: [{ id: "q1" }, { id: "q2" }],
};

describe("QuizService.submitFeedback (#331)", () => {
  beforeEach(() => vi.clearAllMocks());

  it("404s for a quiz that doesn't exist", async () => {
    (mockDb.query.quizzes.findFirst as any).mockResolvedValue(undefined);

    await expect(
      quizService.submitFeedback("u1", "missing-quiz", {
        questionId: "q1",
        type: "unclear",
      }),
    ).rejects.toThrow(NotFoundError);
  });

  it("404s for a question that isn't in the quiz", async () => {
    (mockDb.query.quizzes.findFirst as any).mockResolvedValue(QUIZ);

    await expect(
      quizService.submitFeedback("u1", "quiz-1", {
        questionId: "not-a-real-question",
        type: "unclear",
      }),
    ).rejects.toThrow(NotFoundError);
  });

  it("rejects a second submission from the same user for the same question", async () => {
    (mockDb.query.quizzes.findFirst as any).mockResolvedValue(QUIZ);
    (mockDb.query.quizFeedback.findFirst as any).mockResolvedValue({
      id: "existing",
    });

    await expect(
      quizService.submitFeedback("u1", "quiz-1", {
        questionId: "q1",
        type: "wrong",
      }),
    ).rejects.toThrow(ConflictError);

    expect(mockDb.insert).not.toHaveBeenCalled();
  });

  it("stores feedback and audit-logs it", async () => {
    (mockDb.query.quizzes.findFirst as any).mockResolvedValue(QUIZ);
    (mockDb.query.quizFeedback.findFirst as any).mockResolvedValue(undefined);

    const returning = vi.fn().mockResolvedValue([
      {
        id: "fb-1",
        quizId: "quiz-1",
        questionId: "q1",
        userId: "u1",
        type: "unclear",
        comment: "confusing wording",
        createdAt: new Date("2026-01-01"),
      },
    ]);
    mockDb.insert.mockReturnValue({
      values: vi.fn().mockReturnValue({ returning }),
    } as any);

    const result = await quizService.submitFeedback("u1", "quiz-1", {
      questionId: "q1",
      type: "unclear",
      comment: "confusing wording",
    });

    expect(result.id).toBe("fb-1");
    expect(result.type).toBe("unclear");
    expect(auditLog).toHaveBeenCalledWith(
      "quiz.feedback.submitted",
      expect.objectContaining({ userId: "u1", courseId: "course-1" }),
    );
  });

  it("converts a concurrent-insert unique violation into a ConflictError", async () => {
    (mockDb.query.quizzes.findFirst as any).mockResolvedValue(QUIZ);
    (mockDb.query.quizFeedback.findFirst as any).mockResolvedValue(undefined);

    const err = Object.assign(new Error("duplicate key"), { code: "23505" });
    mockDb.insert.mockReturnValue({
      values: vi.fn().mockReturnValue({
        returning: vi.fn().mockRejectedValue(err),
      }),
    } as any);

    await expect(
      quizService.submitFeedback("u1", "quiz-1", {
        questionId: "q1",
        type: "other",
      }),
    ).rejects.toThrow(ConflictError);
  });
});

describe("QuizService.getFeedbackSummary (#331)", () => {
  beforeEach(() => vi.clearAllMocks());

  function makeSelectChain(result: unknown[]) {
    const chain: any = {};
    chain.select = vi.fn().mockReturnValue(chain);
    chain.from = vi.fn().mockReturnValue(chain);
    chain.where = vi.fn().mockResolvedValue(result);
    return chain;
  }

  it("404s for a quiz that doesn't exist", async () => {
    (mockDb.query.quizzes.findFirst as any).mockResolvedValue(undefined);

    await expect(quizService.getFeedbackSummary("missing-quiz")).rejects.toThrow(
      NotFoundError,
    );
  });

  it("groups feedback counts per question and type", async () => {
    (mockDb.query.quizzes.findFirst as any).mockResolvedValue(QUIZ);
    mockDb.select.mockReturnValue(
      makeSelectChain([
        { questionId: "q1", type: "unclear" },
        { questionId: "q1", type: "unclear" },
        { questionId: "q1", type: "wrong" },
        { questionId: "q2", type: "other" },
      ]),
    );

    const summary = await quizService.getFeedbackSummary("quiz-1");

    expect(summary).toHaveLength(2);
    const q1 = summary.find((s) => s.questionId === "q1");
    expect(q1).toEqual({
      questionId: "q1",
      total: 3,
      counts: { unclear: 2, wrong: 1, other: 0 },
    });
    const q2 = summary.find((s) => s.questionId === "q2");
    expect(q2?.total).toBe(1);
  });

  it("returns an empty summary when there's no feedback yet", async () => {
    (mockDb.query.quizzes.findFirst as any).mockResolvedValue(QUIZ);
    mockDb.select.mockReturnValue(makeSelectChain([]));

    const summary = await quizService.getFeedbackSummary("quiz-1");

    expect(summary).toEqual([]);
  });
});
