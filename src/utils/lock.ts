import { redis } from "../config/redis.js";
import { ConflictError } from "./errors.js";
import crypto from "node:crypto";
import { logger } from "./logger.js";

export async function withLock<T>(
  key: string,
  fn: () => Promise<T>,
  ttlMs: number = 60_000
): Promise<T> {
  const lockKey = `lock:${key}`;
  const lockValue = crypto.randomUUID();

  let acquired: string | null;
  try {
    acquired = await redis.set(
      lockKey,
      lockValue,
      "PX",
      ttlMs,
      "NX"
    );
  } catch (err) {
    // Redis connection error - log and proceed without lock rather than
    // failing the entire operation with a 500. This allows the underlying
    // operation to succeed even during Redis downtime, trading lock safety
    // for availability. Operations protected by withLock should also have
    // database-level constraints as a fallback.
    logger.error(
      { err, lockKey },
      "Redis connection error during lock acquisition - proceeding without lock"
    );
    return await fn();
  }

  if (!acquired) {
    throw new ConflictError("Operation in progress, please retry");
  }

  let heartbeat: NodeJS.Timeout | undefined;

  try {
    heartbeat = setInterval(async () => {
      try {
        const script = `
          if redis.call("get", KEYS[1]) == ARGV[1] then
            return redis.call("pexpire", KEYS[1], ARGV[2])
          else
            return 0
          end
        `;
        const result = await redis.eval(script, 1, lockKey, lockValue, ttlMs);
        if (result !== 1) {
          logger.warn({ lockKey }, "Lock renewal failed: lock lost or changed");
          if (heartbeat) {
            clearInterval(heartbeat);
            heartbeat = undefined;
          }
        }
      } catch (err) {
        logger.error({ err, lockKey }, "Error during lock renewal heartbeat");
      }
    }, ttlMs / 2);

    return await fn();
  } finally {
    if (heartbeat) clearInterval(heartbeat);
    try {
      const script = `
        if redis.call("get", KEYS[1]) == ARGV[1] then
          return redis.call("del", KEYS[1])
        else
          return 0
        end
      `;
      await redis.eval(script, 1, lockKey, lockValue);
    } catch (err) {
      // Log but don't throw - lock will expire naturally via TTL
      logger.error({ err, lockKey }, "Failed to release lock - will expire via TTL");
    }
  }
}
