import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

vi.mock("../../../src/config/database.js", () => ({
  db: {
    execute: vi.fn().mockResolvedValue([]),
    update: vi.fn().mockReturnThis(),
    set: vi.fn().mockReturnThis(),
    where: vi.fn().mockResolvedValue([]),
  },
}));

vi.mock("../../../src/config/redis.js", () => ({
  redis: {
    ping: vi.fn().mockResolvedValue("PONG"),
    zadd: vi.fn().mockResolvedValue(1),
    eval: vi.fn().mockResolvedValue([]),
    lpush: vi.fn().mockResolvedValue(1),
    llen: vi.fn().mockResolvedValue(0),
    lrange: vi.fn().mockResolvedValue([]),
  },
}));

vi.mock("../../../src/stellar/transactions.js", () => ({
  invokeContract: vi.fn().mockResolvedValue("tx-hash-123"),
}));

vi.mock("../../../src/stellar/signatures.js", () => ({
  createQuizProof: vi.fn().mockReturnValue({ signature: "base64sig" }),
}));

vi.mock("../../../src/config/index.js", () => ({
  config: {
    STELLAR_REWARD_CONTRACT_ID: "test-reward-contract",
  },
}));

vi.mock("../../../src/utils/logger.js", () => ({
  logger: { info: vi.fn(), error: vi.fn(), warn: vi.fn(), fatal: vi.fn() },
}));

vi.mock("@stellar/stellar-sdk", () => ({
  default: {
    Address: {
      fromString: vi.fn().mockReturnValue({ toScVal: vi.fn().mockReturnValue("mock-val") }),
    },
    nativeToScVal: vi.fn().mockReturnValue("mock-val"),
  },
}));

import {
  enqueueReward,
  dequeueReadyBatch,
  requeueReward,
  startRetryProcessor,
  stopRetryProcessor,
  inspectDeadLetterQueue,
} from "../../../src/services/retry-queue.js";
import { redis } from "../../../src/config/redis.js";
import { db } from "../../../src/config/database.js";

const mockRedis = vi.mocked(redis);
const mockDb = vi.mocked(db);

function jobPayload(overrides: Partial<Record<string, unknown>> = {}) {
  return {
    id: "job-1",
    submissionId: "sub-1",
    userId: "user-1",
    score: 5,
    retryCount: 0,
    createdAt: new Date().toISOString(),
    ...overrides,
  };
}

describe("Retry Queue", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    stopRetryProcessor();
  });

  it("should enqueue a reward job scored for immediate processing", async () => {
    await enqueueReward({
      submissionId: "sub-1",
      userId: "user-1",
      score: 5,
    });

    expect(mockRedis.zadd).toHaveBeenCalledWith(
      "chainlearn:retry:rewards",
      expect.any(Number),
      expect.stringContaining('"submissionId":"sub-1"')
    );
  });

  it("should dequeue a batch of ready jobs via the atomic pop script", async () => {
    const job = jobPayload();
    mockRedis.eval.mockResolvedValueOnce([JSON.stringify(job)]);

    const result = await dequeueReadyBatch();
    expect(result).toEqual([job]);
    expect(mockRedis.eval).toHaveBeenCalledWith(
      expect.stringContaining("ZRANGEBYSCORE"),
      1,
      "chainlearn:retry:rewards",
      expect.any(Number),
      expect.any(Number)
    );
  });

  it("should return an empty array when no jobs are ready", async () => {
    mockRedis.eval.mockResolvedValueOnce([]);
    const result = await dequeueReadyBatch();
    expect(result).toEqual([]);
  });

  it("should requeue with incremented retry count and a future score (backoff)", async () => {
    const job = jobPayload({ retryCount: 3 });
    const before = Date.now();

    await requeueReward(job);

    expect(mockRedis.zadd).toHaveBeenCalledWith(
      "chainlearn:retry:rewards",
      expect.any(Number),
      expect.stringContaining('"retryCount":4')
    );
    const [, score] = mockRedis.zadd.mock.calls[0];
    expect(score as number).toBeGreaterThan(before); // scheduled in the future, not immediate
  });

  it("should back off further on later retries, up to the cap", async () => {
    await requeueReward(jobPayload({ retryCount: 0 }));
    const [, firstScore] = mockRedis.zadd.mock.calls[0];

    mockRedis.zadd.mockClear();
    await requeueReward(jobPayload({ retryCount: 5 }));
    const [, laterScore] = mockRedis.zadd.mock.calls[0];

    expect(laterScore as number).toBeGreaterThan(firstScore as number);
  });

  it("should not requeue when max retries exceeded", async () => {
    const job = jobPayload({ retryCount: 10 });

    await requeueReward(job);

    expect(mockRedis.zadd).not.toHaveBeenCalled();
  });

  it("should mark reward as failed when max retries exceeded", async () => {
    const job = jobPayload({ retryCount: 10 });

    await requeueReward(job);

    expect(mockDb.update).toHaveBeenCalled();
  });

  it("should process a batch of ready jobs concurrently when the processor ticks", async () => {
    const processFn = vi.fn().mockResolvedValue(true);
    const jobs = [jobPayload({ id: "a", submissionId: "sub-a" }), jobPayload({ id: "b", submissionId: "sub-b" })];

    mockRedis.eval.mockResolvedValueOnce(jobs.map((j) => JSON.stringify(j)));

    await startRetryProcessor(processFn);

    expect(processFn).toHaveBeenCalledTimes(2);
    expect(processFn).toHaveBeenCalledWith(jobs[0]);
    expect(processFn).toHaveBeenCalledWith(jobs[1]);
  });

  it("should requeue failed jobs from a batch without blocking the others", async () => {
    const jobs = [jobPayload({ id: "a", submissionId: "sub-a" }), jobPayload({ id: "b", submissionId: "sub-b" })];
    const processFn = vi.fn().mockImplementation(async (job) => job.submissionId !== "sub-a");

    mockRedis.eval.mockResolvedValueOnce(jobs.map((j) => JSON.stringify(j)));

    await startRetryProcessor(processFn);

    expect(processFn).toHaveBeenCalledTimes(2);
    expect(mockRedis.zadd).toHaveBeenCalledWith(
      "chainlearn:retry:rewards",
      expect.any(Number),
      expect.stringContaining('"submissionId":"sub-a"')
    );
  });

  it("should requeue a job whose processFn throws", async () => {
    const job = jobPayload();
    const processFn = vi.fn().mockRejectedValue(new Error("boom"));

    mockRedis.eval.mockResolvedValueOnce([JSON.stringify(job)]);

    await startRetryProcessor(processFn);

    expect(mockRedis.zadd).toHaveBeenCalledWith(
      "chainlearn:retry:rewards",
      expect.any(Number),
      expect.stringContaining('"retryCount":1')
    );
  });

  it("should not spawn a duplicate loop when restarted while the previous tick is still in flight", async () => {
    vi.useFakeTimers();
    try {
      let resolveStaleDequeue: (value: string[]) => void = () => {};
      const staleDequeue = new Promise<string[]>((resolve) => {
        resolveStaleDequeue = resolve;
      });
      mockRedis.eval.mockReturnValueOnce(staleDequeue as ReturnType<typeof mockRedis.eval>);

      const staleProcessFn = vi.fn().mockResolvedValue(true);
      const stalePromise = startRetryProcessor(staleProcessFn);

      // Let the stale tick reach its `await dequeueReadyBatch()` point without resolving it.
      await Promise.resolve();
      await Promise.resolve();

      // Stop before the stale tick completes, then immediately restart.
      stopRetryProcessor();

      mockRedis.eval.mockResolvedValue([]);
      const freshProcessFn = vi.fn().mockResolvedValue(true);
      await startRetryProcessor(freshProcessFn);

      // Now let the stale tick's dequeue finally resolve.
      resolveStaleDequeue([]);
      await stalePromise;
      await Promise.resolve();

      mockRedis.eval.mockClear();
      await vi.advanceTimersByTimeAsync(5_000);

      // Only the fresh loop should still be ticking — a dangling stale loop
      // would double this call count.
      expect(mockRedis.eval).toHaveBeenCalledTimes(1);
    } finally {
      stopRetryProcessor();
      vi.useRealTimers();
    }
  });

  it("should drain immediately (no poll delay) when a batch comes back full", async () => {
    vi.useFakeTimers();
    try {
      const fullBatch = Array.from({ length: 10 }, (_, i) =>
        JSON.stringify(jobPayload({ id: `job-${i}`, submissionId: `sub-${i}` }))
      );
      mockRedis.eval.mockResolvedValueOnce(fullBatch).mockResolvedValueOnce([]);

      const processFn = vi.fn().mockResolvedValue(true);
      await startRetryProcessor(processFn);

      // A full batch should trigger an immediate re-tick (0ms), not wait for
      // the normal poll interval.
      await vi.advanceTimersByTimeAsync(0);

      expect(mockRedis.eval).toHaveBeenCalledTimes(2);
    } finally {
      stopRetryProcessor();
      vi.useRealTimers();
    }
  });

  it("should handle malformed JSON and move to dead-letter queue", async () => {
    const validJob = jobPayload({ id: "valid", submissionId: "sub-valid" });
    const malformedJson = "{broken json";
    
    mockRedis.eval.mockResolvedValueOnce([JSON.stringify(validJob), malformedJson]);

    const result = await dequeueReadyBatch();

    // Should return only the valid job
    expect(result).toEqual([validJob]);
    expect(result.length).toBe(1);
    
    // Malformed job should be pushed to dead-letter queue
    expect(mockRedis.lpush).toHaveBeenCalledWith(
      "chainlearn:retry:rewards:dead-letter",
      malformedJson
    );
  });

  it("should continue processing valid jobs even when one is malformed", async () => {
    const job1 = jobPayload({ id: "job-1", submissionId: "sub-1" });
    const job2 = jobPayload({ id: "job-2", submissionId: "sub-2" });
    const malformed = "not-valid-json";
    
    mockRedis.eval.mockResolvedValueOnce([
      JSON.stringify(job1),
      malformed,
      JSON.stringify(job2)
    ]);

    const result = await dequeueReadyBatch();

    expect(result).toEqual([job1, job2]);
    expect(result.length).toBe(2);
    expect(mockRedis.lpush).toHaveBeenCalledWith(
      "chainlearn:retry:rewards:dead-letter",
      malformed
    );
  });

  it("should handle dead-letter queue write failure gracefully", async () => {
    const validJob = jobPayload();
    const malformed = "{bad}";
    
    mockRedis.eval.mockResolvedValueOnce([JSON.stringify(validJob), malformed]);
    mockRedis.lpush.mockRejectedValueOnce(new Error("Redis write failed"));

    // Should not throw - continues processing other jobs
    const result = await dequeueReadyBatch();
    
    expect(result).toEqual([validJob]);
    expect(mockRedis.lpush).toHaveBeenCalled();
  });

  it("should inspect dead-letter queue", async () => {
    mockRedis.llen.mockResolvedValueOnce(5);
    mockRedis.lrange.mockResolvedValueOnce(["{bad1}", "{bad2}", "{bad3}"]);

    const result = await inspectDeadLetterQueue(3);

    expect(result.count).toBe(5);
    expect(result.entries).toEqual(["{bad1}", "{bad2}", "{bad3}"]);
    expect(mockRedis.lrange).toHaveBeenCalledWith(
      "chainlearn:retry:rewards:dead-letter",
      0,
      2
    );
  });
});
