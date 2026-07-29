import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

vi.mock("../../../src/utils/logger.js", () => ({
  logger: { info: vi.fn(), error: vi.fn(), warn: vi.fn(), fatal: vi.fn() },
}));

import {
  stellarRetry,
  circuitBreakerExecute,
  withTimeout,
  isCircuitBreakerError,
  resetCircuitBreaker,
} from "../../../src/stellar/resilience.js";
import { createCircuitBreaker, CircuitState } from "../../../src/utils/resilience.js";

describe("Stellar Resilience", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    resetCircuitBreaker();
  });

  describe("Retry Policy", () => {
    it("should retry on transient errors", async () => {
      let attempts = 0;
      const fn = vi.fn().mockImplementation(async () => {
        attempts++;
        if (attempts < 3) {
          throw new Error("ECONNRESET");
        }
        return "success";
      });

      const result = await stellarRetry.execute(fn);
      expect(result).toBe("success");
      expect(attempts).toBe(3);
    });

    it("should not retry on non-transient errors", async () => {
      const fn = vi.fn().mockRejectedValue(new Error("Validation failed"));

      await expect(stellarRetry.execute(fn)).rejects.toThrow("Validation failed");
      expect(fn).toHaveBeenCalledTimes(1);
    });
  });

  describe("Circuit Breaker", () => {
    it("should pass through successful calls", async () => {
      const fn = vi.fn().mockResolvedValue("ok");
      const result = await circuitBreakerExecute(fn);
      expect(result).toBe("ok");
    });

    it("should open after consecutive failures", async () => {
      const fn = vi.fn().mockRejectedValue(new Error("ECONNREFUSED"));

      for (let i = 0; i < 5; i++) {
        try {
          await circuitBreakerExecute(fn);
        } catch {
          // expected
        }
      }

      try {
        await circuitBreakerExecute(vi.fn().mockResolvedValue("ok"));
        expect.fail("Should have thrown");
      } catch (err) {
        expect(isCircuitBreakerError(err)).toBe(true);
      }
    });

    it("should allow only one probe request when transitioning from open to half-open", async () => {
      vi.useFakeTimers();
      vi.setSystemTime(new Date("2024-01-01T00:00:00.000Z"));

      try {
        const breaker = createCircuitBreaker({ label: "test", threshold: 1, halfOpenAfterMs: 1000 });
        const probeFn = vi.fn().mockImplementation(async () => {
          await Promise.resolve();
          return "probe";
        });

        await expect(breaker.execute(() => Promise.reject(new Error("ECONNREFUSED")))).rejects.toThrow();
        expect(breaker.getState()).toBe(CircuitState.Open);

        vi.setSystemTime(new Date("2024-01-01T00:00:01.500Z"));

        const first = breaker.execute(probeFn);
        const second = breaker.execute(probeFn);

        await Promise.allSettled([first, second]);

        expect(probeFn).toHaveBeenCalledTimes(1);
        expect(breaker.getState()).toBe(CircuitState.Closed);
      } finally {
        vi.useRealTimers();
      }
    });
  });

  describe("Timeout", () => {
    it("should resolve within timeout", async () => {
      const fn = vi.fn().mockResolvedValue("fast");
      const result = await withTimeout(fn(), 5000);
      expect(result).toBe("fast");
    });

    it("should reject when timeout exceeded", async () => {
      const fn = vi.fn().mockImplementation(
        () => new Promise((resolve) => setTimeout(resolve, 5000))
      );

      await expect(withTimeout(fn(), 100)).rejects.toThrow("timed out");
    });
  });

  describe("isCircuitBreakerError", () => {
    it("should return true for broken circuit errors", async () => {
      const fn = vi.fn().mockRejectedValue(new Error("ECONNREFUSED"));

      for (let i = 0; i < 5; i++) {
        try {
          await circuitBreakerExecute(fn);
        } catch {
          // expected
        }
      }

      try {
        await circuitBreakerExecute(vi.fn().mockResolvedValue("ok"));
      } catch (err) {
        expect(isCircuitBreakerError(err)).toBe(true);
      }
    });

    it("should return false for other errors", () => {
      expect(isCircuitBreakerError(new Error("test"))).toBe(false);
    });
  });
});
