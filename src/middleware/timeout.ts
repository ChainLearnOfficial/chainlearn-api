import type { FastifyInstance } from "fastify";
import { config } from "../config/index.js";
import { logger } from "../utils/logger.js";

declare module "fastify" {
  interface FastifyContextConfig {
    // Per-route override, in ms. Falls back to config.REQUEST_TIMEOUT_MS.
    // Set `timeoutMs: false` to disable the timeout entirely for a route
    // (e.g. a future WebSocket/streaming endpoint).
    timeoutMs?: number | false;
  }
}

/**
 * Global request timeout (#305). A slow client, or a slow downstream call
 * (Stellar, the AI service) that hasn't already timed out on its own, can
 * otherwise hold a server connection open indefinitely. Each request gets a
 * timer for its route's `config.timeoutMs` (default config.REQUEST_TIMEOUT_MS,
 * 30s) — if the response hasn't been sent by then, the client receives 408
 * instead of hanging. The timer is cleared as soon as the response is sent,
 * so it's a no-op for requests that complete in time, and routes can opt out
 * with `config: { timeoutMs: false }` for cases (WebSocket upgrades,
 * streaming responses) where a long-lived connection is expected.
 */
export function registerRequestTimeout(app: FastifyInstance): void {
  app.addHook("onRequest", (request, reply, done) => {
    const routeTimeout = request.routeOptions?.config?.timeoutMs;
    const timeoutMs =
      routeTimeout === false
        ? null
        : (routeTimeout ?? config.REQUEST_TIMEOUT_MS);

    if (timeoutMs === null) {
      done();
      return;
    }

    const timer = setTimeout(() => {
      if (reply.sent) return;

      logger.warn(
        {
          requestId: request.id,
          method: request.method,
          url: request.url,
          timeoutMs,
        },
        "Request timed out",
      );

      reply.status(408).send({
        success: false,
        error: {
          code: "REQUEST_TIMEOUT",
          message: `Request exceeded ${timeoutMs}ms timeout`,
        },
      });
    }, timeoutMs);
    // Don't let a pending timeout keep the event loop (or graceful
    // shutdown) alive on its own.
    timer.unref();

    const clear = () => clearTimeout(timer);
    reply.raw.once("finish", clear);
    reply.raw.once("close", clear);

    done();
  });
}
