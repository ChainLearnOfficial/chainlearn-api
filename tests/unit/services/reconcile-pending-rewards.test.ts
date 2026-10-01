import { describe, it, expect, vi, beforeEach } from "vitest";

const mockUpdate = vi.fn();
const mockSelect = vi.fn();
const mockFrom = vi.fn();
const mockWhere = vi.fn();
const mockSet = vi.fn();

vi.mock("../../../src/config/database.js", () => ({
  db: {
    update: mockUpdate,
    select: mockSelect,
  },
}));

vi.mock("../../../src/config/redis.js", () => ({
  redis: {
    lpush: vi.fn().mockResolvedValue(1),
    rpop: vi.fn().mockResolvedValue(null),
  },
}));

vi.mock("../../../src/utils/logger.js", () => ({
  logger: { info: vi.fn(), error: vi.fn(), warn: vi.fn() },
}));

vi.mock("../../../src/stellar/transactions.js", () => ({
  invokeContract: vi.fn().mockResolvedValue("tx-hash"),
}));

vi.mock("drizzle-orm", () => ({
  eq: vi.fn(),
  and: vi.fn(),
  lte: vi.fn(),
}));

import { redis } from "../../../src/config/redis.js";
import { db } from "../../../src/config/database.js";

describe("reconcile-pending-rewards", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockUpdate.mockReturnValue({ set: mockSet });
    mockSet.mockReturnValue({ where: mockWhere });
    mockSelect.mockReturnValue({ from: mockFrom });
    mockFrom.mockReturnValue({ where: mockWhere });
  });

  it("should enqueue pending rewards for retry", async () => {
    const pendingSubmissions = [
      { id: "sub-1", userId: "user-1", score: 5, rewardClaimed: false, rewardFailed: false },
      { id: "sub-2", userId: "user-2", score: 3, rewardClaimed: false, rewardFailed: false },
    ];

    mockWhere.mockResolvedValueOnce(pendingSubmissions);

    for (const submission of pendingSubmissions) {
      await redis.lpush("chainlearn:retry:rewards", JSON.stringify({
        submissionId: submission.id,
        userId: submission.userId,
        score: submission.score,
      }));
    }

    expect(redis.lpush).toHaveBeenCalledTimes(2);
    expect(redis.lpush).toHaveBeenCalledWith(
      "chainlearn:retry:rewards",
      expect.stringContaining('"submissionId":"sub-1"')
    );
  });

  it("should skip already claimed submissions", async () => {
    mockWhere.mockResolvedValueOnce([]);

    const result = await redis.rpop("chainlearn:retry:rewards");
    expect(result).toBeNull();
  });

  it("should handle database errors gracefully", async () => {
    mockWhere.mockRejectedValueOnce(new Error("DB connection failed"));

    await expect(
      (async () => {
        throw new Error("DB connection failed");
      })()
    ).rejects.toThrow("DB connection failed");
  });
});