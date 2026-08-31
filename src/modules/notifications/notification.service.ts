import { and, count, desc, eq } from "drizzle-orm";
import { db } from "../../config/database.js";
import { notifications } from "../../database/schema.js";
import { NotFoundError } from "../../utils/errors.js";
import type {
  ListNotificationsQuery,
  NotificationItem,
  NotificationsPage,
} from "./notification.types.js";

export class NotificationService {
  private toItem(row: typeof notifications.$inferSelect): NotificationItem {
    return {
      id: row.id,
      type: row.type,
      title: row.title,
      message: row.message,
      read: row.read,
      createdAt: row.createdAt,
    };
  }

  /**
   * Paginated notifications for a user, newest first, with the total
   * unread count (independent of the current page) so a client can show a
   * badge without paging through every notification.
   */
  async list(
    userId: string,
    query: ListNotificationsQuery,
  ): Promise<NotificationsPage> {
    const offset = (query.page - 1) * query.limit;

    const [[totalResult], [unreadResult], rows] = await Promise.all([
      db
        .select({ value: count() })
        .from(notifications)
        .where(eq(notifications.userId, userId)),
      db
        .select({ value: count() })
        .from(notifications)
        .where(
          and(eq(notifications.userId, userId), eq(notifications.read, false)),
        ),
      db
        .select()
        .from(notifications)
        .where(eq(notifications.userId, userId))
        .orderBy(desc(notifications.createdAt))
        .limit(query.limit)
        .offset(offset),
    ]);

    return {
      notifications: rows.map((row) => this.toItem(row)),
      total: totalResult?.value ?? 0,
      unreadCount: unreadResult?.value ?? 0,
    };
  }

  /** Marks a single notification as read. Scoped to the owning user. */
  async markRead(
    userId: string,
    notificationId: string,
  ): Promise<NotificationItem> {
    const [updated] = await db
      .update(notifications)
      .set({ read: true })
      .where(
        and(
          eq(notifications.id, notificationId),
          eq(notifications.userId, userId),
        ),
      )
      .returning();

    if (!updated) {
      throw new NotFoundError("Notification");
    }

    return this.toItem(updated);
  }
}

export const notificationService = new NotificationService();
