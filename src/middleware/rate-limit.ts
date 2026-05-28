import type { FastifyRateLimitOptions } from "@fastify/rate-limit";
import { config } from "../config/index.js";

export function rateLimitOptions(): FastifyRateLimitOptions {
  return {
    max: config.RATE_LIMIT_MAX,
    timeWindow: config.RATE_LIMIT_WINDOW_MS,
    keyGenerator: (request) => {
      // Prefer authenticated user id, fall back to IP
      const authReq = request as any;
      return authReq.authUser?.id ?? request.ip;
    },
    errorResponseBuilder: (_request, context) => ({
      statusCode: 429,
      error: "Too Many Requests",
      message: `Rate limit exceeded. Retry after ${context.after}ms.`,
    }),
  };
}
