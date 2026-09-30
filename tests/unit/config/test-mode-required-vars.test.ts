import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

/**
 * #475: DATABASE_URL, JWT_SECRET, and STELLAR_PLATFORM_SECRET no longer
 * fall back to hardcoded, real-looking values in test mode. Missing any of
 * them should throw a clear config error instead of silently substituting
 * a fake-but-valid-shaped secret. Non-critical vars (Stellar contract IDs,
 * public testnet URLs) still get an obviously-fake default so most tests
 * don't need to set them explicitly.
 *
 * Same module-reset-and-reimport approach as cors-origins.test.ts, since
 * config/index.ts reads process.env once at import time and memoizes it.
 */
async function loadConfig(env: Record<string, string | undefined>) {
  vi.resetModules();
  for (const [key, value] of Object.entries(env)) {
    if (value === undefined) {
      vi.stubEnv(key, "");
      delete process.env[key];
    } else {
      vi.stubEnv(key, value);
    }
  }
  return import("../../../src/config/index.js");
}

const VALID_TEST_ENV = {
  NODE_ENV: "test",
  DATABASE_URL:
    "postgresql://chainlearn_test:test_password@localhost:5432/chainlearn_test",
  JWT_SECRET:
    "test-secret-key-that-is-at-least-sixty-four-characters-long-for-tests",
  STELLAR_PLATFORM_SECRET:
    "SAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
} as const;

describe("Test-mode required env vars (#475)", () => {
  beforeEach(() => {
    vi.unstubAllEnvs();
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    vi.resetModules();
  });

  it("throws a clear error when DATABASE_URL is missing in test mode", async () => {
    await expect(
      loadConfig({ ...VALID_TEST_ENV, DATABASE_URL: undefined }),
    ).rejects.toThrow(/Missing required test environment variable.*DATABASE_URL/);
  });

  it("throws a clear error when JWT_SECRET is missing in test mode", async () => {
    await expect(
      loadConfig({ ...VALID_TEST_ENV, JWT_SECRET: undefined }),
    ).rejects.toThrow(/Missing required test environment variable.*JWT_SECRET/);
  });

  it("throws a clear error when STELLAR_PLATFORM_SECRET is missing in test mode", async () => {
    await expect(
      loadConfig({ ...VALID_TEST_ENV, STELLAR_PLATFORM_SECRET: undefined }),
    ).rejects.toThrow(
      /Missing required test environment variable.*STELLAR_PLATFORM_SECRET/,
    );
  });

  it("lists every missing required var in a single error when more than one is absent", async () => {
    await expect(
      loadConfig({
        ...VALID_TEST_ENV,
        DATABASE_URL: undefined,
        JWT_SECRET: undefined,
      }),
    ).rejects.toThrow(/DATABASE_URL.*JWT_SECRET|JWT_SECRET.*DATABASE_URL/);
  });

  it("never falls back to a hardcoded-looking real secret for JWT_SECRET or STELLAR_PLATFORM_SECRET", async () => {
    // Regression guard for #475: assert the specific old hardcoded fallback
    // strings are gone, not just that *some* value throws.
    const source = await import("node:fs/promises").then((fs) =>
      fs.readFile(
        new URL("../../../src/config/index.ts", import.meta.url),
        "utf-8",
      ),
    );
    expect(source).not.toContain("test-secret-key-that-is-at-least-sixty-four");
    expect(source).not.toContain("chainlearn_test:test_password@localhost");
    expect(source).not.toMatch(/STELLAR_PLATFORM_SECRET \|\| "test"/);
  });

  it("succeeds and uses obviously-fake, non-secret defaults for non-critical vars when they're unset", async () => {
    const { config } = await loadConfig({
      ...VALID_TEST_ENV,
      STELLAR_QUIZ_CONTRACT_ID: undefined,
      STELLAR_REWARD_CONTRACT_ID: undefined,
      STELLAR_CREDENTIAL_CONTRACT_ID: undefined,
      STELLAR_HORIZON_URL: undefined,
      STELLAR_SOROBAN_RPC_URL: undefined,
    });

    expect(config.STELLAR_QUIZ_CONTRACT_ID).toBe("CHANGE_ME_IN_TEST_ENV");
    expect(config.STELLAR_REWARD_CONTRACT_ID).toBe("CHANGE_ME_IN_TEST_ENV");
    expect(config.STELLAR_CREDENTIAL_CONTRACT_ID).toBe("CHANGE_ME_IN_TEST_ENV");
    expect(config.STELLAR_HORIZON_URL).toBe("https://horizon-testnet.stellar.org");
    expect(config.STELLAR_SOROBAN_RPC_URL).toBe(
      "https://soroban-testnet.stellar.org",
    );
  });

  it("succeeds when all required vars are present", async () => {
    const { config } = await loadConfig(VALID_TEST_ENV);

    expect(config.DATABASE_URL).toBe(VALID_TEST_ENV.DATABASE_URL);
    expect(config.JWT_SECRET).toBe(VALID_TEST_ENV.JWT_SECRET);
    expect(config.STELLAR_PLATFORM_SECRET).toBe(
      VALID_TEST_ENV.STELLAR_PLATFORM_SECRET,
    );
  });
});
