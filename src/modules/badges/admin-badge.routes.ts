import type { FastifyInstance, FastifySchema } from "fastify";
import { badgeController } from "./badge.controller.js";
import { authGuard, adminGuard } from "../../middleware/auth.js";
import { validate } from "../../middleware/validation.js";
import {
  createBadgeSchema,
  updateBadgeSchema,
  badgeIdParamsSchema,
} from "./badge.types.js";

/** Admin-only badge management (#380). Every route requires an admin user. */
export async function adminBadgeRoutes(app: FastifyInstance): Promise<void> {
  app.addHook("onRequest", authGuard);
  app.addHook("preHandler", adminGuard);

  app.post<{ Body: import("./badge.types.js").CreateBadgeBody }>(
    "/",
    {
      preHandler: [validate({ body: createBadgeSchema })],
      schema: {
        description: "Create a new badge definition (admin only, #380)",
        tags: ["admin", "badges"],
        security: [{ bearerAuth: [] }],
        body: {
          type: "object",
          required: ["name", "description", "iconUrl", "type", "criteria"],
          properties: {
            name: { type: "string", minLength: 1, maxLength: 255 },
            description: { type: "string", minLength: 1 },
            iconUrl: { type: "string", minLength: 1 },
            type: {
              type: "string",
              enum: [
                "enrollment",
                "quiz_completion",
                "credential",
                "streak",
                "course_completion",
              ],
            },
            criteria: { type: "object" },
          },
        },
      } as FastifySchema,
    },
    (request, reply) => badgeController.adminCreate(request, reply),
  );

  app.get(
    "/",
    {
      schema: {
        description: "List all badge definitions (admin only, #380)",
        tags: ["admin", "badges"],
        security: [{ bearerAuth: [] }],
      } as FastifySchema,
    },
    (request, reply) => badgeController.adminList(request, reply),
  );

  app.get<{ Params: { id: string } }>(
    "/:id",
    {
      preHandler: [validate({ params: badgeIdParamsSchema })],
      schema: {
        description: "Get a badge definition by ID (admin only, #380)",
        tags: ["admin", "badges"],
        security: [{ bearerAuth: [] }],
        params: {
          type: "object",
          required: ["id"],
          properties: { id: { type: "string", format: "uuid" } },
        },
      } as FastifySchema,
    },
    (request, reply) => badgeController.adminGet(request, reply),
  );

  app.put<{
    Params: { id: string };
    Body: import("./badge.types.js").UpdateBadgeBody;
  }>(
    "/:id",
    {
      preHandler: [
        validate({ params: badgeIdParamsSchema, body: updateBadgeSchema }),
      ],
      schema: {
        description: "Update a badge definition (admin only, #380)",
        tags: ["admin", "badges"],
        security: [{ bearerAuth: [] }],
        params: {
          type: "object",
          required: ["id"],
          properties: { id: { type: "string", format: "uuid" } },
        },
        body: {
          type: "object",
          properties: {
            name: { type: "string", minLength: 1, maxLength: 255 },
            description: { type: "string", minLength: 1 },
            iconUrl: { type: "string", minLength: 1 },
            type: {
              type: "string",
              enum: [
                "enrollment",
                "quiz_completion",
                "credential",
                "streak",
                "course_completion",
              ],
            },
            criteria: { type: "object" },
          },
        },
      } as FastifySchema,
    },
    (request, reply) => badgeController.adminUpdate(request, reply),
  );

  app.delete<{ Params: { id: string } }>(
    "/:id",
    {
      preHandler: [validate({ params: badgeIdParamsSchema })],
      schema: {
        description: "Delete a badge definition (admin only, #380)",
        tags: ["admin", "badges"],
        security: [{ bearerAuth: [] }],
        params: {
          type: "object",
          required: ["id"],
          properties: { id: { type: "string", format: "uuid" } },
        },
      } as FastifySchema,
    },
    (request, reply) => badgeController.adminDelete(request, reply),
  );
}
