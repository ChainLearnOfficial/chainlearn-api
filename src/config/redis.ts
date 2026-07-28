import Redis from "ioredis";
import { config } from "./index.js";
import { logger } from "../utils/logger.js";

export const redis = new Redis(config.REDIS_URL, {
  maxRetriesPerRequest: 3,
  retryStrategy(times) {
    if (times > 10) return null;
    return Math.min(times * 200, 2000);
  },
});

redis.on("error", (err) => {
  logger.error({ err }, "Redis connection error");
});

redis.on("connect", () => {
  logger.info("Redis connected");
});

export async function closeRedis(): Promise<void> {
  await redis.quit();
}
