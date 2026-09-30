import { redis } from "../config/redis.js";
import { logger } from "../utils/logger.js";
import { Counter } from "prom-client";

// In-process map used to coalesce concurrent cache-miss fetches for the same
// key so only one call reaches the DB/source (thundering-herd protection).
// The promise is stored while the fetch is in flight; all waiters share it.
const inFlightFetches = new Map<string, Promise<unknown>>();

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
 * #217: Cache-aside with thundering-herd protection.
 *
 * Returns the cached value when present. On a miss, exactly ONE concurrent
 * caller executes `fetchFn`; all other callers for the same key await the
 * same in-flight promise so the backing store receives only one request
 * regardless of how many requests arrive simultaneously.
 *
 * @param namespace - Prometheus label and key segment.
 * @param key       - Full Redis key (built with cacheKey()).
 * @param fetchFn   - Async function that fetches the value from the source.
 * @param ttl       - Cache TTL in seconds (default: DEFAULT_TTL).
 */
export async function cacheGetOrSet<T>(
  namespace: string,
  key: string,
  fetchFn: () => Promise<T>,
  ttl: number = DEFAULT_TTL,
): Promise<T> {
  const cached = await cacheGet<T>(namespace, key);
  if (cached !== null) return cached;

  // Another request for this key is already in flight — join it.
  const existing = inFlightFetches.get(key);
  if (existing) {
    return existing as Promise<T>;
  }

  // We are the winner: fetch and populate the cache.
  const fetching = fetchFn()
    .then(async (value) => {
      await cacheSet(key, value, ttl);
      return value;
    })
    .finally(() => {
      inFlightFetches.delete(key);
    });

  inFlightFetches.set(key, fetching);
  return fetching;
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
