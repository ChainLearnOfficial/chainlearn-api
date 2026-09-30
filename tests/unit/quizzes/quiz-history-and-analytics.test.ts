/**
 * #415 — GET .../quiz-history (module-level aggregate: avg score, pass
 * rate, total attempts, score distribution).
 * #417 — GET .../quizzes/:quizId/analytics (per-question correct rate,
 * common wrong answers, score distribution for one quiz).
 * #416 — POST .../quizzes/:quizId/archive (thin wrapper around
 * updateModuleQuizDetails, exercised at the controller level since the
 * service logic it delegates to is unchanged).
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("../../../src/config/database.js", () => {
  const mockDb = {
    select: vi.fn(),
    query: { courses: { findFirst: vi.fn() } },
  };
  return { db: mockDb };
});

vi.mock("../../../src/utils/logger.js", () => ({
  logger: { info: vi.fn(), error: vi.fn(), warn: vi.fn() },
}));

const cacheStore = new Map<string, unknown>();

vi.mock("../../../src/cache/index.js", () => ({
  cacheGet: vi.fn(async (_namespace: string, key: string) => cacheStore.get(key) ?? null),
  cacheSet: vi.fn(async (key: string, value: unknown) => {
    cacheStore.set(key, value);
  }),
  cacheDel: vi.fn().mockResolvedValue(undefined),
  cacheInvalidatePattern: vi.fn().mockResolvedValue(undefined),
  cacheKey: (...parts: (string | number)[]) => `chainlearn:${parts.join(":")}`,
  cacheKeyPattern: (...parts: (string | number)[]) => `chainlearn:${parts.join(":")}:*`,
}));

import { db } from "../../../src/config/database.js";
import { quizService } from "../../../src/modules/quizzes/quiz.service.js";

const mockDb = vi.mocked(db);

function makeSelectChain(result: unknown[]) {
  const chain: any = {};
  chain.select = vi.fn().mockReturnValue(chain);
  chain.from = vi.fn().mockReturnValue(chain);
  chain.innerJoin = vi.fn().mockReturnValue(chain);
  chain.where = vi.fn().mockResolvedValue(result);
  return chain;
}

const COURSE = { id: "course-1", modules: [{ id: "m1", title: "Intro", description: "", order: 0 }] };

describe("QuizService.getModuleQuizHistory (#415)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    cacheStore.clear();
    mockDb.query.courses.findFirst.mockResolvedValue(COURSE as any);
  });

  it("computes average score, pass rate, total attempts, and a decile distribution", async () => {
    const rows = [
      { score: 4, questions: [{}, {}, {}, {}, {}] }, // 80%
      { score: 2, questions: [{}, {}, {}, {}, {}] }, // 40%
      { score: 5, questions: [{}, {}, {}, {}, {}] }, // 100%
    ];
    mockDb.select.mockReturnValue(makeSelectChain(rows));

    const history = await quizService.getModuleQuizHistory("course-1", "m1");

    expect(history.totalAttempts).toBe(3);
    expect(history.averageScore).toBe(Math.round((80 + 40 + 100) / 3));
    expect(history.passRate).toBe(Math.round((2 / 3) * 100)); // 80% and 100% pass
    expect(history.scoreDistribution).toEqual({ "80-89": 1, "40-49": 1, "90-100": 1 });
  });

  it("returns zeroed history when the module has no attempts", async () => {
    mockDb.select.mockReturnValue(makeSelectChain([]));

    const history = await quizService.getModuleQuizHistory("course-1", "m1");

    expect(history).toEqual({
      moduleId: "m1",
      totalAttempts: 0,
      averageScore: 0,
      passRate: 0,
      scoreDistribution: {},
    });
  });

  it("rejects a moduleId that isn't one of the course's modules", async () => {
    await expect(
      quizService.getModuleQuizHistory("course-1", "does-not-exist"),
    ).rejects.toThrow();
  });

  it("serves cached results on a repeated call without re-querying the database", async () => {
    mockDb.select.mockReturnValue(makeSelectChain([{ score: 5, questions: [{}, {}, {}, {}, {}] }]));

    await quizService.getModuleQuizHistory("course-1", "m1");
    mockDb.select.mockClear();

    const cached = await quizService.getModuleQuizHistory("course-1", "m1");

    expect(mockDb.select).not.toHaveBeenCalled();
    expect(cached.totalAttempts).toBe(1);
  });
});

describe("QuizService.getQuizAnalytics (#417)", () => {
  const quiz = {
    id: "quiz-1",
    courseId: "course-1",
    moduleId: "m1",
    questions: [
      { id: "q1", text: "2+2?", options: ["3", "4"], correctIndex: 1 },
      { id: "q2", text: "Capital of France?", options: ["Paris", "Lyon"], correctIndex: 0 },
    ],
  };

  beforeEach(() => {
    vi.clearAllMocks();
    cacheStore.clear();
  });

  it("reports per-question correct rate, common wrong answers, and a score distribution", async () => {
    mockDb.select
      .mockReturnValueOnce(makeSelectChain([quiz]))
      .mockReturnValueOnce(
        makeSelectChain([
          { answers: [{ questionId: "q1", selectedIndex: 1 }, { questionId: "q2", selectedIndex: 1 }], score: 1 },
          { answers: [{ questionId: "q1", selectedIndex: 0 }, { questionId: "q2", selectedIndex: 1 }], score: 0 },
          { answers: [{ questionId: "q1", selectedIndex: 1 }, { questionId: "q2", selectedIndex: 0 }], score: 2 },
        ]),
      );

    const analytics = await quizService.getQuizAnalytics("course-1", "m1", "quiz-1");

    expect(analytics.totalAttempts).toBe(3);

    const q1 = analytics.questions.find((q) => q.questionId === "q1")!;
    expect(q1.totalAnswered).toBe(3);
    expect(q1.correctCount).toBe(2);
    expect(q1.correctRate).toBe(Math.round((2 / 3) * 100));
    expect(q1.commonWrongAnswers).toEqual([{ selectedIndex: 0, count: 1 }]);

    const q2 = analytics.questions.find((q) => q.questionId === "q2")!;
    expect(q2.correctCount).toBe(1);
    expect(q2.commonWrongAnswers).toEqual([{ selectedIndex: 1, count: 2 }]);
  });

  it("throws NotFoundError when the quiz doesn't belong to the given course/module", async () => {
    mockDb.select.mockReturnValueOnce(
      makeSelectChain([{ ...quiz, courseId: "some-other-course" }]),
    );

    await expect(
      quizService.getQuizAnalytics("course-1", "m1", "quiz-1"),
    ).rejects.toThrow();
  });

  it("serves cached results on a repeated call without re-querying submissions", async () => {
    mockDb.select
      .mockReturnValueOnce(makeSelectChain([quiz]))
      .mockReturnValueOnce(makeSelectChain([]));

    await quizService.getQuizAnalytics("course-1", "m1", "quiz-1");

    // assertQuizInModule re-validates the quiz on every call (matching
    // getModuleQuizHistory's course-assert-before-cache pattern) — only the
    // submissions aggregation is skipped on a cache hit.
    mockDb.select.mockReset();
    mockDb.select.mockReturnValueOnce(makeSelectChain([quiz]));

    const cached = await quizService.getQuizAnalytics("course-1", "m1", "quiz-1");

    expect(mockDb.select).toHaveBeenCalledTimes(1);
    expect(cached.totalAttempts).toBe(0);
  });
});

describe("QuizController.archiveModuleQuiz (#416)", () => {
  it("delegates to updateModuleQuizDetails with { archived: true }", async () => {
    const spy = vi
      .spyOn(quizService, "updateModuleQuizDetails")
      .mockResolvedValue({ id: "quiz-1", archivedAt: new Date() } as any);

    const { quizController } = await import("../../../src/modules/quizzes/quiz.controller.js");
    const reply = { send: vi.fn() } as any;
    await quizController.archiveModuleQuiz(
      { params: { id: "course-1", moduleId: "m1", quizId: "quiz-1" } } as any,
      reply,
    );

    expect(spy).toHaveBeenCalledWith("course-1", "m1", "quiz-1", { archived: true });
    expect(reply.send).toHaveBeenCalledWith({
      success: true,
      data: { id: "quiz-1", archivedAt: expect.any(Date) },
    });

    spy.mockRestore();
  });
});
