import { redis } from "../config/redis.js";
import { ConflictError } from "./errors.js";
import crypto from "node:crypto";
import { logger } from "./logger.js";

export async function withLock<T>(
  key: string,
  fn: () => Promise<T>,
  ttlMs: number = 30_000
): Promise<T> {
  const lockKey = `lock:${key}`;
  const lockValue = crypto.randomUUID();

  const acquired = await redis.set(
    lockKey,
    lockValue,
    "PX",
    ttlMs,
    "NX"
  );
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
    const script = `
      if redis.call("get", KEYS[1]) == ARGV[1] then
        return redis.call("del", KEYS[1])
      else
        return 0
      end
    `;
    await redis.eval(script, 1, lockKey, lockValue);
  }
}
