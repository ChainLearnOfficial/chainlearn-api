import type { FastifyRequest, FastifyReply } from "fastify";
import { notificationService } from "./notification.service.js";
import type { AuthenticatedRequest } from "../../middleware/auth.js";
import type {
  ListNotificationsQuery,
  NotificationIdParams,
} from "./notification.types.js";

export class NotificationController {
  /**
   * GET /api/v1/users/me/notifications
   * List the authenticated user's notifications (paginated), with unread count.
   */
  async list(
    request: FastifyRequest<{ Querystring: ListNotificationsQuery }>,
    reply: FastifyReply
  ): Promise<void> {
    const { authUser } = request as AuthenticatedRequest;
    const page = await notificationService.list(authUser.id, request.query);

    reply.send({
      success: true,
      data: page.notifications,
      pagination: {
        page: request.query.page,
        limit: request.query.limit,
        total: page.total,
      },
      unreadCount: page.unreadCount,
    });
  }

  /**
   * PUT /api/v1/users/me/notifications/:id/read
   * Mark a single notification as read.
   */
  async markRead(
    request: FastifyRequest<{ Params: NotificationIdParams }>,
    reply: FastifyReply
  ): Promise<void> {
    const { authUser } = request as AuthenticatedRequest;
    const { id } = request.params;
    const notification = await notificationService.markRead(authUser.id, id);

    reply.send({ success: true, data: notification });
  }
}

export const notificationController = new NotificationController();
