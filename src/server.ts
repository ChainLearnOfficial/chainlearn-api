import { initTracing, shutdownTracing } from "./tracing.js";

import { createReadStream } from "node:fs";
import { access } from "node:fs/promises";
import path from "node:path";
import Fastify from "fastify";
import cors from "@fastify/cors";
import helmet from "@fastify/helmet";
import jwt from "@fastify/jwt";
import multipart from "@fastify/multipart";
import rateLimit from "@fastify/rate-limit";
import swagger from "@fastify/swagger";
import swaggerUi from "@fastify/swagger-ui";
import { sql } from "drizzle-orm";
import { config, corsOrigins } from "./config/index.js";
import { logger } from "./utils/logger.js";
import { registry, setupInfraMetrics } from "./metrics/index.js";
import { registerMetricsHook } from "./metrics/fastify-hook.js";
import { registerErrorHandler } from "./middleware/error-handler.js";
import { registerRequestTimeout } from "./middleware/timeout.js";
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
  startNotificationCleanup,
  stopNotificationCleanup,
} from "./jobs/cleanup-notifications.js";
import {
  startReconciliationJob,
  stopReconciliationJob,
} from "./jobs/reconcile-pending-rewards.js";
import {
  startWebhookRetryProcessor,
  stopWebhookRetryProcessor,
} from "./jobs/process-webhook-retries.js";
import { processRewardClaim } from "./modules/rewards/reward.service.js";
import { warmCourseCache } from "./cache/warmer.js";
import { runWithRequestContext } from "./utils/request-context.js";

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
    bodyLimit: config.REQUEST_BODY_LIMIT_BYTES,
    logger,
    // requestIdHeader tells Fastify to reuse a client-supplied X-Request-Id
    // as request.id instead of always minting a fresh one via genReqId —
    // genReqId only runs when the header is absent or blank (#287).
    requestIdHeader: "x-request-id",
    // Match the field name the shared `logger` mixin uses (see
    // utils/logger.ts) so Fastify's own automatic "incoming request" /
    // "request completed" log lines carry `requestId` too, not `reqId`
    // (#287) — one consistent field to grep/filter logs by regardless of
    // whether a line came from Fastify itself or application code.
    requestIdLogLabel: "requestId",
    genReqId: () => crypto.randomUUID(),
  });

  app.addHook("onRequest", (request, _reply, done) => {
    runWithRequestContext(request.id, done);
  });

  // #287: echo the request ID on every response, including error responses,
  // health checks, and anything outside registerVersionedRoutes — the
  // envelope hook (response-envelope.ts) only puts it in the JSON body's
  // `meta` for 2xx JSON responses. onSend runs for every request regardless
  // of route or status code, so this is the one place that reliably covers
  // all of them.
  app.addHook("onSend", (request, reply, payload, done) => {
    reply.header("x-request-id", request.id);
    done(null, payload);
  });

  await app.register(swagger, {
    openapi: {
      info: {
        title: "ChainLearn API",
        description: "API for the ChainLearn Stellar-based learning platform",
        version: "1.0.0",
      },
      components: {
        securitySchemes: {
          bearerAuth: { type: "http", scheme: "bearer", bearerFormat: "JWT" },
        },
      },
      tags: [
        { name: "auth", description: "SEP-10 authentication" },
        { name: "users", description: "User profile and progress" },
        { name: "courses", description: "Course discovery and enrollment" },
        { name: "quizzes", description: "Quiz generation and submission" },
        { name: "rewards", description: "Learning rewards" },
        { name: "credentials", description: "Course credentials" },
      ],
    },
  });

  await app.register(swaggerUi, { routePrefix: "/docs" });

  // ─── Plugins ────────────────────────────────────────────────────────────

  // #220: OWASP security headers via @fastify/helmet.
  // Content-Security-Policy is set to a restrictive baseline — the API only
  // serves JSON so no scripts/styles are needed; adjust if a docs UI is added.
  await app.register(helmet, {
    contentSecurityPolicy: {
      directives: {
        defaultSrc: ["'none'"],
        scriptSrc: ["'self'"],
        styleSrc: ["'self'", "'unsafe-inline'"],
        imgSrc: ["'self'", "data:"],
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
  //
  // `corsOrigins` comes from config: CORS_ORIGINS (comma-separated) when set,
  // otherwise the per-environment default (chainlearn.io in production,
  // localhost:3000 elsewhere) — see src/config/index.ts.
  await app.register(cors, {
    origin: corsOrigins,
    credentials: true,
  });

  await app.register(jwt, {
    secret: config.JWT_SECRET,
    sign: { expiresIn: "24h" },
  });

  await app.register(rateLimit, rateLimitOptions());

  await app.register(multipart, {
    limits: {
      fileSize: config.MULTIPART_BODY_LIMIT_BYTES,
      files: 1,
    },
  });

  // ─── Observability ──────────────────────────────────────────────────────
  setupInfraMetrics(pool, redis);
  registerMetricsHook(app);

  // ─── Error Handler ──────────────────────────────────────────────────────
  registerErrorHandler(app);

  // ─── Request Timeout ────────────────────────────────────────────────────
  registerRequestTimeout(app);

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

  app.get<{ Params: { filename: string } }>(
    "/uploads/avatars/:filename",
    async (request, reply) => {
      const { filename } = request.params;
      if (!/^[A-Za-z0-9_-]+\\.(jpg|png|webp)$/.test(filename)) {
        return reply.status(404).send({
          statusCode: 404,
          error: "NOT_FOUND",
          message: "Route not found",
        });
      }

      const filePath = path.join(path.resolve(config.AVATAR_UPLOAD_DIR), filename);
      try {
        await access(filePath);
      } catch {
        return reply.status(404).send({
          statusCode: 404,
          error: "NOT_FOUND",
          message: "Route not found",
        });
      }

      const contentType = filename.endsWith(".png")
        ? "image/png"
        : filename.endsWith(".webp")
          ? "image/webp"
          : "image/jpeg";

      reply.header("Content-Type", contentType);
      return reply.send(createReadStream(filePath));
    },
  );

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
  startNotificationCleanup();
  startReconciliationJob();
  startWebhookRetryProcessor();
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
    stopNotificationCleanup();
    stopReconciliationJob();
    stopWebhookRetryProcessor();
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
