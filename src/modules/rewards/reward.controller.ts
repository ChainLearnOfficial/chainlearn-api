import type { FastifyRequest, FastifyReply } from "fastify";
import { rewardService } from "./reward.service.js";
import type { AuthenticatedRequest } from "../../middleware/auth.js";
import type { ClaimRewardBody, GetHistoryQuery } from "./reward.types.js";
import {
  checkIdempotency,
  storeIdempotentResponse,
} from "../../middleware/idempotency.js";

export class RewardController {
  /**
   * POST /api/rewards/claim
   * Claim a reward for a passed quiz submission.
   */
  async claim(
    request: FastifyRequest<{ Body: ClaimRewardBody }>,
    reply: FastifyReply
  ): Promise<void> {
    const { authUser } = request as AuthenticatedRequest;
    const { submissionId, idempotencyKey } = request.body;

    const { cached, response } = await checkIdempotency(
      idempotencyKey,
      authUser.id,
      "/rewards/claim",
      request.body
    );

    if (cached) {
      reply.status(response!.status).send(response!.body);
      return;
    }

    try {
      const result = await rewardService.claimReward(authUser.id, submissionId);

      await storeIdempotentResponse(
        idempotencyKey,
        200,
        { success: true, data: result },
        result.txHash ?? undefined
      );

      reply.send({ success: true, data: result });
    } catch (err: unknown) {
      const statusCode =
        err && typeof err === "object" && "statusCode" in err
          ? (err as { statusCode: number }).statusCode
          : 500;
      const message =
        err instanceof Error ? err.message : "Internal server error";

      await storeIdempotentResponse(idempotencyKey, statusCode, {
        success: false,
        error: message,
      });

      throw err;
    }
  }

  /**
   * GET /api/rewards/history
   * Get reward claim history for the authenticated user, paginated.
   */
  async history(
    request: FastifyRequest<{ Querystring: GetHistoryQuery }>,
    reply: FastifyReply
  ): Promise<void> {
    const { authUser } = request as AuthenticatedRequest;
    const { page, limit } = request.query;
    const { history, total } = await rewardService.getHistory(
      authUser.id,
      page,
      limit
    );

    reply.send({
      success: true,
      data: history,
      pagination: { page, limit, total },
    });
  }
}

export const rewardController = new RewardController();
