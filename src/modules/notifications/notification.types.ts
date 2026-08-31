import { z } from "zod";

// ─── Request Schemas ────────────────────────────────────────────────────────

export const listNotificationsQuerySchema = z.object({
  page: z.coerce.number().int().min(1).default(1),
  limit: z.coerce.number().int().min(1).max(50).default(20),
});

export const notificationIdParamsSchema = z.object({
  id: z.string().uuid("Invalid notification ID"),
});

// ─── Types ──────────────────────────────────────────────────────────────────

export type ListNotificationsQuery = z.infer<typeof listNotificationsQuerySchema>;
export type NotificationIdParams = z.infer<typeof notificationIdParamsSchema>;

export interface NotificationItem {
  id: string;
  type: string;
  title: string;
  message: string;
  read: boolean;
  createdAt: Date;
}

export interface NotificationsPage {
  notifications: NotificationItem[];
  total: number;
  unreadCount: number;
}
