import { describe, it, expect } from "vitest";
import { config } from "../../../src/config/index.js";

describe("config test-mode defaults (#475)", () => {
  it("resolves NODE_ENV to \"test\" rather than silently defaulting to development", () => {
    expect(config.NODE_ENV).toBe("test");
  });

  it("falls back to a regex-valid STELLAR_PLATFORM_SECRET, not the literal string \"test\"", () => {
    expect(config.STELLAR_PLATFORM_SECRET).toMatch(/^S[A-Z2-7]{55}$/);
  });

  it("falls back to a JWT_SECRET that satisfies the 64-character / non-placeholder schema rule", () => {
    expect(config.JWT_SECRET.length).toBeGreaterThanOrEqual(64);
    expect(config.JWT_SECRET).not.toBe("your-secret-key");
  });

  it("still applies the schema's own defaults for fields with no TEST_FALLBACKS entry", () => {
    expect(config.RATE_LIMIT_MAX).toBe(100);
    expect(config.AI_SERVICE_URL).toBe("http://localhost:8000");
  });
});
