import type { FastifyInstance, FastifySchema } from "fastify";
import { rewardController } from "./reward.controller.js";
import { authGuard } from "../../middleware/auth.js";
import { validate } from "../../middleware/validation.js";
import { claimRateLimit } from "../../middleware/rate-limit.js";
import { claimRewardSchema, getHistorySchema } from "./reward.types.js";

export async function rewardRoutes(app: FastifyInstance): Promise<void> {
  app.addHook("onRequest", authGuard);

  app.post<{ Body: import("./reward.types.js").ClaimRewardBody }>(
    "/claim",
    {
      config: { rateLimit: claimRateLimit },
      preHandler: [validate({ body: claimRewardSchema })],
      schema: {
        description: "Claim a reward for a passed quiz",
        tags: ["rewards"],
      } as FastifySchema,
    },
    (request, reply) => rewardController.claim(request, reply)
  );

  app.get<{ Querystring: import("./reward.types.js").GetHistoryQuery }>(
    "/history",
    {
      preHandler: [validate({ querystring: getHistorySchema })],
      schema: {
        description: "Get reward claim history",
        tags: ["rewards"],
      } as FastifySchema,
    },
    (request, reply) => rewardController.history(request, reply)
  );
}
