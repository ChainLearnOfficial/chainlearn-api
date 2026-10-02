import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("../../../src/config/database.js", () => {
  const mockDb = { transaction: vi.fn() };
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

vi.mock("../../../src/cache/index.js", () => ({
  cacheGet: vi.fn().mockResolvedValue(null),
  cacheSet: vi.fn().mockResolvedValue(undefined),
  cacheDel: vi.fn().mockResolvedValue(undefined),
  cacheInvalidatePattern: vi.fn().mockResolvedValue(undefined),
  cacheKey: (...parts: (string | number)[]) => parts.join(":"),
  cacheKeyPattern: (...parts: (string | number)[]) => `${parts.join(":")}:*`,
}));

vi.mock("../../../src/config/index.js", () => ({
  config: { MAX_ENROLLMENTS: 2 },
}));

import { db } from "../../../src/config/database.js";
import { courseService } from "../../../src/modules/courses/course.service.js";

const mockDb = vi.mocked(db);

function makeChain(result: unknown[]) {
  const chain: any = {};
  chain.select = vi.fn().mockReturnValue(chain);
  chain.from = vi.fn().mockReturnValue(chain);
  chain.where = vi.fn().mockReturnValue(chain);
  chain.for = vi.fn().mockReturnValue(Promise.resolve(result));
  chain.insert = vi.fn().mockReturnValue(chain);
  chain.values = vi.fn().mockResolvedValue(undefined);
  chain.then = (resolve: any, reject: any) => Promise.resolve(result).then(resolve, reject);
  return chain;
}

describe("CourseService.enroll — enrollment limit (#306)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("rejects enrollment with 403 once the active enrollment cap is reached", async () => {
    const course = { id: "course-3", isActive: true, contentHash: null };
    let callIndex = 0;
    // Call order inside the transaction: courses lookup, existing-enrollment
    // lookup (.for("update")), active-enrollment count.
    const responses = [[course], [], [{ value: 2 }]];

    mockDb.transaction.mockImplementation(async (fn: any) => {
      const tx: any = {};
      tx.select = vi.fn().mockImplementation(() => makeChain(responses[callIndex++]));
      tx.insert = vi.fn().mockReturnValue({ values: vi.fn().mockResolvedValue(undefined) });
      return fn(tx);
    });

    await expect(courseService.enroll("user-1", "course-3")).rejects.toThrow(
      /Enrollment limit reached: 2\/2/,
    );
  });

  it("allows enrollment when under the active enrollment cap", async () => {
    const course = { id: "course-3", isActive: true, contentHash: null };
    let callIndex = 0;
    const responses = [[course], [], [{ value: 1 }]];
    const insertValues = vi.fn().mockResolvedValue(undefined);

    mockDb.transaction.mockImplementation(async (fn: any) => {
      const tx: any = {};
      tx.select = vi.fn().mockImplementation(() => makeChain(responses[callIndex++]));
      tx.insert = vi.fn().mockReturnValue({ values: insertValues });
      return fn(tx);
    });

    const result = await courseService.enroll("user-1", "course-3");

    expect(result.contentHashMismatch).toBe(false);
    expect(insertValues).toHaveBeenCalledWith({ userId: "user-1", courseId: "course-3" });
  });
});
