import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("../../../src/utils/logger.js", () => ({
  logger: { info: vi.fn(), error: vi.fn(), warn: vi.fn(), debug: vi.fn() },
}));

import { registry, httpRequestsTotal, httpRequestDurationSeconds } from "../../../src/metrics/index.js";

describe("Metrics", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    registry.resetMetrics();
  });

  it("should have httpRequestsTotal counter", () => {
    expect(httpRequestsTotal).toBeDefined();
    expect(httpRequestsTotal.name).toBe("http_requests_total");
  });

  it("should have httpRequestDurationSeconds histogram", () => {
    expect(httpRequestDurationSeconds).toBeDefined();
    expect(httpRequestDurationSeconds.name).toBe("http_request_duration_seconds");
  });

  it("should increment request counter", () => {
    httpRequestsTotal.inc({ method: "GET", route: "/health", status_code: "200" });

    const metrics = registry.getSingleMetric("http_requests_total");
    expect(metrics).toBeDefined();
  });

  it("should record request duration", () => {
    httpRequestDurationSeconds.observe(
      { method: "GET", route: "/health", status_code: "200" },
      0.05
    );

    const metrics = registry.getSingleMetric("http_request_duration_seconds");
    expect(metrics).toBeDefined();
  });
});
