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

vi.mock("../../../src/utils/lock.js", () => ({
  withLock: vi.fn(async (_key: string, fn: () => Promise<any>) => fn()),
}));

vi.mock("../../../src/audit/index.js", () => ({
  auditLog: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("../../../src/stellar/progress-tracker.js", () => ({
  getOnChainContentHash: vi.fn().mockResolvedValue(null),
}));

const cacheSet = vi.fn().mockResolvedValue(undefined);
vi.mock("../../../src/cache/index.js", () => ({
  cacheGet: vi.fn().mockResolvedValue(null),
  cacheSet: (...args: unknown[]) => cacheSet(...args),
  cacheDel: vi.fn().mockResolvedValue(undefined),
  cacheInvalidatePattern: vi.fn().mockResolvedValue(undefined),
  cacheKey: (...parts: (string | number)[]) => parts.join(":"),
  cacheKeyPattern: (...parts: (string | number)[]) => `${parts.join(":")}:*`,
}));

vi.mock("../../../src/config/index.js", () => ({
  config: { MAX_ENROLLMENTS: 10 },
}));

import { db } from "../../../src/config/database.js";
import { courseService } from "../../../src/modules/courses/course.service.js";
import { NotFoundError } from "../../../src/utils/errors.js";

const mockDb = vi.mocked(db, true);

function selectRows(rows: unknown[]) {
  const chain: any = {};
  chain.select = vi.fn().mockReturnValue(chain);
  chain.from = vi.fn().mockReturnValue(chain);
  chain.innerJoin = vi.fn().mockReturnValue(chain);
  chain.where = vi.fn().mockResolvedValue(rows);
  return chain;
}

const q = (n: number) => Array.from({ length: n }, (_, i) => ({ id: `q${i}` }));

describe("CourseService.getLeaderboard (#324)", () => {
  beforeEach(() => vi.clearAllMocks());

  it("404s for an unknown course", async () => {
    (mockDb.query.courses.findFirst as any).mockResolvedValue(undefined);
    await expect(courseService.getLeaderboard("missing")).rejects.toThrow(
      NotFoundError,
    );
  });

  it("ranks users by average percentage and counts quizzes taken", async () => {
    (mockDb.query.courses.findFirst as any).mockResolvedValue({
      id: "c1",
      isActive: true,
    });
    mockDb.select.mockReturnValue(
      selectRows([
        // user A: 10/10 and 8/10 -> avg 90
        { userId: "A", displayName: "Ada", score: 10, questions: q(10) },
        { userId: "A", displayName: "Ada", score: 8, questions: q(10) },
        // user B: 5/10 -> avg 50
        { userId: "B", displayName: "Bo", score: 5, questions: q(10) },
        // ungraded / empty rows are ignored
        { userId: "B", displayName: "Bo", score: null, questions: q(10) },
        { userId: "C", displayName: "Cy", score: 3, questions: [] },
      ]),
    );

    const board = await courseService.getLeaderboard("c1");

    expect(board).toEqual([
      { rank: 1, userId: "A", displayName: "Ada", averageScore: 90, quizzesTaken: 2 },
      { rank: 2, userId: "B", displayName: "Bo", averageScore: 50, quizzesTaken: 1 },
    ]);
    expect(cacheSet).toHaveBeenCalledWith(
      "courses:leaderboard:c1",
      board,
      300,
    );
  });
});
