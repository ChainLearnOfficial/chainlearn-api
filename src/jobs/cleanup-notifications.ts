import { lt } from "drizzle-orm";
import { db } from "../config/database.js";
import { notifications } from "../database/schema.js";
import { logger } from "../utils/logger.js";

const NOTIFICATION_RETENTION_MS = 30 * 24 * 60 * 60 * 1000; // 30 days

let cleanupInterval: ReturnType<typeof setInterval> | null = null;

export async function cleanupExpiredNotifications(): Promise<number> {
  const cutoff = new Date(Date.now() - NOTIFICATION_RETENTION_MS);
  const result = await db
    .delete(notifications)
    .where(lt(notifications.createdAt, cutoff))
    .returning({ id: notifications.id });

  return result.length;
}

export function startNotificationCleanup(): void {
  const CLEANUP_INTERVAL_MS = 60 * 60 * 1000; // 1 hour

  cleanupInterval = setInterval(async () => {
    try {
      const deleted = await cleanupExpiredNotifications();
      if (deleted > 0) {
        logger.info({ deleted }, "Cleaned up expired notifications");
      }
    } catch (err) {
      logger.error({ err }, "Failed to clean up expired notifications");
    }
  }, CLEANUP_INTERVAL_MS);
}

export function stopNotificationCleanup(): void {
  if (cleanupInterval) {
    clearInterval(cleanupInterval);
    cleanupInterval = null;
  }
}
