import Fastify from "fastify";
import cors from "@fastify/cors";
import jwt from "@fastify/jwt";
import rateLimit from "@fastify/rate-limit";
import { sql } from "drizzle-orm";
import { config } from "./config/index.js";
import { logger } from "./utils/logger.js";
import { registerErrorHandler } from "./middleware/error-handler.js";
import { rateLimitOptions } from "./middleware/rate-limit.js";
import { db } from "./config/database.js";
import { redis } from "./config/redis.js";
import { stellarClient } from "./stellar/client.js";
import {
  startRetryProcessor,
  stopRetryProcessor,
  type RetryJob,
} from "./services/retry-queue.js";
import { invokeContract } from "./stellar/transactions.js";
import { createQuizProof } from "./stellar/signatures.js";

// Route modules
import { authRoutes } from "./modules/auth/auth.routes.js";
import { userRoutes } from "./modules/users/user.routes.js";
import { courseRoutes } from "./modules/courses/course.routes.js";
import { quizRoutes } from "./modules/quizzes/quiz.routes.js";
import { rewardRoutes } from "./modules/rewards/reward.routes.js";
import { credentialRoutes } from "./modules/credentials/credential.routes.js";

// Shutdown helpers
import { closeDatabase } from "./config/database.js";
import { closeRedis } from "./config/redis.js";

import {
  quizSubmissions,
  quizzes,
  users,
} from "./database/schema.js";
import { eq } from "drizzle-orm";
import StellarSdk from "@stellar/stellar-sdk";

async function processRetryJob(job: RetryJob): Promise<boolean> {
  try {
    const [submission] = await db
      .select()
      .from(quizSubmissions)
      .where(eq(quizSubmissions.id, job.submissionId));

    if (!submission || submission.rewardClaimed) {
      return true;
    }

    const [quiz] = await db
      .select()
      .from(quizzes)
      .where(eq(quizzes.id, submission.quizId));

    if (!quiz) return true;

    const proof = createQuizProof(job.userId, submission.quizId, job.score);

    const [user] = await db
      .select()
      .from(users)
      .where(eq(users.id, job.userId));

    if (!user) return true;

    const txHash = await invokeContract(
      config.STELLAR_REWARD_CONTRACT_ID,
      "claim_reward",
      [
        StellarSdk.Address.fromString(user.stellarAddress).toScVal(),
        StellarSdk.nativeToScVal(job.score, { type: "u32" }),
        StellarSdk.nativeToScVal(Buffer.from(proof.signature, "base64")),
      ]
    );

    await db
      .update(quizSubmissions)
      .set({ rewardClaimed: true, txHash })
      .where(eq(quizSubmissions.id, job.submissionId));

    await db
      .update(users)
      .set({
        credits: sql`${users.credits} + 10`,
      })
      .where(eq(users.id, job.userId));

    logger.info(
      { submissionId: job.submissionId, txHash },
      "Queued reward processed successfully"
    );
    return true;
  } catch (err) {
    logger.error({ err, submissionId: job.submissionId }, "Retry job failed");
    return false;
  }
}

async function buildApp() {
  const app = Fastify({
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
  await app.register(cors, {
    origin: config.NODE_ENV === "production" ? ["https://chainlearn.io"] : true,
    credentials: true,
  });

  await app.register(jwt, {
    secret: config.JWT_SECRET,
    sign: { expiresIn: "24h" },
  });

  await app.register(rateLimit, rateLimitOptions());

  // ─── Error Handler ──────────────────────────────────────────────────────
  registerErrorHandler(app);

  // ─── Health Check ───────────────────────────────────────────────────────
  app.get("/health", async (_request, reply) => {
    const [dbCheck, redisCheck, stellarCheck] = await Promise.allSettled([
      db.execute(sql`SELECT 1`),
      redis.ping(),
      stellarClient.getHorizonServer().root(),
    ]);

    const allHealthy = [dbCheck, redisCheck, stellarCheck].every(
      (c) => c.status === "fulfilled"
    );

    const status = allHealthy ? "healthy" : "degraded";

    return reply.status(allHealthy ? 200 : 503).send({
      status,
      timestamp: new Date().toISOString(),
      uptime: process.uptime(),
      checks: {
        database: dbCheck.status === "fulfilled" ? "ok" : "error",
        redis: redisCheck.status === "fulfilled" ? "ok" : "error",
        stellar: stellarCheck.status === "fulfilled" ? "ok" : "error",
      },
    });
  });

  app.get("/health/live", async () => ({ status: "ok" }));

  app.get("/health/ready", async (_request, reply) => {
    const [dbCheck, redisCheck, stellarCheck] = await Promise.allSettled([
      db.execute(sql`SELECT 1`),
      redis.ping(),
      stellarClient.getHorizonServer().root(),
    ]);

    const allHealthy = [dbCheck, redisCheck, stellarCheck].every(
      (c) => c.status === "fulfilled"
    );

    return reply.status(allHealthy ? 200 : 503).send({
      status: allHealthy ? "ready" : "not_ready",
      checks: {
        database: dbCheck.status === "fulfilled" ? "ok" : "error",
        redis: redisCheck.status === "fulfilled" ? "ok" : "error",
        stellar: stellarCheck.status === "fulfilled" ? "ok" : "error",
      },
    });
  });

  // ─── API Routes ─────────────────────────────────────────────────────────
  await app.register(authRoutes, { prefix: "/api/auth" });
  await app.register(userRoutes, { prefix: "/api/users" });
  await app.register(courseRoutes, { prefix: "/api/courses" });
  await app.register(quizRoutes, { prefix: "/api/quizzes" });
  await app.register(rewardRoutes, { prefix: "/api/rewards" });
  await app.register(credentialRoutes, { prefix: "/api/credentials" });

  return app;
}

async function start() {
  const app = await buildApp();

  startRetryProcessor(processRetryJob);

  const shutdown = async (signal: string) => {
    logger.info({ signal }, "Received shutdown signal");
    stopRetryProcessor();
    await app.close();
    await closeDatabase();
    await closeRedis();
    logger.info("Server shut down cleanly");
    process.exit(0);
  };

  process.on("SIGTERM", () => shutdown("SIGTERM"));
  process.on("SIGINT", () => shutdown("SIGINT"));

  try {
    await app.listen({ port: config.PORT, host: config.HOST });
    logger.info(
      { port: config.PORT, env: config.NODE_ENV },
      "ChainLearn API server started"
    );
  } catch (err) {
    logger.fatal(err, "Failed to start server");
    process.exit(1);
  }
}

export { buildApp };

start();
