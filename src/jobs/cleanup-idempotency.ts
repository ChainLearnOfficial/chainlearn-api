import { logger } from "../utils/logger.js";
import { cleanupExpiredIdempotencyKeys } from "../middleware/idempotency.js";

const CLEANUP_INTERVAL_MS = 24 * 60 * 60 * 1000;

export async function runIdempotencyCleanupOnce(): Promise<number> {
  return cleanupExpiredIdempotencyKeys();
}

export function startIdempotencyCleanupJob(): () => void {
  const timer = setInterval(() => {
    cleanupExpiredIdempotencyKeys().catch((err) => {
      logger.error({ err }, "Failed to clean up expired idempotency keys");
    });
  }, CLEANUP_INTERVAL_MS);

  return () => clearInterval(timer);
}