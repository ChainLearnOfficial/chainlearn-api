import { redis } from "../config/redis.js";
import { ConflictError } from "./errors.js";
import crypto from "node:crypto";

export async function withLock<T>(
  key: string,
  fn: () => Promise<T>,
  ttlMs: number = 10_000
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

  try {
    return await fn();
  } finally {
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
