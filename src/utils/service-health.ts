import { withTimeout } from "./resilience.js";
import { dependencyHealthCheckSeconds } from "../metrics/index.js";

/** Bounds how long an individual dependency check is allowed to hang before
 *  it's reported as down, so a stalled dependency can't stall the endpoint. */
const CHECK_TIMEOUT_MS = 5_000;

/**
 * `"degraded"` is part of the contract or a future check that can detect a
 * dependency answering but unhealthy (e.g. a service-reported degraded
 * status, not just reachability). The generic ping-style checks here can
 * only observe reachable/unreachable, so they only ever produce "ok" or
 * "down" — a future check with a richer signal (like the AI service's own
 * health payload) can report "degraded" without changing this type.
 */
export type ServiceHealthStatus = "ok" | "degraded" | "down";

export interface ServiceHealthResult {
  status: ServiceHealthStatus;
  latencyMs: number;
}

/**
 * Run one dependency check (#483), bounding it to CHECK_TIMEOUT_MS and
 * recording its latency/outcome to Prometheus regardless of the result.
 */
export async function checkServiceHealth(
  service: string,
  check: () => Promise<unknown>,
  timeoutMs: number = CHECK_TIMEOUT_MS,
): Promise<ServiceHealthResult> {
  const start = process.hrtime.bigint();
  try {
    await withTimeout(check(), timeoutMs);
    const latencyMs = Number(process.hrtime.bigint() - start) / 1e6;
    dependencyHealthCheckSeconds.observe({ service, status: "ok" }, latencyMs / 1000);
    return { status: "ok", latencyMs: Math.round(latencyMs) };
  } catch {
    const latencyMs = Number(process.hrtime.bigint() - start) / 1e6;
    dependencyHealthCheckSeconds.observe({ service, status: "down" }, latencyMs / 1000);
    return { status: "down", latencyMs: Math.round(latencyMs) };
  }
}
