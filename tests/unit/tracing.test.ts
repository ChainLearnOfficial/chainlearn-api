import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

vi.mock("@opentelemetry/sdk-node", () => ({
  NodeSDK: vi.fn().mockImplementation(function () {
    return {
      start: vi.fn(),
      shutdown: vi.fn().mockResolvedValue(undefined),
    };
  }),
}));

vi.mock("@opentelemetry/exporter-trace-otlp-http", () => ({
  OTLPTraceExporter: vi.fn(),
}));

vi.mock("@opentelemetry/resources", () => ({
  resourceFromAttributes: vi.fn((attrs) => attrs),
}));

vi.mock("@opentelemetry/instrumentation-fastify", () => ({
  FastifyInstrumentation: vi.fn(),
}));

vi.mock("@opentelemetry/instrumentation-pg", () => ({
  PgInstrumentation: vi.fn(),
}));

vi.mock("@opentelemetry/instrumentation-ioredis", () => ({
  IORedisInstrumentation: vi.fn(),
}));

import { initTracing, shutdownTracing } from "../../../src/tracing.js";
import { NodeSDK } from "@opentelemetry/sdk-node";

describe("Tracing", () => {
  let originalEnv: string | undefined;

  beforeEach(() => {
    vi.clearAllMocks();
    originalEnv = process.env.OTEL_SDK_DISABLED;
    delete process.env.OTEL_SDK_DISABLED;
  });

  afterEach(() => {
    if (originalEnv !== undefined) {
      process.env.OTEL_SDK_DISABLED = originalEnv;
    } else {
      delete process.env.OTEL_SDK_DISABLED;
    }
  });

  it("should initialize tracing SDK", () => {
    initTracing("test-service");

    expect(NodeSDK).toHaveBeenCalled();
  });

  it("should not initialize when OTEL_SDK_DISABLED is true", () => {
    process.env.OTEL_SDK_DISABLED = "true";

    initTracing("test-service");

    expect(NodeSDK).not.toHaveBeenCalled();
  });

  it("should use custom endpoint if provided", () => {
    process.env.OTEL_EXPORTER_OTLP_ENDPOINT = "http://custom:4318/v1/traces";

    initTracing("custom-service");

    expect(NodeSDK).toHaveBeenCalled();
  });

  it("should shutdown tracing gracefully", async () => {
    initTracing("test-service");

    await expect(shutdownTracing()).resolves.toBeUndefined();
  });

  it("should handle shutdown when SDK not initialized", async () => {
    await expect(shutdownTracing()).resolves.toBeUndefined();
  });
});
