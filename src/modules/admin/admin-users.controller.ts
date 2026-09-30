import type { FastifyRequest, FastifyReply } from "fastify";
import { adminUsersService } from "./admin-users.service.js";
import type { UserIdParams, CreditAdjustmentBody } from "./admin-users.types.js";

export class AdminUsersController {
  /**
   * POST /api/admin/users/:userId/credits/deduct
   * Atomically deduct credits from a user. Returns the before/after balances.
   */
  async deductCredits(
    request: FastifyRequest<{
      Params: UserIdParams;
      Body: CreditAdjustmentBody;
    }>,
    reply: FastifyReply,
  ): Promise<void> {
    const { userId } = request.params;
    const { amount, reason } = request.body;

    const result = await adminUsersService.deductCredits(userId, amount, reason);

    reply.send({ success: true, data: result });
  }

  /**
   * POST /api/admin/users/:userId/credits/grant
   * Atomically grant credits to a user. Returns the before/after balances.
   */
  async grantCredits(
    request: FastifyRequest<{
      Params: UserIdParams;
      Body: CreditAdjustmentBody;
    }>,
    reply: FastifyReply,
  ): Promise<void> {
    const { userId } = request.params;
    const { amount, reason } = request.body;

    const result = await adminUsersService.grantCredits(userId, amount, reason);

    reply.send({ success: true, data: result });
  }
}

export const adminUsersController = new AdminUsersController();
