import type { FastifyInstance, FastifySchema } from "fastify";
import { adminUsersController } from "./admin-users.controller.js";
import { adminGuard } from "../../middleware/auth.js";
import { validate } from "../../middleware/validation.js";
import { userIdParamsSchema, creditAdjustmentSchema } from "./admin-users.types.js";
import type { UserIdParams, CreditAdjustmentBody } from "./admin-users.types.js";

export async function adminUsersRoutes(app: FastifyInstance): Promise<void> {
  // All routes in this plugin are protected by adminGuard — the hook is
  // registered once here rather than on each individual route.
  app.addHook("preHandler", adminGuard);

  app.post<{ Params: UserIdParams; Body: CreditAdjustmentBody }>(
    "/:userId/credits/deduct",
    {
      preHandler: [
        validate({ params: userIdParamsSchema, body: creditAdjustmentSchema }),
      ],
      schema: {
        description: "Deduct credits from a user (atomic, race-condition-free)",
        tags: ["admin"],
      } as FastifySchema,
    },
    (request, reply) => adminUsersController.deductCredits(request, reply),
  );

  app.post<{ Params: UserIdParams; Body: CreditAdjustmentBody }>(
    "/:userId/credits/grant",
    {
      preHandler: [
        validate({ params: userIdParamsSchema, body: creditAdjustmentSchema }),
      ],
      schema: {
        description: "Grant credits to a user",
        tags: ["admin"],
      } as FastifySchema,
    },
    (request, reply) => adminUsersController.grantCredits(request, reply),
  );
}
