import { initTracing, shutdownTracing } from "./tracing.js";

import Fastify from "fastify";
import cors from "@fastify/cors";
import helmet from "@fastify/helmet";
import jwt from "@fastify/jwt";
import rateLimit from "@fastify/rate-limit";
import { sql } from "drizzle-orm";
import { config } from "./config/index.js";
import { logger } from "./utils/logger.js";
import { registry, setupInfraMetrics } from "./metrics/index.js";
import { registerMetricsHook } from "./metrics/fastify-hook.js";
import { registerErrorHandler } from "./middleware/error-handler.js";
import { rateLimitOptions } from "./middleware/rate-limit.js";
import { authGuard } from "./middleware/auth.js";
import { db } from "./config/database.js";
import { redis } from "./config/redis.js";
import { stellarClient } from "./stellar/client.js";
import {
  startRetryProcessor,
  stopRetryProcessor,
  recoverLostJobs,
  type RetryJob,
} from "./services/retry-queue.js";
import {
  startIdempotencyCleanup,
  stopIdempotencyCleanup,
} from "./jobs/cleanup-idempotency.js";
import {
  startReconciliationJob,
  stopReconciliationJob,
} from "./jobs/reconcile-pending-rewards.js";
import { processRewardClaim } from "./modules/rewards/reward.service.js";
import { warmCourseCache } from "./cache/warmer.js";

// Versioned route modules
import { registerVersionedRoutes } from "./routes/versioning.js";

// Shutdown helpers
import { pool, closeDatabase } from "./config/database.js";
import { closeRedis } from "./config/redis.js";

async function processRetryJob(job: RetryJob): Promise<boolean> {
  try {
    const success = await processRewardClaim(
      job.submissionId,
      job.userId,
    );
    if (success) {
      logger.info(
        { submissionId: job.submissionId },
        "Queued reward processed successfully",
      );
    }
    return success;
  } catch (err) {
    logger.error({ err, submissionId: job.submissionId }, "Retry job failed");
    return false;
  }
}

async function buildApp() {
  initTracing();

  const app = Fastify({
    bodyLimit: 1024 * 100, // 100KB
    logger: {
      level: config.NODE_ENV === "production" ? "info" : "debug",
      transport:
        config.NODE_ENV !== "production"
          ? { target: "pino-pretty", options: { colorize: true } }
          : undefined,
    },
    requestIdHeader: "x-request-id",
    genReqId: () => crypto.randomUUID(),
  });

  // ─── Plugins ────────────────────────────────────────────────────────────

  // #220: OWASP security headers via @fastify/helmet.
  // Content-Security-Policy is set to a restrictive baseline — the API only
  // serves JSON so no scripts/styles are needed; adjust if a docs UI is added.
  await app.register(helmet, {
    contentSecurityPolicy: {
      directives: {
        defaultSrc: ["'none'"],
        scriptSrc: ["'none'"],
        objectSrc: ["'none'"],
        frameAncestors: ["'none'"],
      },
    },
    // X-Frame-Options: DENY (redundant with CSP frameAncestors but kept for
    // older clients that don't support CSP).
    frameguard: { action: "deny" },
    // Strict-Transport-Security: 1 year, includeSubDomains, preload.
    hsts: {
      maxAge: 31_536_000,
      includeSubDomains: true,
      preload: true,
    },
    referrerPolicy: { policy: "no-referrer" },
    // X-Content-Type-Options: nosniff (prevents MIME-sniffing attacks).
    noSniff: true,
    // X-XSS-Protection is legacy but still useful for older browsers.
    xssFilter: true,
    // Remove X-Powered-By to avoid fingerprinting.
    hidePoweredBy: true,
  });

  // CSRF note: auth is via the `Authorization: Bearer` header, which is
  // CSRF-safe (cross-site requests can't set custom headers). `credentials:
  // true` only matters if auth ever moves to cookies — if it does, add a CSRF
  // token (e.g. @fastify/csrf-protection) and restrict the origin list.
  await app.register(cors, {
    origin:
      config.NODE_ENV === "production"
        ? ["https://chainlearn.io"]
        : ["http://localhost:3000"],
    credentials: true,
  });

  await app.register(jwt, {
    secret: config.JWT_SECRET,
    sign: { expiresIn: "24h" },
  });

  await app.register(rateLimit, rateLimitOptions());

  // ─── Observability ──────────────────────────────────────────────────────
  setupInfraMetrics(pool, redis);
  registerMetricsHook(app);

  // ─── Error Handler ──────────────────────────────────────────────────────
  registerErrorHandler(app);

  // ─── Health Check ───────────────────────────────────────────────────────
  app.get("/health", async (_request, reply) => {
    const [dbCheck, redisCheck, horizonCheck, sorobanCheck] =
      await Promise.allSettled([
        db.execute(sql`SELECT 1`),
        redis.ping(),
        stellarClient.getHorizonServer().root(),
        stellarClient.checkSorobanHealth(),
      ]);

    const allHealthy = [dbCheck, redisCheck, horizonCheck, sorobanCheck].every(
      (c) => c.status === "fulfilled",
    );

    const status = allHealthy ? "healthy" : "degraded";

    return reply.status(allHealthy ? 200 : 503).send({
      status,
      timestamp: new Date().toISOString(),
      uptime: process.uptime(),
      checks: {
        database: dbCheck.status === "fulfilled" ? "ok" : "error",
        redis: redisCheck.status === "fulfilled" ? "ok" : "error",
        horizon: horizonCheck.status === "fulfilled" ? "ok" : "error",
        soroban: sorobanCheck.status === "fulfilled" ? "ok" : "error",
      },
    });
  });

  app.get("/metrics", { preHandler: authGuard }, async (_request, reply) => {
    reply.header("Content-Type", registry.contentType);
    return reply.send(await registry.metrics());
  });

  app.get("/health/live", async () => ({ status: "ok" }));

  app.get("/health/ready", async (_request, reply) => {
    const [dbCheck, redisCheck, horizonCheck, sorobanCheck] =
      await Promise.allSettled([
        db.execute(sql`SELECT 1`),
        redis.ping(),
        stellarClient.getHorizonServer().root(),
        stellarClient.checkSorobanHealth(),
      ]);

    const allHealthy = [dbCheck, redisCheck, horizonCheck, sorobanCheck].every(
      (c) => c.status === "fulfilled",
    );

    return reply.status(allHealthy ? 200 : 503).send({
      status: allHealthy ? "ready" : "not_ready",
      checks: {
        database: dbCheck.status === "fulfilled" ? "ok" : "error",
        redis: redisCheck.status === "fulfilled" ? "ok" : "error",
        horizon: horizonCheck.status === "fulfilled" ? "ok" : "error",
        soroban: sorobanCheck.status === "fulfilled" ? "ok" : "error",
      },
    });
  });

  // ─── API Routes ─────────────────────────────────────────────────────────
  await registerVersionedRoutes(app);

  return app;
}

async function start() {
  const app = await buildApp();

  startRetryProcessor(processRetryJob);
  startIdempotencyCleanup();
  startReconciliationJob();
  // Re-enqueue any reward claims dropped during a Redis restart (#208).
  recoverLostJobs().catch((err) => logger.error({ err }, "recoverLostJobs startup failed"));

  let cacheWarmInterval: ReturnType<typeof setInterval> | null = null;

  try {
    await warmCourseCache();
    cacheWarmInterval = setInterval(
      async () => {
        await warmCourseCache();
      },
      5 * 60 * 1000,
    );
  } catch (error) {
    logger.error({ error }, "Cache warmer initialization failed");
  }

  const SHUTDOWN_TIMEOUT_MS = 10_000;

  const shutdown = async (signal: string) => {
    // #216: Force-exit if graceful shutdown exceeds the deadline so the
    // process doesn't hang indefinitely when DB or Redis is stuck.
    const forceExit = setTimeout(() => {
      logger.error(
        { timeoutMs: SHUTDOWN_TIMEOUT_MS },
        "Graceful shutdown timed out — forcing exit",
      );
      process.exit(1);
    }, SHUTDOWN_TIMEOUT_MS);
    // Don't let this timer itself keep the event loop alive.
    forceExit.unref();

    logger.info({ signal }, "Received shutdown signal");
    stopRetryProcessor();
    stopIdempotencyCleanup();
    stopReconciliationJob();
    if (cacheWarmInterval) {
      clearInterval(cacheWarmInterval);
    }
    await app.close();
    await closeDatabase();
    await closeRedis();
    await shutdownTracing();
    clearTimeout(forceExit);
    logger.info("Server shut down cleanly");
    process.exit(0);
  };

  process.on("SIGTERM", () => shutdown("SIGTERM"));
  process.on("SIGINT", () => shutdown("SIGINT"));

  try {
    await app.listen({ port: config.PORT, host: config.HOST });
    logger.info(
      { port: config.PORT, env: config.NODE_ENV },
      "ChainLearn API server started",
    );
  } catch (err) {
    logger.fatal(err, "Failed to start server");
    process.exit(1);
  }
}

export { buildApp };

if (process.env.NODE_ENV !== "test") {
  start();
}
