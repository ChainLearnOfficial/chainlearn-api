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
        security: [{ bearerAuth: [] }],
        body: {
          type: "object", required: ["submissionId", "idempotencyKey"],
          properties: {
            submissionId: { type: "string", format: "uuid" },
            idempotencyKey: { type: "string", minLength: 16, maxLength: 64 },
          },
        },
      } as FastifySchema,
    },
    (request, reply) => rewardController.claim(request, reply)
  );

  app.get(
    "/pending",
    {
      schema: {
        description:
          "List the caller's pending reward claims (queued or awaiting confirmation)",
        tags: ["rewards"],
        security: [{ bearerAuth: [] }],
      } as FastifySchema,
    },
    (request, reply) => rewardController.pending(request, reply)
  );

  app.get<{ Querystring: import("./reward.types.js").GetHistoryQuery }>(
    "/history",
    {
      preHandler: [validate({ querystring: getHistorySchema })],
      schema: {
        description: "Get reward claim history",
        tags: ["rewards"],
        security: [{ bearerAuth: [] }],
        querystring: {
          type: "object",
          properties: {
            page: { type: "integer", minimum: 1, default: 1 },
            limit: { type: "integer", minimum: 1, maximum: 50, default: 20 },
          },
        },
      } as FastifySchema,
    },
    (request, reply) => rewardController.history(request, reply)
  );
}
