import { redis } from "../config/redis.js";
import { logger } from "./logger.js";
import { auditLog } from "../audit/index.js";

/**
 * Per-account auth failure tracking and escalating lockout (#488).
 *
 * `authRateLimit` (src/middleware/rate-limit.ts) already bounds requests per
 * *source IP* — this is the per-*account* complement, so an attacker
 * spreading attempts across many IPs against one stellarAddress still hits
 * a wall. Redis key pattern: auth:attempts:{stellarAddress}:count /
 * :lockout, per the issue's own suggestion, using INCR + EXPIRE for a
 * sliding window rather than a fixed counter that never resets.
 */

const ATTEMPTS_PREFIX = "auth:attempts:";
/** Sliding window a failure count accumulates within before expiring on its own. */
const FAILURE_WINDOW_SECONDS = 15 * 60;
/** Failures allowed within the window before the first lockout kicks in. */
const MAX_ATTEMPTS_BEFORE_LOCKOUT = 5;
/** Lockout duration doubles per failure past the threshold (progressive delay). */
const BASE_LOCKOUT_SECONDS = 30;
const MAX_LOCKOUT_SECONDS = 15 * 60;

function countKey(stellarAddress: string): string {
  return `${ATTEMPTS_PREFIX}${stellarAddress}:count`;
}

function lockoutKey(stellarAddress: string): string {
  return `${ATTEMPTS_PREFIX}${stellarAddress}:lockout`;
}

export interface LockoutStatus {
  lockedOut: boolean;
  retryAfterSeconds?: number;
}

/** Check whether an address is currently locked out, without recording anything. */
export async function checkAuthLockout(stellarAddress: string): Promise<LockoutStatus> {
  const ttl = await redis.ttl(lockoutKey(stellarAddress));
  if (ttl > 0) {
    return { lockedOut: true, retryAfterSeconds: ttl };
  }
  return { lockedOut: false };
}

/**
 * Record a failed auth attempt for an address. Once the count within the
 * sliding window reaches MAX_ATTEMPTS_BEFORE_LOCKOUT, sets (or extends) a
 * lockout whose duration doubles for each failure past the threshold, capped
 * at MAX_LOCKOUT_SECONDS, and writes an audit log entry.
 */
export async function recordAuthFailure(
  stellarAddress: string,
  context?: Record<string, unknown>,
): Promise<number> {
  const key = countKey(stellarAddress);
  const count = await redis.incr(key);
  if (count === 1) {
    await redis.expire(key, FAILURE_WINDOW_SECONDS);
  }

  if (count >= MAX_ATTEMPTS_BEFORE_LOCKOUT) {
    const excessAttempts = count - MAX_ATTEMPTS_BEFORE_LOCKOUT;
    const lockoutSeconds = Math.min(
      BASE_LOCKOUT_SECONDS * 2 ** excessAttempts,
      MAX_LOCKOUT_SECONDS,
    );
    await redis.setex(lockoutKey(stellarAddress), lockoutSeconds, "1");

    logger.warn(
      { stellarAddress, failedAttempts: count, lockoutSeconds, ...context },
      "Auth lockout triggered after repeated failed attempts",
    );
    await auditLog("auth.lockout_triggered", {
      stellarAddress,
      failedAttempts: count,
      lockoutSeconds,
      ...context,
    });
  }

  return count;
}

/** Clear an address's failure count and any active lockout, on successful auth. */
export async function clearAuthFailures(stellarAddress: string): Promise<void> {
  await redis.del(countKey(stellarAddress), lockoutKey(stellarAddress));
}
