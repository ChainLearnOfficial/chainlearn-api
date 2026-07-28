import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("../../../src/config/index.js", () => ({
  config: {
    RATE_LIMIT_MAX: 100,
    RATE_LIMIT_WINDOW_MS: 60000,
  },
}));

import { rateLimitOptions, authRateLimit } from "../../../src/middleware/rate-limit.js";

describe("Rate Limit Middleware", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe("rateLimitOptions", () => {
    it("should return default rate limit config", () => {
      const options = rateLimitOptions();

      expect(options.max).toBe(100);
      expect(options.timeWindow).toBe(60000);
      expect(options.keyGenerator).toBeDefined();
      expect(options.errorResponseBuilder).toBeDefined();
    });

    it("should generate key from authenticated user id", () => {
      const options = rateLimitOptions();
      const mockRequest: any = {
        authUser: { id: "user-123" },
        ip: "192.168.1.1",
      };

      const key = options.keyGenerator!(mockRequest);

      expect(key).toBe("user-123");
    });

    it("should fall back to IP when user not authenticated", () => {
      const options = rateLimitOptions();
      const mockRequest: any = {
        ip: "192.168.1.1",
      };

      const key = options.keyGenerator!(mockRequest);

      expect(key).toBe("192.168.1.1");
    });

    it("should build error response", () => {
      const options = rateLimitOptions();
      const mockRequest: any = {};
      const context = { after: 5000 };

      const response = options.errorResponseBuilder!(mockRequest, context);

      expect(response).toEqual({
        statusCode: 429,
        error: "Too Many Requests",
        message: "Rate limit exceeded. Retry after 5000ms.",
      });
    });
  });

  describe("authRateLimit", () => {
    it("should have stricter limits for auth endpoints", () => {
      expect(authRateLimit.max).toBe(20);
      expect(authRateLimit.timeWindow).toBe("5 minutes");
    });

    it("should use IP as key for unauthenticated endpoints", () => {
      const mockRequest: any = { ip: "10.0.0.1" };

      const key = authRateLimit.keyGenerator!(mockRequest);

      expect(key).toBe("10.0.0.1");
    });
  });
});
