import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("../../../src/config/database.js", () => {
  const mockDb = {
    select: vi.fn(),
    query: { quizzes: { findFirst: vi.fn() }, enrollments: { findFirst: vi.fn() } },
  };
  return { db: mockDb };
});

vi.mock("../../../src/utils/logger.js", () => ({
  logger: { info: vi.fn(), error: vi.fn(), warn: vi.fn() },
}));

vi.mock("../../../src/utils/lock.js", () => ({
  withLock: vi.fn(async (_key: string, fn: () => Promise<any>) => fn()),
}));

const cacheStore = new Map<string, unknown>();

vi.mock("../../../src/cache/index.js", () => ({
  cacheGet: vi.fn(async (_namespace: string, key: string) => cacheStore.get(key) ?? null),
  cacheSet: vi.fn(async (key: string, value: unknown) => {
    cacheStore.set(key, value);
  }),
  cacheKey: (...parts: (string | number)[]) => `chainlearn:${parts.join(":")}`,
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

describe("QuizService.getQuizStats (#307)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    cacheStore.clear();
  });

  it("computes average score, pass rate, and per-course submission counts", async () => {
    const rows = [
      { score: 4, courseId: "course-1", questions: [{}, {}, {}, {}, {}] }, // 80%
      { score: 2, courseId: "course-1", questions: [{}, {}, {}, {}, {}] }, // 40%
      { score: 5, courseId: "course-2", questions: [{}, {}, {}, {}, {}] }, // 100%
    ];
    mockDb.select.mockReturnValue(makeSelectChain(rows));

    const stats = await quizService.getQuizStats();

    expect(stats.totalSubmissions).toBe(3);
    expect(stats.averageScore).toBe(Math.round((80 + 40 + 100) / 3));
    expect(stats.passRate).toBe(Math.round((2 / 3) * 100)); // 80% and 100% pass (>=70)
    expect(stats.submissionsPerCourse).toEqual({ "course-1": 2, "course-2": 1 });
  });

  it("returns zeroed stats when there are no submissions", async () => {
    mockDb.select.mockReturnValue(makeSelectChain([]));

    const stats = await quizService.getQuizStats();

    expect(stats).toEqual({
      averageScore: 0,
      passRate: 0,
      totalSubmissions: 0,
      submissionsPerCourse: {},
    });
  });

  it("serves cached results on a repeated call without re-querying the database", async () => {
    const rows = [{ score: 5, courseId: "course-1", questions: [{}, {}, {}, {}, {}] }];
    mockDb.select.mockReturnValue(makeSelectChain(rows));

    await quizService.getQuizStats("course-1");
    mockDb.select.mockClear();

    const cached = await quizService.getQuizStats("course-1");

    expect(mockDb.select).not.toHaveBeenCalled();
    expect(cached.totalSubmissions).toBe(1);
  });

  it("keeps stats for different courseId filters in separate cache entries", async () => {
    mockDb.select.mockReturnValue(makeSelectChain([]));
    await quizService.getQuizStats("course-1");

    mockDb.select.mockReturnValue(
      makeSelectChain([{ score: 5, courseId: "course-2", questions: [{}, {}, {}, {}, {}] }]),
    );
    const other = await quizService.getQuizStats("course-2");

    expect(other.totalSubmissions).toBe(1);
  });
});
