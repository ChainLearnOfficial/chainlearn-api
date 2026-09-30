import { describe, it, expect, vi, beforeEach } from "vitest";

const mockRedis = vi.hoisted(() => ({
  ttl: vi.fn(),
  incr: vi.fn(),
  expire: vi.fn(),
  setex: vi.fn(),
  del: vi.fn(),
}));

vi.mock("../../../src/config/redis.js", () => ({ redis: mockRedis }));
vi.mock("../../../src/utils/logger.js", () => ({
  logger: { warn: vi.fn(), info: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));
vi.mock("../../../src/audit/index.js", () => ({
  auditLog: vi.fn().mockResolvedValue(undefined),
}));

import {
  checkAuthLockout,
  recordAuthFailure,
  clearAuthFailures,
} from "../../../src/utils/auth-attempt-tracker.js";
import { auditLog } from "../../../src/audit/index.js";

describe("auth-attempt-tracker (#488)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe("checkAuthLockout", () => {
    it("reports not locked out when no lockout key exists", async () => {
      mockRedis.ttl.mockResolvedValue(-2);
      const result = await checkAuthLockout("GADDRESS");
      expect(result.lockedOut).toBe(false);
    });

    it("reports locked out with the remaining seconds when a lockout is active", async () => {
      mockRedis.ttl.mockResolvedValue(45);
      const result = await checkAuthLockout("GADDRESS");
      expect(result.lockedOut).toBe(true);
      expect(result.retryAfterSeconds).toBe(45);
    });
  });

  describe("recordAuthFailure", () => {
    it("does not lock out before the threshold", async () => {
      mockRedis.incr.mockResolvedValue(3);
      const count = await recordAuthFailure("GADDRESS");
      expect(count).toBe(3);
      expect(mockRedis.setex).not.toHaveBeenCalled();
      expect(auditLog).not.toHaveBeenCalled();
    });

    it("sets an expiry on the very first failure to start the sliding window", async () => {
      mockRedis.incr.mockResolvedValue(1);
      await recordAuthFailure("GADDRESS");
      expect(mockRedis.expire).toHaveBeenCalledWith(expect.stringContaining("GADDRESS"), 15 * 60);
    });

    it("triggers a lockout and audit log once the threshold is reached", async () => {
      mockRedis.incr.mockResolvedValue(5);
      await recordAuthFailure("GADDRESS");
      expect(mockRedis.setex).toHaveBeenCalledWith(
        expect.stringContaining("lockout"),
        30,
        "1",
      );
      expect(auditLog).toHaveBeenCalledWith(
        "auth.lockout_triggered",
        expect.objectContaining({ stellarAddress: "GADDRESS", failedAttempts: 5 }),
      );
    });

    it("escalates the lockout duration for each failure past the threshold", async () => {
      mockRedis.incr.mockResolvedValue(6);
      await recordAuthFailure("GADDRESS");
      expect(mockRedis.setex).toHaveBeenCalledWith(expect.any(String), 60, "1");

      mockRedis.incr.mockResolvedValue(7);
      await recordAuthFailure("GADDRESS");
      expect(mockRedis.setex).toHaveBeenCalledWith(expect.any(String), 120, "1");
    });

    it("caps the lockout duration at the configured maximum", async () => {
      mockRedis.incr.mockResolvedValue(20);
      await recordAuthFailure("GADDRESS");
      expect(mockRedis.setex).toHaveBeenCalledWith(expect.any(String), 15 * 60, "1");
    });
  });

  describe("clearAuthFailures", () => {
    it("deletes both the count and lockout keys", async () => {
      await clearAuthFailures("GADDRESS");
      expect(mockRedis.del).toHaveBeenCalledWith(
        expect.stringContaining("count"),
        expect.stringContaining("lockout"),
      );
    });
  });
});
