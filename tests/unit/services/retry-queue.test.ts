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
    lpush: vi.fn().mockResolvedValue(1),
    rpop: vi.fn().mockResolvedValue(null),
    llen: vi.fn().mockResolvedValue(0),
    eval: vi.fn().mockResolvedValue(1),
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
  dequeueReward,
  requeueReward,
  getQueueLength,
  startRetryProcessor,
  stopRetryProcessor,
} from "../../../src/services/retry-queue.js";
import { redis } from "../../../src/config/redis.js";
import { db } from "../../../src/config/database.js";

const mockRedis = vi.mocked(redis);
const mockDb = vi.mocked(db);

describe("Retry Queue", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    stopRetryProcessor();
  });

  it("should enqueue a reward job", async () => {
    await enqueueReward({
      submissionId: "sub-1",
      userId: "user-1",
      score: 5,
    });

    expect(mockRedis.lpush).toHaveBeenCalledWith(
      "chainlearn:retry:rewards",
      expect.stringContaining('"submissionId":"sub-1"')
    );
  });

  it("should dequeue a reward job", async () => {
    const job = {
      submissionId: "sub-1",
      userId: "user-1",
      score: 5,
      retryCount: 0,
      createdAt: new Date().toISOString(),
    };
    mockRedis.rpop.mockResolvedValueOnce(JSON.stringify(job));

    const result = await dequeueReward();
    expect(result).toEqual(job);
  });

  it("should return null when queue is empty", async () => {
    mockRedis.rpop.mockResolvedValueOnce(null);
    const result = await dequeueReward();
    expect(result).toBeNull();
  });

  it("should requeue with incremented retry count", async () => {
    const job = {
      submissionId: "sub-1",
      userId: "user-1",
      score: 5,
      retryCount: 3,
      createdAt: new Date().toISOString(),
    };

    await requeueReward(job);

    expect(mockRedis.lpush).toHaveBeenCalledWith(
      "chainlearn:retry:rewards",
      expect.stringContaining('"retryCount":4')
    );
  });

  it("should not requeue when max retries exceeded", async () => {
    const job = {
      submissionId: "sub-1",
      userId: "user-1",
      score: 5,
      retryCount: 10,
      createdAt: new Date().toISOString(),
    };

    await requeueReward(job);

    expect(mockRedis.lpush).not.toHaveBeenCalled();
  });

  it("should mark reward as failed when max retries exceeded", async () => {
    const job = {
      submissionId: "sub-1",
      userId: "user-1",
      score: 5,
      retryCount: 10,
      createdAt: new Date().toISOString(),
    };

    await requeueReward(job);

    expect(mockDb.update).toHaveBeenCalled();
  });

  it("should return queue length", async () => {
    mockRedis.llen.mockResolvedValueOnce(5);
    const len = await getQueueLength();
    expect(len).toBe(5);
  });

  it("should process jobs when processor is started", async () => {
    const processFn = vi.fn().mockResolvedValue(true);
    const job = {
      submissionId: "sub-1",
      userId: "user-1",
      score: 5,
      retryCount: 0,
      createdAt: new Date().toISOString(),
    };

    mockRedis.rpop.mockResolvedValueOnce(JSON.stringify(job));

    startRetryProcessor(processFn);

    await new Promise((resolve) => setTimeout(resolve, 100));

    expect(processFn).toHaveBeenCalledWith(job);
  });

  it("should requeue failed jobs", async () => {
    const processFn = vi.fn().mockResolvedValue(false);
    const job = {
      submissionId: "sub-1",
      userId: "user-1",
      score: 5,
      retryCount: 0,
      createdAt: new Date().toISOString(),
    };

    mockRedis.rpop.mockResolvedValueOnce(JSON.stringify(job));

    startRetryProcessor(processFn);

    await new Promise((resolve) => setTimeout(resolve, 100));

    expect(processFn).toHaveBeenCalledWith(job);
    expect(mockRedis.lpush).toHaveBeenCalledWith(
      "chainlearn:retry:rewards",
      expect.stringContaining('"retryCount":1')
    );
  });
});
