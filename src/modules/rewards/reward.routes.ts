import type { FastifyInstance, FastifySchema } from "fastify";
import { rewardController } from "./reward.controller.js";
import { authGuard } from "../../middleware/auth.js";
import { validate } from "../../middleware/validation.js";
import { claimRateLimit } from "../../middleware/rate-limit.js";
import { claimRewardSchema } from "./reward.types.js";

export async function rewardRoutes(app: FastifyInstance): Promise<void> {
  app.addHook("onRequest", authGuard);

  app.post(
    "/claim",
    {
      config: { rateLimit: claimRateLimit },
      preHandler: [validate({ body: claimRewardSchema })],
      schema: {
        description: "Claim a reward for a passed quiz",
        tags: ["rewards"],
      } as FastifySchema,
    },
    ((request: any, reply: any) => rewardController.claim(request, reply)) as any
  );

  app.get(
    "/history",
    {
      schema: {
        description: "Get reward claim history",
        tags: ["rewards"],
      } as FastifySchema,
    },
    ((request: any, reply: any) => rewardController.history(request, reply)) as any
  );
}
