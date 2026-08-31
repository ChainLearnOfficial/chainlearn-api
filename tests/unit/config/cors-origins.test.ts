import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

/**
 * #274: CORS_ORIGINS env var → resolved allow-list.
 *
 * config/index.ts reads process.env once at import time and memoizes the
 * result, so each case resets the module registry and re-imports it with a
 * fresh env. Only CORS_ORIGINS / NODE_ENV are varied; every other required
 * var comes from the test .env the rest of the suite already relies on.
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

describe("CORS_ORIGINS config (#274)", () => {
  beforeEach(() => {
    vi.unstubAllEnvs();
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    vi.resetModules();
  });

  it("defaults to localhost:3000 when unset outside production (no behavior change)", async () => {
    const { config, corsOrigins } = await loadConfig({
      NODE_ENV: "development",
      CORS_ORIGINS: undefined,
    });

    expect(config.CORS_ORIGINS).toBeUndefined();
    expect(corsOrigins).toEqual(["http://localhost:3000"]);
  });

  it("defaults to chainlearn.io when unset in production (no behavior change)", async () => {
    const { corsOrigins } = await loadConfig({
      NODE_ENV: "production",
      CORS_ORIGINS: undefined,
    });

    expect(corsOrigins).toEqual(["https://chainlearn.io"]);
  });

  it("treats an empty CORS_ORIGINS the same as unset", async () => {
    const { corsOrigins } = await loadConfig({
      NODE_ENV: "production",
      CORS_ORIGINS: "   ",
    });

    expect(corsOrigins).toEqual(["https://chainlearn.io"]);
  });

  it("parses a comma-separated list into trimmed origins", async () => {
    const { config, corsOrigins } = await loadConfig({
      NODE_ENV: "development",
      CORS_ORIGINS: " https://a.example , https://b.example ,,https://c.example ",
    });

    expect(config.CORS_ORIGINS).toEqual([
      "https://a.example",
      "https://b.example",
      "https://c.example",
    ]);
    expect(corsOrigins).toEqual([
      "https://a.example",
      "https://b.example",
      "https://c.example",
    ]);
  });

  it("overrides the production default when set", async () => {
    const { corsOrigins } = await loadConfig({
      NODE_ENV: "production",
      CORS_ORIGINS: "https://app.chainlearn.io",
    });

    expect(corsOrigins).toEqual(["https://app.chainlearn.io"]);
  });
});
