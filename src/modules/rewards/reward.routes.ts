import type { FastifyInstance } from "fastify";
import { rewardController } from "./reward.controller.js";
import { authGuard } from "../../middleware/auth.js";
import { validate } from "../../middleware/validation.js";
import { claimRewardSchema } from "./reward.types.js";

export async function rewardRoutes(app: FastifyInstance): Promise<void> {
  app.addHook("onRequest", authGuard);

  app.post(
    "/claim",
    {
      preHandler: [validate({ body: claimRewardSchema })],
      schema: {
        description: "Claim a reward for a passed quiz",
        tags: ["rewards"],
      },
    },
    rewardController.claim.bind(rewardController)
  );

  app.get(
    "/history",
    {
      schema: {
        description: "Get reward claim history",
        tags: ["rewards"],
      },
    },
    rewardController.history.bind(rewardController)
  );
}
