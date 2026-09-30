import { describe, it, expect, vi } from "vitest";

vi.mock("../../../src/metrics/index.js", () => ({
  dependencyHealthCheckSeconds: { observe: vi.fn() },
}));

import { checkServiceHealth } from "../../../src/utils/service-health.js";
import { dependencyHealthCheckSeconds } from "../../../src/metrics/index.js";

describe("checkServiceHealth (#483)", () => {
  it("reports ok with a non-negative latency when the check resolves", async () => {
    const result = await checkServiceHealth("redis", async () => "PONG");

    expect(result.status).toBe("ok");
    expect(result.latencyMs).toBeGreaterThanOrEqual(0);
    expect(dependencyHealthCheckSeconds.observe).toHaveBeenCalledWith(
      { service: "redis", status: "ok" },
      expect.any(Number),
    );
  });

  it("reports down when the check rejects", async () => {
    const result = await checkServiceHealth("database", async () => {
      throw new Error("connection refused");
    });

    expect(result.status).toBe("down");
    expect(dependencyHealthCheckSeconds.observe).toHaveBeenCalledWith(
      { service: "database", status: "down" },
      expect.any(Number),
    );
  });

  it("reports down instead of hanging when the check exceeds the timeout", async () => {
    const neverResolves = new Promise(() => {});
    const result = await checkServiceHealth("ai", () => neverResolves, 20);

    expect(result.status).toBe("down");
    expect(result.latencyMs).toBeGreaterThanOrEqual(20);
  });
});
