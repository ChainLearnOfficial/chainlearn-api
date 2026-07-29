import { redis } from "../config/redis.js";
import { logger } from "../utils/logger.js";
import { Counter } from "prom-client";

const DEFAULT_TTL = 60;

export const cacheHits = new Counter({
  name: "cache_hits_total",
  help: "Total cache hits",
  labelNames: ["namespace"],
});

export const cacheMisses = new Counter({
  name: "cache_misses_total",
  help: "Total cache misses",
  labelNames: ["namespace"],
});

export interface CacheOptions {
  ttl?: number;
  prefix?: string;
}

export function cacheKey(
  namespace: string,
  ...parts: (string | number)[]
): string {
  return `chainlearn:${namespace}:${parts.join(":")}`;
}

/**
 * Builds a SCAN/DEL wildcard pattern for cacheInvalidatePattern from the
 * same namespace/parts shape cacheKey uses, instead of callers hand-writing
 * a literal string like "chainlearn:courses:list:*" (#150). If cacheKey's
 * format ever changes (prefix, separator, segment order), every pattern
 * built this way changes with it — a hardcoded literal would otherwise
 * silently stop matching anything and invalidation would go quiet with no
 * error, since cacheInvalidatePattern treats "0 keys matched" the same as
 * "nothing needed invalidating".
 */
export function cacheKeyPattern(
  namespace: string,
  ...parts: (string | number)[]
): string {
  return `${cacheKey(namespace, ...parts)}${parts.length > 0 ? ":" : ""}*`;
}

export async function cacheGet<T>(
  namespace: string,
  key: string,
): Promise<T | null> {
  try {
    const raw = await redis.get(key);
    if (!raw) {
      cacheMisses.labels({ namespace }).inc();
      return null;
    }
    cacheHits.labels({ namespace }).inc();
    return JSON.parse(raw) as T;
  } catch (err) {
    logger.warn(
      { err, key },
      "Cache read failed - Degrading gracefully to database",
    );
    return null;
  }
}

export async function cacheSet<T>(
  key: string,
  value: T,
  ttl: number = DEFAULT_TTL,
): Promise<void> {
  try {
    await redis.setex(key, ttl, JSON.stringify(value));
  } catch (err) {
    logger.warn({ err, key }, "Cache write failed");
  }
}

/**
 * Deletes precise keys safely. Avoids high-latency KEYS scanning in production.
 */
export async function cacheDel(key: string): Promise<void> {
  try {
    await redis.del(key);
  } catch (err) {
    logger.warn({ err, key }, "Cache delete failed");
  }
}

/**
 * Safely clears groups of keys using SCAN instead of KEYS *
 */
export async function cacheInvalidatePattern(pattern: string): Promise<void> {
  try {
    let cursor = "0";
    do {
      const [newCursor, keys] = await redis.scan(
        cursor,
        "MATCH",
        pattern,
        "COUNT",
        100,
      );
      cursor = newCursor;
      if (keys.length > 0) {
        await redis.del(...keys);
      }
    } while (cursor !== "0");
  } catch (err) {
    logger.warn({ err, pattern }, "Pattern cache invalidation failed");
  }
}
