import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("../../../src/config/database.js", () => {
  const mockDb = {
    select: vi.fn(),
    transaction: vi.fn(),
    query: {
      quizzes: { findFirst: vi.fn() },
      courses: { findFirst: vi.fn() },
      enrollments: { findFirst: vi.fn() },
    },
  };
  return { db: mockDb };
});

vi.mock("../../../src/utils/logger.js", () => ({
  logger: { info: vi.fn(), error: vi.fn(), warn: vi.fn() },
}));

vi.mock("../../../src/utils/lock.js", () => ({
  withLock: vi.fn(async (_key: string, fn: () => Promise<any>) => fn()),
}));

vi.mock("../../../src/audit/index.js", () => ({
  auditLog: vi.fn().mockResolvedValue(undefined),
}));

const cacheStore = new Map<string, unknown>();

vi.mock("../../../src/cache/index.js", () => ({
  cacheGet: vi.fn(async (_namespace: string, key: string) => cacheStore.get(key) ?? null),
  cacheSet: vi.fn(async (key: string, value: unknown) => {
    cacheStore.set(key, value);
  }),
  cacheDel: vi.fn().mockResolvedValue(undefined),
  cacheKey: (...parts: (string | number)[]) => `chainlearn:${parts.join(":")}`,
  cacheKeyPattern: (...parts: (string | number)[]) => `chainlearn:${parts.join(":")}:*`,
  cacheInvalidatePattern: vi.fn().mockResolvedValue(undefined),
  cacheGetOrSet: vi.fn(
    async (
      _namespace: string,
      key: string,
      fetchFn: () => Promise<unknown>,
    ) => {
      const cached = cacheStore.get(key);
      if (cached !== undefined) return cached;
      const value = await fetchFn();
      cacheStore.set(key, value);
      return value;
    },
  ),
}));

import { db } from "../../../src/config/database.js";
import { auditLog } from "../../../src/audit/index.js";
import { quizService } from "../../../src/modules/quizzes/quiz.service.js";
import { NotFoundError } from "../../../src/utils/errors.js";
import { archiveModuleQuizSchema } from "../../../src/modules/quizzes/quiz.types.js";

describe("archiveModuleQuizSchema (#416)", () => {
  it("defaults to archived: true when the body is empty", () => {
    const result = archiveModuleQuizSchema.safeParse({});
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.archived).toBe(true);
    }
  });

  it("accepts an explicit archived: false to unarchive", () => {
    const result = archiveModuleQuizSchema.safeParse({ archived: false });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.archived).toBe(false);
    }
  });

  it("rejects a non-boolean archived value", () => {
    const result = archiveModuleQuizSchema.safeParse({ archived: "yes" });
    expect(result.success).toBe(false);
  });
});

const mockDb = vi.mocked(db, true);

function makeSelectChain(result: unknown[]) {
  const chain: any = {};
  chain.select = vi.fn().mockReturnValue(chain);
  chain.from = vi.fn().mockReturnValue(chain);
  chain.innerJoin = vi.fn().mockReturnValue(chain);
  chain.where = vi.fn().mockResolvedValue(result);
  return chain;
}

const COURSE = { id: "course-1", modules: [{ id: "m1" }] };

describe("QuizService.getModuleQuizHistory (#415)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    cacheStore.clear();
  });

  it("404s when the module doesn't belong to the course", async () => {
    (mockDb.query.courses.findFirst as any).mockResolvedValue(COURSE);

    await expect(
      quizService.getModuleQuizHistory("course-1", "not-a-module"),
    ).rejects.toThrow();
  });

  it("404s when the course doesn't exist", async () => {
    (mockDb.query.courses.findFirst as any).mockResolvedValue(undefined);

    await expect(
      quizService.getModuleQuizHistory("missing-course", "m1"),
    ).rejects.toThrow(NotFoundError);
  });

  it("computes aggregate stats and score distribution across all quizzes in the module", async () => {
    (mockDb.query.courses.findFirst as any).mockResolvedValue(COURSE);
    const rows = [
      { score: 5, questions: [{}, {}, {}, {}, {}], quizId: "quiz-1" }, // 100%
      { score: 4, questions: [{}, {}, {}, {}, {}], quizId: "quiz-1" }, // 80%
      { score: 1, questions: [{}, {}, {}, {}, {}], quizId: "quiz-2" }, // 20%
      { score: 3, questions: [{}, {}, {}, {}, {}], quizId: "quiz-2" }, // 60%
    ];
    mockDb.select.mockReturnValue(makeSelectChain(rows));

    const history = await quizService.getModuleQuizHistory("course-1", "m1");

    expect(history.courseId).toBe("course-1");
    expect(history.moduleId).toBe("m1");
    expect(history.quizCount).toBe(2);
    expect(history.totalAttempts).toBe(4);
    expect(history.averageScore).toBe(Math.round((100 + 80 + 20 + 60) / 4));
    expect(history.passRate).toBe(Math.round((2 / 4) * 100)); // 100% and 80% pass (>=70)
    expect(history.scoreDistribution).toEqual({
      "0-20": 1,
      "21-40": 0,
      "41-60": 1,
      "61-80": 1,
      "81-100": 1,
    });
  });

  it("returns zeroed stats for a module with zero submissions instead of crashing", async () => {
    (mockDb.query.courses.findFirst as any).mockResolvedValue(COURSE);
    mockDb.select.mockReturnValue(makeSelectChain([]));

    const history = await quizService.getModuleQuizHistory("course-1", "m1");

    expect(history).toEqual({
      courseId: "course-1",
      moduleId: "m1",
      quizCount: 0,
      totalAttempts: 0,
      averageScore: 0,
      passRate: 0,
      scoreDistribution: {
        "0-20": 0,
        "21-40": 0,
        "41-60": 0,
        "61-80": 0,
        "81-100": 0,
      },
    });
  });

  it("serves cached results on a repeated call without re-querying the database", async () => {
    (mockDb.query.courses.findFirst as any).mockResolvedValue(COURSE);
    mockDb.select.mockReturnValue(
      makeSelectChain([{ score: 5, questions: [{}, {}, {}, {}, {}], quizId: "quiz-1" }]),
    );

    await quizService.getModuleQuizHistory("course-1", "m1");
    mockDb.select.mockClear();

    const cached = await quizService.getModuleQuizHistory("course-1", "m1");

    expect(mockDb.select).not.toHaveBeenCalled();
    expect(cached.totalAttempts).toBe(1);
  });

  it("keeps different modules in separate cache entries", async () => {
    (mockDb.query.courses.findFirst as any).mockResolvedValue({
      id: "course-1",
      modules: [{ id: "m1" }, { id: "m2" }],
    });
    mockDb.select.mockReturnValue(makeSelectChain([]));
    await quizService.getModuleQuizHistory("course-1", "m1");

    mockDb.select.mockReturnValue(
      makeSelectChain([{ score: 5, questions: [{}, {}, {}, {}, {}], quizId: "quiz-2" }]),
    );
    const other = await quizService.getModuleQuizHistory("course-1", "m2");

    expect(other.totalAttempts).toBe(1);
  });
});

describe("QuizService.getQuizAnalytics (#417)", () => {
  const QUIZ = {
    id: "quiz-1",
    courseId: "course-1",
    moduleId: "m1",
    questions: [
      { id: "q1", text: "Q1", options: ["a", "b", "c"], correctIndex: 0 },
      { id: "q2", text: "Q2", options: ["a", "b"], correctIndex: 1 },
    ],
  };

  beforeEach(() => {
    vi.clearAllMocks();
    cacheStore.clear();
  });

  it("404s for a quiz that doesn't belong to the course/module", async () => {
    mockDb.select.mockReturnValue(makeSelectChain([]));

    await expect(
      quizService.getQuizAnalytics("course-1", "m1", "missing-quiz"),
    ).rejects.toThrow(NotFoundError);
  });

  it("computes per-question correct rate, common wrong answer, and score distribution", async () => {
    // First select() call is assertQuizInModule's lookup; second is the
    // quizSubmissions fetch. Both go through db.select in this service.
    let call = 0;
    mockDb.select.mockImplementation(() => {
      call++;
      if (call === 1) return makeSelectChain([QUIZ]);
      return makeSelectChain([
        // q1 correct (0), q2 correct (1) -> score 2/2 = 100%
        {
          score: 2,
          answers: [
            { questionId: "q1", selectedIndex: 0 },
            { questionId: "q2", selectedIndex: 1 },
          ],
          superseded: false,
        },
        // q1 wrong (1), q2 wrong (0) -> score 0/2 = 0%
        {
          score: 0,
          answers: [
            { questionId: "q1", selectedIndex: 1 },
            { questionId: "q2", selectedIndex: 0 },
          ],
          superseded: false,
        },
        // q1 wrong (1) again -> reinforces selectedIndex 1 as the common wrong answer
        {
          score: 1,
          answers: [
            { questionId: "q1", selectedIndex: 1 },
            { questionId: "q2", selectedIndex: 1 },
          ],
          superseded: false,
        },
        // A superseded (retried-over) submission — excluded from score stats
        // and per-question breakdown, but counted in attempt patterns.
        {
          score: 0,
          answers: [{ questionId: "q1", selectedIndex: 2 }],
          superseded: true,
        },
      ]);
    });

    const analytics = await quizService.getQuizAnalytics(
      "course-1",
      "m1",
      "quiz-1",
    );

    expect(analytics.quizId).toBe("quiz-1");
    expect(analytics.totalAttempts).toBe(4);
    expect(analytics.currentAttempts).toBe(3);
    expect(analytics.supersededAttempts).toBe(1);
    expect(analytics.perQuestionTimingAvailable).toBe(false);

    const q1 = analytics.questions.find((q) => q.questionId === "q1")!;
    expect(q1.totalAnswered).toBe(3);
    expect(q1.correctCount).toBe(1);
    expect(q1.correctRate).toBe(Math.round((1 / 3) * 100));
    expect(q1.commonWrongAnswer).toEqual({ selectedIndex: 1, count: 2 });
    expect(q1.averageTimeSeconds).toBeNull();

    const q2 = analytics.questions.find((q) => q.questionId === "q2")!;
    expect(q2.totalAnswered).toBe(3);
    expect(q2.correctCount).toBe(2);
    expect(q2.commonWrongAnswer).toEqual({ selectedIndex: 0, count: 1 });

    // Scores from current submissions only: 100%, 0%, 50% -> avg 50
    expect(analytics.averageScore).toBe(Math.round((100 + 0 + 50) / 3));
  });

  it("returns sensible empty stats for a quiz with zero submissions instead of crashing", async () => {
    let call = 0;
    mockDb.select.mockImplementation(() => {
      call++;
      if (call === 1) return makeSelectChain([QUIZ]);
      return makeSelectChain([]);
    });

    const analytics = await quizService.getQuizAnalytics(
      "course-1",
      "m1",
      "quiz-1",
    );

    expect(analytics.totalAttempts).toBe(0);
    expect(analytics.currentAttempts).toBe(0);
    expect(analytics.averageScore).toBe(0);
    expect(analytics.passRate).toBe(0);
    expect(analytics.questions).toHaveLength(2);
    for (const question of analytics.questions) {
      expect(question.totalAnswered).toBe(0);
      expect(question.correctCount).toBe(0);
      expect(question.correctRate).toBe(0);
      expect(question.commonWrongAnswer).toBeNull();
    }
  });

  it("serves the cached aggregate on a repeated call without re-querying quizSubmissions", async () => {
    // getQuizAnalytics always re-verifies the quiz exists in this
    // course/module (assertQuizInModule) before consulting the cache — that
    // guard is cheap and keeps a deleted/moved quiz from serving a stale
    // cached analytics payload. What the cache actually saves is the
    // quizSubmissions aggregation query below it.
    let quizLookups = 0;
    let submissionAggregations = 0;
    mockDb.select.mockImplementation(() => {
      quizLookups++;
      // The Nth call to db.select() alternates: odd calls are
      // assertQuizInModule's quiz lookup, even calls (only reached on a
      // cache miss) are the submissions aggregation.
      if (quizLookups % 2 === 1) {
        return makeSelectChain([QUIZ]);
      }
      submissionAggregations++;
      return makeSelectChain([]);
    });

    await quizService.getQuizAnalytics("course-1", "m1", "quiz-1");
    expect(quizLookups).toBe(2); // quiz lookup + submissions aggregation
    expect(submissionAggregations).toBe(1);

    const cached = await quizService.getQuizAnalytics(
      "course-1",
      "m1",
      "quiz-1",
    );

    // Exactly one more select() happened (the quiz-existence re-check).
    // The submissions aggregation was served from cache, not re-queried.
    expect(quizLookups).toBe(3);
    expect(submissionAggregations).toBe(1);
    expect(cached.quizId).toBe("quiz-1");
  });
});

describe("QuizService.archiveModuleQuiz (#416)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    cacheStore.clear();
  });

  function mockTransaction(existingQuiz: Record<string, unknown> | undefined) {
    mockDb.transaction.mockImplementation(async (fn: any) => {
      const tx: any = {};
      const forUpdate = vi.fn().mockResolvedValue(
        existingQuiz ? [existingQuiz] : [],
      );
      tx.select = vi.fn().mockReturnValue({
        from: vi.fn().mockReturnValue({
          where: vi.fn().mockReturnValue({ for: forUpdate }),
        }),
      });
      tx.update = vi.fn().mockReturnValue({
        set: vi.fn().mockReturnValue({
          where: vi.fn().mockReturnValue({
            returning: vi.fn().mockResolvedValue([
              { ...existingQuiz, archivedAt: new Date("2026-01-01") },
            ]),
          }),
        }),
      });
      return fn(tx);
    });
  }

  it("archives a quiz by delegating to the #413 update path and audit-logs it", async () => {
    const existing = {
      id: "quiz-1",
      courseId: "course-1",
      moduleId: "m1",
      questions: [{ id: "q1" }],
      metadata: {},
      archivedAt: null,
    };
    mockTransaction(existing);
    mockDb.select.mockReturnValue(makeSelectChain([{ value: 0 }]));

    const result = await quizService.archiveModuleQuiz(
      "course-1",
      "m1",
      "quiz-1",
      true,
    );

    expect(result.archivedAt).not.toBeNull();
    expect(auditLog).toHaveBeenCalledWith(
      "course.quiz.updated",
      expect.objectContaining({
        quizId: "quiz-1",
        courseId: "course-1",
        moduleId: "m1",
        changes: ["archived"],
      }),
    );
  });

  it("unarchives a quiz when archived: false is passed", async () => {
    const existing = {
      id: "quiz-1",
      courseId: "course-1",
      moduleId: "m1",
      questions: [{ id: "q1" }],
      metadata: {},
      archivedAt: new Date("2025-01-01"),
    };
    mockDb.transaction.mockImplementation(async (fn: any) => {
      const tx: any = {};
      tx.select = vi.fn().mockReturnValue({
        from: vi.fn().mockReturnValue({
          where: vi.fn().mockReturnValue({
            for: vi.fn().mockResolvedValue([existing]),
          }),
        }),
      });
      tx.update = vi.fn().mockReturnValue({
        set: vi.fn().mockReturnValue({
          where: vi.fn().mockReturnValue({
            returning: vi
              .fn()
              .mockResolvedValue([{ ...existing, archivedAt: null }]),
          }),
        }),
      });
      return fn(tx);
    });
    mockDb.select.mockReturnValue(makeSelectChain([{ value: 0 }]));

    const result = await quizService.archiveModuleQuiz(
      "course-1",
      "m1",
      "quiz-1",
      false,
    );

    expect(result.archivedAt).toBeNull();
  });

  it("404s when the quiz doesn't belong to the course/module", async () => {
    mockTransaction(undefined);

    await expect(
      quizService.archiveModuleQuiz("course-1", "m1", "missing-quiz", true),
    ).rejects.toThrow(NotFoundError);
  });
});
