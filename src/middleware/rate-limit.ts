import type { FastifyRateLimitOptions, RateLimitOptions } from "@fastify/rate-limit";
import type { FastifyRequest } from "fastify";
import { config } from "../config/index.js";

const errorResponseBuilder = (
  _request: FastifyRequest,
  context: { after: number | string }
) => ({
  statusCode: 429,
  error: "Too Many Requests",
  message: `Rate limit exceeded. Retry after ${context.after}ms.`,
});

export function rateLimitOptions(): FastifyRateLimitOptions {
  return {
    max: config.RATE_LIMIT_MAX,
    timeWindow: config.RATE_LIMIT_WINDOW_MS,
    keyGenerator: (request: FastifyRequest) => {
      // Prefer authenticated user id, fall back to IP
      const authReq = request as any;
      return authReq.authUser?.id ?? request.ip;
    },
    errorResponseBuilder,
  };
}

// ─── Per-route overrides ────────────────────────────────────────────────────
// @fastify/rate-limit is registered globally; routes opt into stricter limits
// via `config: { rateLimit: <these> }`.

/**
 * Stricter limit for unauthenticated auth endpoints. Each challenge stores a
 * value in Redis, so an attacker hitting the global 100/min limit could
 * exhaust Redis memory. Key by IP since there is no user yet.
 */
export const authRateLimit: RateLimitOptions = {
  max: 20,
  timeWindow: "5 minutes",
  keyGenerator: (request: FastifyRequest) => request.ip,
  errorResponseBuilder,
};

/**
 * Stricter limit for reward claims, which trigger on-chain work. Key by
 * authenticated user id (falling back to IP) so one account can't spam claims.
 */
export const claimRateLimit: RateLimitOptions = {
  max: 10,
  timeWindow: "1 minute",
  keyGenerator: (request: FastifyRequest) => {
    const authReq = request as any;
    return authReq.authUser?.id ?? request.ip;
  },
  errorResponseBuilder,
};
