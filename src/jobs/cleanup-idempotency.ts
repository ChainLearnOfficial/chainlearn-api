import { cleanupIdempotencyKeys } from "../middleware/idempotency.js";
import { logger } from "../utils/logger.js";

let cleanupInterval: ReturnType<typeof setInterval> | null = null;

export function startIdempotencyCleanup(): void {
  const CLEANUP_INTERVAL_MS = 60 * 60 * 1000; // 1 hour

  cleanupInterval = setInterval(async () => {
    try {
      const deleted = await cleanupIdempotencyKeys();
      if (deleted > 0) {
        logger.info({ deleted }, "Cleaned up expired idempotency keys");
      }
    } catch (err) {
      logger.error({ err }, "Failed to clean up idempotency keys");
    }
  }, CLEANUP_INTERVAL_MS);
}

export function stopIdempotencyCleanup(): void {
  if (cleanupInterval) {
    clearInterval(cleanupInterval);
    cleanupInterval = null;
  }
}
