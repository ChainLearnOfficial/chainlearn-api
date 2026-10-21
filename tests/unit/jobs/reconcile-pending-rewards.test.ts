import { describe, it, expect, vi, beforeEach } from "vitest";

// ─── Mocks ────────────────────────────────────────────────────────────────────

const { mockUpdate, mockSet, mockWhere, mockFrom, mockTransaction } = vi.hoisted(() => ({
  mockUpdate: vi.fn(),
  mockSet: vi.fn(),
  mockWhere: vi.fn(),
  mockFrom: vi.fn(),
  mockTransaction: vi.fn(),
}));

vi.mock("../../../src/config/database.js", () => ({
  db: {
    select: vi.fn(() => ({ from: mockFrom })),
    update: mockUpdate,
    transaction: mockTransaction,
  },
}));

vi.mock("../../../src/database/schema.js", () => ({
  quizSubmissions: { id: "id", userId: "userId", score: "score", rewardPending: "rewardPending", rewardClaimed: "rewardClaimed", txHash: "txHash", submittedAt: "submittedAt" },
  users: { id: "userId", credits: "credits" },
}));

vi.mock("drizzle-orm", async () => {
  const actual = await vi.importActual<typeof import("drizzle-orm")>("drizzle-orm");
  return {
    ...actual,
    eq: vi.fn((col, val) => ({ eq: [col, val] })),
    and: vi.fn((...args) => ({ and: args })),
    isNotNull: vi.fn((col) => ({ isNotNull: col })),
    ne: vi.fn((col, val) => ({ ne: [col, val] })),
    sql: vi.fn((strings: TemplateStringsArray, ...values: unknown[]) => ({ sql: true })),
    lte: vi.fn((col, val) => ({ lte: [col, val] })),
  };
});

const { mockGetTransaction } = vi.hoisted(() => ({ mockGetTransaction: vi.fn() }));
vi.mock("../../../src/stellar/client.js", () => ({
  stellarClient: {
    getTransaction: mockGetTransaction,
  },
}));

vi.mock("../../../src/utils/logger.js", () => ({
  logger: { info: vi.fn(), error: vi.fn(), warn: vi.fn() },
}));

vi.mock("../../../src/config/redis.js", () => ({
  redis: {
    get: vi.fn(),
    set: vi.fn(),
    del: vi.fn(),
  },
}));

// ─── Tests ────────────────────────────────────────────────────────────────────

import { reconcilePendingRewards } from "../../../src/jobs/reconcile-pending-rewards.js";
import { db } from "../../../src/config/database.js";

function buildSelectChain(rows: unknown[]) {
  const chain = {
    from: vi.fn().mockReturnThis(),
    where: vi.fn().mockReturnThis(),
    limit: vi.fn().mockResolvedValue(rows),
  };
  return chain;
}

describe("reconcilePendingRewards (#207)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockUpdate.mockReturnValue({ set: mockSet });
    mockSet.mockReturnValue({ where: mockWhere });
    mockWhere.mockResolvedValue([]);
    mockTransaction.mockImplementation(async (fn: (tx: unknown) => unknown) => fn({
      update: vi.fn().mockReturnValue({ set: vi.fn().mockReturnValue({ where: vi.fn().mockResolvedValue([]) }) }),
    }));
  });

  it("grants credits when Horizon confirms the transaction as SUCCESS", async () => {
    const pendingChain = buildSelectChain([
      { id: "sub-1", userId: "user-1", txHash: "abc123" },
    ]);
    const badSeqChain = buildSelectChain([]);

    let callCount = 0;
    vi.mocked(db.select).mockImplementation(() => {
      callCount++;
      return (callCount === 1 ? pendingChain : badSeqChain) as any;
    });

    mockGetTransaction.mockResolvedValue({ status: "SUCCESS" });

    await reconcilePendingRewards();

    expect(mockGetTransaction).toHaveBeenCalledWith("abc123");
    expect(mockTransaction).toHaveBeenCalledOnce();
  });

  it("marks submission as failed when Horizon returns FAILED", async () => {
    const pendingChain = buildSelectChain([
      { id: "sub-2", userId: "user-2", txHash: "dead0000" },
    ]);
    const badSeqChain = buildSelectChain([]);

    let callCount = 0;
    vi.mocked(db.select).mockImplementation(() => {
      callCount++;
      return (callCount === 1 ? pendingChain : badSeqChain) as any;
    });

    mockGetTransaction.mockResolvedValue({ status: "FAILED" });

    await reconcilePendingRewards();

    expect(mockGetTransaction).toHaveBeenCalledWith("dead0000");
    expect(mockUpdate).toHaveBeenCalled();
  });

  it("marks submission as failed when Horizon returns NOT_FOUND", async () => {
    const pendingChain = buildSelectChain([
      { id: "sub-3", userId: "user-3", txHash: "notfound" },
    ]);
    const badSeqChain = buildSelectChain([]);

    let callCount = 0;
    vi.mocked(db.select).mockImplementation(() => {
      callCount++;
      return (callCount === 1 ? pendingChain : badSeqChain) as any;
    });

    mockGetTransaction.mockResolvedValue({ status: "NOT_FOUND" });

    await reconcilePendingRewards();

    expect(mockUpdate).toHaveBeenCalled();
  });

  it("does not throw when Horizon is unreachable for a submission", async () => {
    const pendingChain = buildSelectChain([
      { id: "sub-4", userId: "user-4", txHash: "tx-horizon-down" },
    ]);
    const badSeqChain = buildSelectChain([]);

    let callCount = 0;
    vi.mocked(db.select).mockImplementation(() => {
      callCount++;
      return (callCount === 1 ? pendingChain : badSeqChain) as any;
    });

    mockGetTransaction.mockRejectedValue(new Error("Horizon timeout"));

    await expect(reconcilePendingRewards()).resolves.not.toThrow();
    // Submission should stay pending (no update called with failed status)
    expect(mockTransaction).not.toHaveBeenCalled();
  });

  it("releases bad_seq pending submissions so they can be retried", async () => {
    const pendingChain = buildSelectChain([]);
    const badSeqChain = buildSelectChain([
      { id: "sub-5", userId: "user-5", txHash: "pending_indexer_confirmation" },
    ]);

    let callCount = 0;
    vi.mocked(db.select).mockImplementation(() => {
      callCount++;
      return (callCount === 1 ? pendingChain : badSeqChain) as any;
    });

    await reconcilePendingRewards();

    // Should update the bad_seq entry to clear pending status
    expect(mockUpdate).toHaveBeenCalled();
  });

  it("does nothing when there are no pending submissions", async () => {
    const emptyChain = buildSelectChain([]);
    vi.mocked(db.select).mockImplementation(() => emptyChain as any);

    await reconcilePendingRewards();

    expect(mockGetTransaction).not.toHaveBeenCalled();
    expect(mockTransaction).not.toHaveBeenCalled();
  });

  it("does not throw when the initial pending-submissions query itself rejects (#609/#610 error handling)", async () => {
    vi.mocked(db.select).mockImplementation(() => {
      throw new Error("connection pool exhausted");
    });

    await expect(reconcilePendingRewards()).resolves.not.toThrow();
    expect(mockGetTransaction).not.toHaveBeenCalled();
  });
});

describe("startReconciliationJob / stopReconciliationJob", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    const emptyChain = buildSelectChain([]);
    vi.mocked(db.select).mockImplementation(() => emptyChain as any);
  });

  afterEach(async () => {
    const { stopReconciliationJob } = await import("../../../src/jobs/reconcile-pending-rewards.js");
    stopReconciliationJob();
    vi.useRealTimers();
  });

  it("runs an immediate pass on start, then on a 5-minute interval", async () => {
    const { startReconciliationJob } = await import("../../../src/jobs/reconcile-pending-rewards.js");

    startReconciliationJob();
    // Flush the immediate (un-awaited) reconcilePendingRewards() call.
    await vi.advanceTimersByTimeAsync(0);

    expect(vi.mocked(db.select)).toHaveBeenCalled();

    const callsAfterStart = vi.mocked(db.select).mock.calls.length;
    await vi.advanceTimersByTimeAsync(5 * 60 * 1000);

    expect(vi.mocked(db.select).mock.calls.length).toBeGreaterThan(callsAfterStart);
  });

  it("stops scheduling further runs once stopped", async () => {
    const { startReconciliationJob, stopReconciliationJob } = await import(
      "../../../src/jobs/reconcile-pending-rewards.js"
    );

    startReconciliationJob();
    await vi.advanceTimersByTimeAsync(0);

    stopReconciliationJob();
    const callsAfterStop = vi.mocked(db.select).mock.calls.length;

    await vi.advanceTimersByTimeAsync(5 * 60 * 1000);

    expect(vi.mocked(db.select).mock.calls.length).toBe(callsAfterStop);
  });

  it("is a no-op if already running", async () => {
    const { startReconciliationJob } = await import("../../../src/jobs/reconcile-pending-rewards.js");

    startReconciliationJob();
    await vi.advanceTimersByTimeAsync(0);
    const callsAfterFirstStart = vi.mocked(db.select).mock.calls.length;

    startReconciliationJob();
    await vi.advanceTimersByTimeAsync(0);

    // A second start() while already running must not trigger another
    // immediate run.
    expect(vi.mocked(db.select).mock.calls.length).toBe(callsAfterFirstStart);
  });
});
