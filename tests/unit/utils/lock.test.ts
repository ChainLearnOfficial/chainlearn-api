import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { withLock } from "../../../src/utils/lock.js";
import { redis } from "../../../src/config/redis.js";
import { ConflictError } from "../../../src/utils/errors.js";

vi.mock("../../../src/config/redis.js", () => ({
  redis: {
    set: vi.fn(),
    eval: vi.fn(),
  },
}));

vi.mock("../../../src/utils/logger.js", () => ({
  logger: {
    warn: vi.fn(),
    error: vi.fn(),
    info: vi.fn(),
  },
}));

describe("withLock", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("should acquire lock and release it after execution", async () => {
    (redis.set as any).mockResolvedValue("OK");
    (redis.eval as any).mockResolvedValue(1);

    const fn = vi.fn().mockResolvedValue("result");
    const result = await withLock("test", fn);

    expect(result).toBe("result");
    expect(redis.set).toHaveBeenCalledWith(
      "lock:test",
      expect.any(String),
      "PX",
      30000,
      "NX"
    );
    // The release eval call should have happened
    expect(redis.eval).toHaveBeenCalled();
  });

  it("should throw ConflictError if lock cannot be acquired", async () => {
    (redis.set as any).mockResolvedValue(null);

    const fn = vi.fn();
    await expect(withLock("test", fn)).rejects.toThrow("Operation in progress, please retry");
    expect(fn).not.toHaveBeenCalled();
  });

  it("should renew lock via heartbeat", async () => {
    (redis.set as any).mockResolvedValue("OK");
    (redis.eval as any).mockResolvedValue(1);

    let resolveFn: any;
    const promise = new Promise((resolve) => {
      resolveFn = resolve;
    });

    const fn = vi.fn().mockReturnValue(promise);

    const lockPromise = withLock("test", fn, 10000);

    // Advance time to trigger heartbeat (ttlMs / 2 = 5000)
    await vi.advanceTimersByTimeAsync(5001);
    
    // Check if eval was called for renewal
    expect(redis.eval).toHaveBeenCalledWith(
        expect.stringContaining("pexpire"),
        1,
        "lock:test",
        expect.any(String),
        10000
    );

    // Trigger another heartbeat
    await vi.advanceTimersByTimeAsync(5001);
    // Now it should have been called twice for renewal
    expect(redis.eval).toHaveBeenCalledTimes(2);

    resolveFn("done");
    await lockPromise;

    // After completion, it should have called eval one more time for release
    // But since release is also an eval call, total should be 3
    expect(redis.eval).toHaveBeenCalledTimes(3);
  });

  it("should stop heartbeat if renewal fails", async () => {
    (redis.set as any).mockResolvedValue("OK");
    // First renewal returns 0 (lock lost)
    (redis.eval as any).mockResolvedValue(0);

    let resolveFn: any;
    const promise = new Promise((resolve) => {
      resolveFn = resolve;
    });

    const fn = vi.fn().mockReturnValue(promise);

    const lockPromise = withLock("test", fn, 10000);

    await vi.advanceTimersByTimeAsync(5001);
    expect(redis.eval).toHaveBeenCalledTimes(1);

    // Advance more time, should NOT call eval again because heartbeat should be cleared
    await vi.advanceTimersByTimeAsync(5001);
    expect(redis.eval).toHaveBeenCalledTimes(1);

    resolveFn("done");
    await lockPromise;
    
    // Release call happens at the end
    expect(redis.eval).toHaveBeenCalledTimes(2);
  });
});
