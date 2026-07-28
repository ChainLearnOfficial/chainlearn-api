import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("../../../src/metrics/index.js", () => ({
  httpRequestsTotal: {
    inc: vi.fn(),
  },
  httpRequestDurationSeconds: {
    observe: vi.fn(),
  },
}));

import { registerMetricsHook } from "../../../src/metrics/fastify-hook.js";
import { httpRequestsTotal, httpRequestDurationSeconds } from "../../../src/metrics/index.js";

describe("Metrics Fastify Hook", () => {
  let mockApp: any;
  let onRequestHandler: any;
  let onResponseHandler: any;

  beforeEach(() => {
    vi.clearAllMocks();

    mockApp = {
      addHook: vi.fn((hookName, handler) => {
        if (hookName === "onRequest") onRequestHandler = handler;
        if (hookName === "onResponse") onResponseHandler = handler;
      }),
    };

    registerMetricsHook(mockApp);
  });

  it("should register onRequest and onResponse hooks", () => {
    expect(mockApp.addHook).toHaveBeenCalledWith("onRequest", expect.any(Function));
    expect(mockApp.addHook).toHaveBeenCalledWith("onResponse", expect.any(Function));
  });

  it("should track metrics start time on request", () => {
    const mockRequest: any = {};
    const done = vi.fn();

    onRequestHandler(mockRequest, {}, done);

    expect(mockRequest._metricsStart).toBeDefined();
    expect(typeof mockRequest._metricsStart).toBe("bigint");
    expect(done).toHaveBeenCalled();
  });

  it("should increment counter and record duration on response", () => {
    const mockRequest: any = {
      method: "GET",
      url: "/api/v1/users",
      routeOptions: { url: "/api/v1/users" },
      _metricsStart: process.hrtime.bigint(),
    };
    const mockReply: any = { statusCode: 200 };
    const done = vi.fn();

    onResponseHandler(mockRequest, mockReply, done);

    expect(httpRequestsTotal.inc).toHaveBeenCalledWith({
      method: "GET",
      route: "/api/v1/users",
      status_code: "200",
    });
    expect(httpRequestDurationSeconds.observe).toHaveBeenCalled();
    expect(done).toHaveBeenCalled();
  });

  it("should handle missing _metricsStart gracefully", () => {
    const mockRequest: any = {
      method: "POST",
      url: "/api/v1/auth",
      routeOptions: { url: "/api/v1/auth" },
    };
    const mockReply: any = { statusCode: 201 };
    const done = vi.fn();

    onResponseHandler(mockRequest, mockReply, done);

    expect(httpRequestsTotal.inc).toHaveBeenCalled();
    expect(done).toHaveBeenCalled();
  });
});
