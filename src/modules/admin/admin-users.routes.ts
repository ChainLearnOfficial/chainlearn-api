import type { FastifyInstance, FastifySchema } from "fastify";
import { z } from "zod";
import { adminUsersController } from "./admin-users.controller.js";
import { authGuard, adminGuard } from "../../middleware/auth.js";
import { validate } from "../../middleware/validation.js";
import { listUsersSchema } from "./admin.types.js";

const banUserSchema = z.object({
  reason: z.string().min(1).max(500),
});

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

  app.post<{ Params: { id: string }; Body: z.infer<typeof banUserSchema> }>(
    "/:id/ban",
    {
      preHandler: [validate({ body: banUserSchema })],
      schema: {
        description: "Ban a user and invalidate sessions (admin only)",
        tags: ["admin", "users"],
        security: [{ bearerAuth: [] }],
        body: {
          type: "object",
          properties: {
            reason: { type: "string", minLength: 1, maxLength: 500 },
          },
          required: ["reason"],
        },
      } as FastifySchema,
    },
    (request, reply) => adminUsersController.ban(request, reply),
  );

  app.get<{ Params: { id: string } }>(
    "/:id/activity",
    {
      schema: {
        description: "Get user activity feed (admin only)",
        tags: ["admin", "users"],
        security: [{ bearerAuth: [] }],
      } as FastifySchema,
    },
    (request, reply) => adminUsersController.getActivity(request, reply),
  );

  app.get<{ Params: { id: string } }>(
    "/:id/credentials",
    {
      schema: {
        description:
          "Get all credentials for a user, each verified against Stellar Horizon (admin only, cached 30s, #410)",
        tags: ["admin", "users"],
        security: [{ bearerAuth: [] }],
        params: {
          type: "object",
          required: ["id"],
          properties: {
            id: { type: "string", format: "uuid" },
          },
        },
      } as FastifySchema,
    },
    (request, reply) => adminUsersController.getCredentials(request, reply),
  );
}
