import type { FastifyRequest, FastifyReply } from "fastify";
import { rewardService } from "./reward.service.js";
import type { AuthenticatedRequest } from "../../middleware/auth.js";
import type { ClaimRewardBody } from "./reward.types.js";

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
    const { submissionId } = (request as any).validatedBody;
    const result = await rewardService.claimReward(authUser.id, submissionId);

    reply.send({ success: true, data: result });
  }

  /**
   * GET /api/rewards/history
   * Get reward claim history for the authenticated user.
   */
  async history(
    request: FastifyRequest,
    reply: FastifyReply
  ): Promise<void> {
    const { authUser } = request as AuthenticatedRequest;
    const history = await rewardService.getHistory(authUser.id);

    reply.send({ success: true, data: history });
  }
}

export const rewardController = new RewardController();
