import { redis } from "../config/redis.js";
import { ConflictError } from "./errors.js";
import crypto from "node:crypto";

const DEFAULT_LOCK_TTL_MS = 30_000;
const MIN_RENEW_INTERVAL_MS = 25;

export async function withLock<T>(
  key: string,
  fn: () => Promise<T>,
  ttlMs: number = DEFAULT_LOCK_TTL_MS
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

  const renewScript = `
    if redis.call("get", KEYS[1]) == ARGV[1] then
      return redis.call("pexpire", KEYS[1], ARGV[2])
    else
      return 0
    end
  `;
  const renewIntervalMs = Math.max(
    MIN_RENEW_INTERVAL_MS,
    Math.floor(ttlMs / 3)
  );
  const renewal = setInterval(() => {
    void redis.eval(renewScript, 1, lockKey, lockValue, ttlMs).catch(() => {
      // The next renewal tick can still extend the lock if Redis recovers.
    });
  }, renewIntervalMs);
  renewal.unref?.();

  try {
    return await fn();
  } finally {
    clearInterval(renewal);
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
