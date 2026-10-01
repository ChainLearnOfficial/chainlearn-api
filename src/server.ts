import Fastify from "fastify";
import cors from "@fastify/cors";
import jwt from "@fastify/jwt";
import rateLimit from "@fastify/rate-limit";
import { config } from "./config/index.js";
import { logger } from "./utils/logger.js";
import { registerErrorHandler } from "./middleware/error-handler.js";
import { rateLimitOptions } from "./middleware/rate-limit.js";
import { listBlockedIps, clearIpBlock } from "./middleware/auth-brute-force.js";

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

  // ─── CSRF Protection ───────────────────────────────────────────────────
  // Auth uses Bearer tokens (Authorization header), which are CSRF-safe.
  // credentials: true in CORS only matters if auth moves to cookies.
  // If cookie-based auth is added, enable @fastify/csrf-protection here:
  //
  //   import csrf from "@fastify/csrf-protection";
  //   await app.register(csrf, {
  //     sessionPlugin: "@fastify/cookie",
  //     csrfOpts: { ignoreMethods: ["GET", "HEAD", "OPTIONS"] },
  //   });
  //
  // Until then, no CSRF token generation or validation is needed.

  // ─── Error Handler ──────────────────────────────────────────────────────
  registerErrorHandler(app);

  // ─── Health Check ───────────────────────────────────────────────────────
  app.get("/health", async () => ({
    status: "ok",
    timestamp: new Date().toISOString(),
    uptime: process.uptime(),
  }));

  // ─── Admin: Auth IP Blocks ─────────────────────────────────────────────
  app.get("/admin/auth-blocks", async (_request, reply) => {
    const blocks = await listBlockedIps();
    reply.send({ blocks });
  });

  app.delete<{ Params: { ip: string } }>(
    "/admin/auth-blocks/:ip",
    async (request, reply) => {
      const cleared = await clearIpBlock(request.params.ip);
      reply.send({ cleared });
    }
  );

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

  // Graceful shutdown
  const shutdown = async (signal: string) => {
    logger.info({ signal }, "Received shutdown signal");
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

// Allow importing the app for testing without starting the server
export { buildApp };

start();
