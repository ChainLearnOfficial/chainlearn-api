import type { FastifyRequest, FastifyReply } from "fastify";
import { redis } from "../config/redis.js";
import { logger } from "../utils/logger.js";

const BLOCK_PREFIX = "auth:block:";
const FAIL_PREFIX = "auth:fail:";
const MAX_FAILURES = 10;
const INITIAL_BLOCK_SECONDS = 300; // 5 minutes
const MAX_BLOCK_SECONDS = 3600; // 1 hour
const FAILURE_WINDOW_SECONDS = 300; // 5 minutes

function getIp(request: FastifyRequest): string {
  return request.ip;
}

/**
 * Record a failed auth attempt for the given IP.
 * Blocks the IP if the failure threshold is exceeded.
 */
export async function recordAuthFailure(request: FastifyRequest): Promise<void> {
  const ip = getIp(request);
  const key = `${FAIL_PREFIX}${ip}`;

  const count = await redis.incr(key);
  if (count === 1) {
    await redis.expire(key, FAILURE_WINDOW_SECONDS);
  }

  if (count >= MAX_FAILURES) {
    const existingTtl = await redis.ttl(`${BLOCK_PREFIX}${ip}`);
    if (existingTtl <= 0) {
      await redis.setex(`${BLOCK_PREFIX}${ip}`, INITIAL_BLOCK_SECONDS, "1");
      logger.warn({ ip, failures: count }, "IP temporarily blocked for repeated auth failures");
    }
  }
}

/**
 * Clear failure count on successful auth.
 */
export async function clearAuthFailures(request: FastifyRequest): Promise<void> {
  const ip = getIp(request);
  await redis.del(`${FAIL_PREFIX}${ip}`);
}

/**
 * Pre-handler that rejects requests from blocked IPs.
 */
export async function checkIpBlock(
  request: FastifyRequest,
  reply: FastifyReply
): Promise<void> {
  const ip = getIp(request);
  const blocked = await redis.get(`${BLOCK_PREFIX}${ip}`);
  if (blocked) {
    const ttl = await redis.ttl(`${BLOCK_PREFIX}${ip}`);
    reply.code(429).header("Retry-After", String(ttl)).send({
      statusCode: 429,
      error: "Too Many Requests",
      message: `IP temporarily blocked due to repeated auth failures. Retry after ${ttl}s.`,
    });
  }
}

/**
 * Admin: list all currently blocked IPs.
 */
export async function listBlockedIps(): Promise<Array<{ ip: string; ttl: number }>> {
  const keys: string[] = [];
  let cursor = "0";
  do {
    const [nextCursor, found] = await redis.scan(
      cursor,
      "MATCH",
      `${BLOCK_PREFIX}*`,
      "COUNT",
      100
    );
    cursor = nextCursor;
    keys.push(...found);
  } while (cursor !== "0");

  const results: Array<{ ip: string; ttl: number }> = [];
  for (const key of keys) {
    const ttl = await redis.ttl(key);
    results.push({ ip: key.replace(BLOCK_PREFIX, ""), ttl });
  }
  return results;
}

/**
 * Admin: clear a specific IP block.
 */
export async function clearIpBlock(ip: string): Promise<boolean> {
  const deleted = await redis.del(`${BLOCK_PREFIX}${ip}`, `${FAIL_PREFIX}${ip}`);
  return deleted > 0;
}