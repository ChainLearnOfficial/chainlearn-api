import type { FastifyInstance, FastifySchema } from "fastify";
import { adminUsersController } from "./admin-users.controller.js";
import { authGuard, adminGuard } from "../../middleware/auth.js";
import { validate } from "../../middleware/validation.js";
import { listUsersSchema } from "./admin.types.js";

/** Admin-only user listing (#288). Every route requires an admin user. */
export async function adminUsersRoutes(app: FastifyInstance): Promise<void> {
  app.addHook("onRequest", authGuard);
  app.addHook("preHandler", adminGuard);

  app.get<{ Querystring: import("./admin.types.js").ListUsersQuery }>(
    "/",
    {
      preHandler: [validate({ querystring: listUsersSchema })],
      schema: {
        description:
          "List users, paginated and searchable by Stellar address or display name (admin only)",
        tags: ["admin", "users"],
        security: [{ bearerAuth: [] }],
        querystring: {
          type: "object",
          properties: {
            search: { type: "string" },
            page: { type: "integer", minimum: 1, default: 1 },
            limit: { type: "integer", minimum: 1, maximum: 50, default: 20 },
          },
        },
      } as FastifySchema,
    },
    (request, reply) => adminUsersController.list(request, reply),
  );
}
