import type { FastifyRequest, FastifyReply } from "fastify";
import { adminUsersService } from "./admin-users.service.js";
import type { ListUsersQuery } from "./admin.types.js";

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
}

export const adminUsersController = new AdminUsersController();
