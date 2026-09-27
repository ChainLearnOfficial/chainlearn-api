import type { FastifyRequest, FastifyReply } from "fastify";
import { adminUsersService } from "./admin-users.service.js";
import type { AuthenticatedRequest } from "../../middleware/auth.js";
import type {
  GrantCreditsBody,
  DeductCreditsBody,
  ListUsersQuery,
  UserIdParams,
} from "./admin.types.js";

export class AdminUsersController {
  /**
   * GET /api/v1/admin/users
   * Paginated, searchable user listing (admin only).
   */
  async list(
    request: FastifyRequest<{ Querystring: ListUsersQuery }>,
    reply: FastifyReply,
  ): Promise<void> {
    const query = request.query;
    const result = await adminUsersService.listUsers(query);

    reply.send({
      success: true,
      data: result.users,
      pagination: {
        page: query.page,
        limit: query.limit,
        total: result.total,
      },
    });
  }

  /**
   * POST /api/v1/admin/users/:id/ban
   * Ban a user and invalidate sessions (admin only).
   */
  async ban(
    request: FastifyRequest<{
      Params: { id: string };
      Body: { reason: string };
    }>,
    reply: FastifyReply,
  ): Promise<void> {
    const { id } = request.params;
    const { reason } = request.body;
    await adminUsersService.banUser(id, reason);

    reply.send({ success: true, message: "User banned successfully" });
  }

  /**
   * POST /api/v1/admin/users/:id/credits/grant
   * Grant credits to a user, with a reason and an optional reference
   * (#386). Audit-logged, including the admin who performed it.
   */
  async grantCredits(
    request: FastifyRequest<{ Params: UserIdParams; Body: GrantCreditsBody }>,
    reply: FastifyReply,
  ): Promise<void> {
    const { id } = request.params;
    const { amount, reason, reference } = request.body;
    const actorId = (request as AuthenticatedRequest).authUser.id;

    const result = await adminUsersService.grantCredits(
      id,
      amount,
      reason,
      reference,
      actorId,
    );

    reply.send({ success: true, data: result });
  }

  /**
   * POST /api/v1/admin/users/:id/credits/deduct
   * Deduct credits from a user, with a reason and an optional reference.
   * Audit-logged, including the admin who performed it.
   */
  async deductCredits(
    request: FastifyRequest<{ Params: UserIdParams; Body: DeductCreditsBody }>,
    reply: FastifyReply,
  ): Promise<void> {
    const { id } = request.params;
    const { amount, reason, reference } = request.body;
    const actorId = (request as AuthenticatedRequest).authUser.id;

    const result = await adminUsersService.deductCredits(
      id,
      amount,
      reason,
      reference,
      actorId,
    );

    reply.send({ success: true, data: result });
  }

  /**
   * GET /api/v1/admin/users/:id/activity
   * Get user activity feed (admin only).
   */
  async getActivity(
    request: FastifyRequest<{ Params: { id: string } }>,
    reply: FastifyReply,
  ): Promise<void> {
    const { id } = request.params;
    const activities = await adminUsersService.getUserActivity(id);

    reply.send({
      success: true,
      data: activities,
    });
  }
}

export const adminUsersController = new AdminUsersController();
