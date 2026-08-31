import type { FastifyInstance, FastifySchema } from "fastify";
import { dashboardController } from "./dashboard.controller.js";
import { authGuard, adminGuard } from "../../middleware/auth.js";

/** Admin-only platform dashboard (#367). Every route requires an admin user. */
export async function dashboardRoutes(app: FastifyInstance): Promise<void> {
  app.addHook("onRequest", authGuard);
  app.addHook("preHandler", adminGuard);

  app.get(
    "/",
    {
      schema: {
        description:
          "Platform-wide statistics: users, enrollments, quiz completion rate, credentials, rewards claimed, with week-over-week trends (cached 5 minutes, admin only)",
        tags: ["admin", "dashboard"],
        security: [{ bearerAuth: [] }],
      } as FastifySchema,
    },
    (request, reply) => dashboardController.stats(request, reply)
  );
}
