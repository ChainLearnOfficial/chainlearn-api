import type { FastifyInstance, FastifySchema } from "fastify";
import { announcementController } from "./announcement.controller.js";
import { authGuard, adminGuard } from "../../middleware/auth.js";
import { validate } from "../../middleware/validation.js";
import {
  createAnnouncementSchema,
  updateAnnouncementSchema,
  announcementIdParamsSchema,
  listAnnouncementsAdminQuerySchema,
} from "./announcement.types.js";

/** Admin-only announcement management (#353). Every route requires an admin user. */
export async function adminAnnouncementRoutes(app: FastifyInstance): Promise<void> {
  app.addHook("onRequest", authGuard);
  app.addHook("preHandler", adminGuard);

  app.get<{ Querystring: import("./announcement.types.js").ListAnnouncementsAdminQuery }>(
    "/",
    {
      preHandler: [validate({ querystring: listAnnouncementsAdminQuerySchema })],
      schema: {
        description: "List every announcement, paginated (admin only)",
        tags: ["admin", "announcements"],
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
    (request, reply) => announcementController.listAll(request, reply)
  );

  app.post<{ Body: import("./announcement.types.js").CreateAnnouncementBody }>(
    "/",
    {
      preHandler: [validate({ body: createAnnouncementSchema })],
      schema: {
        description: "Create a platform-wide announcement (admin only)",
        tags: ["admin", "announcements"],
        security: [{ bearerAuth: [] }],
        body: {
          type: "object",
          required: ["title", "message"],
          properties: {
            title: { type: "string", minLength: 1, maxLength: 255 },
            message: { type: "string", minLength: 1 },
            priority: { type: "string", enum: ["normal", "high", "urgent"] },
            active: { type: "boolean" },
            expiresAt: { type: "string", format: "date-time" },
          },
        },
      } as FastifySchema,
    },
    (request, reply) => announcementController.create(request, reply)
  );

  app.put<{
    Params: { id: string };
    Body: import("./announcement.types.js").UpdateAnnouncementBody;
  }>(
    "/:id",
    {
      preHandler: [
        validate({ params: announcementIdParamsSchema, body: updateAnnouncementSchema }),
      ],
      schema: {
        description: "Update an announcement (admin only)",
        tags: ["admin", "announcements"],
        security: [{ bearerAuth: [] }],
        params: { type: "object", required: ["id"], properties: { id: { type: "string", format: "uuid" } } },
        body: {
          type: "object",
          properties: {
            title: { type: "string", minLength: 1, maxLength: 255 },
            message: { type: "string", minLength: 1 },
            priority: { type: "string", enum: ["normal", "high", "urgent"] },
            active: { type: "boolean" },
            expiresAt: { type: "string", format: "date-time", nullable: true },
          },
        },
      } as FastifySchema,
    },
    (request, reply) => announcementController.update(request, reply)
  );

  app.delete<{ Params: { id: string } }>(
    "/:id",
    {
      preHandler: [validate({ params: announcementIdParamsSchema })],
      schema: {
        description: "Delete an announcement (admin only)",
        tags: ["admin", "announcements"],
        security: [{ bearerAuth: [] }],
        params: { type: "object", required: ["id"], properties: { id: { type: "string", format: "uuid" } } },
      } as FastifySchema,
    },
    (request, reply) => announcementController.remove(request, reply)
  );
}
