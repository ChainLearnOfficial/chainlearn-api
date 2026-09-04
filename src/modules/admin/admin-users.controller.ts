import type { FastifyRequest, FastifyReply } from "fastify";
import { adminUsersService } from "./admin-users.service.js";
import type { ListUsersQuery } from "./admin.types.js";
import { credentialService } from "../credentials/credential.service.js";

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
    request: FastifyRequest<{ Params: { id: string }; Body: { reason: string } }>,
    reply: FastifyReply,
  ): Promise<void> {
    const { id } = request.params;
    const { reason } = request.body;
    await adminUsersService.banUser(id, reason);

    reply.send({ success: true, message: "User banned successfully" });
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

  /**
   * GET /api/v1/admin/users/:id/credentials
   * All credentials for a user with live on-chain verification (#410).
   */
  async getCredentials(
    request: FastifyRequest<{ Params: { id: string } }>,
    reply: FastifyReply
  ): Promise<void> {
    const { id } = request.params;
    const credentials = await credentialService.getAdminUserCredentials(id);

    reply.send({
      success: true,
      data: credentials,
    });
  }
}

export const adminUsersController = new AdminUsersController();
