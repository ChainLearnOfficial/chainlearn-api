import type { FastifyInstance, FastifySchema } from "fastify";
import { userController } from "./user.controller.js";
import { authGuard } from "../../middleware/auth.js";
import { validate } from "../../middleware/validation.js";
import { activityQuerySchema, updateProfileSchema } from "./user.types.js";
import { config } from "../../config/index.js";
import { notificationController } from "../notifications/notification.controller.js";
import {
  listNotificationsQuerySchema,
  notificationIdParamsSchema,
} from "../notifications/notification.types.js";

export async function userRoutes(app: FastifyInstance): Promise<void> {
  app.addHook("onRequest", authGuard);

  app.get(
    "/me",
    {
      schema: {
        description: "Get authenticated user profile",
        tags: ["users"],
        security: [{ bearerAuth: [] }],
      } as FastifySchema,
    },
    (request, reply) => userController.getMe(request, reply)
  );

  app.put<{ Body: import("./user.types.js").UpdateProfileBody }>(
    "/me",
    {
      preHandler: [validate({ body: updateProfileSchema })],
      schema: {
        description: "Update authenticated user profile",
        tags: ["users"],
        security: [{ bearerAuth: [] }],
        body: {
          type: "object",
          properties: {
            displayName: { type: "string", minLength: 1, maxLength: 100 },
            background: { type: "string", maxLength: 1000 },
            learningGoal: { type: "string", maxLength: 500 },
            pace: { type: "string", enum: ["slow", "medium", "fast"] },
            language: { type: "string", maxLength: 10 },
          },
        },
      } as FastifySchema,
    },
    (request, reply) => userController.updateMe(request, reply)
  );

  app.get<{ Querystring: import("./user.types.js").ActivityQuery }>(
    "/me/activity",
    {
      preHandler: [validate({ querystring: activityQuerySchema })],
      schema: {
        description: "Get recent authenticated user activity",
        tags: ["users"],
        security: [{ bearerAuth: [] }],
        querystring: {
          type: "object",
          properties: {
            cursor: { type: "string", format: "date-time" },
            limit: { type: "integer", minimum: 1, maximum: 50, default: 20 },
          },
        },
      } as FastifySchema,
    },
    (request, reply) => userController.getActivity(request, reply)
  );

  app.put(
    "/me/avatar",
    {
      config: { fileSizeLimit: config.AVATAR_UPLOAD_MAX_BYTES },
      schema: {
        description: "Upload authenticated user avatar",
        tags: ["users"],
        security: [{ bearerAuth: [] }],
        consumes: ["multipart/form-data"],
      } as FastifySchema,
    },
    (request, reply) => userController.updateAvatar(request, reply)
  );

  app.get(
    "/me/progress",
    {
      schema: {
        description: "Get learning progress stats",
        tags: ["users"],
        security: [{ bearerAuth: [] }],
      } as FastifySchema,
    },
    (request, reply) => userController.getProgress(request, reply)
  );

  app.get(
    "/me/learning-path",
    {
      schema: {
        description: "Get personalized learning path recommendations",
        tags: ["users"],
        security: [{ bearerAuth: [] }],
      } as FastifySchema,
    },
    (request, reply) => userController.getLearningPath(request, reply)
  );

  app.get<{ Querystring: import("../notifications/notification.types.js").ListNotificationsQuery }>(
    "/me/notifications",
    {
      preHandler: [validate({ querystring: listNotificationsQuerySchema })],
      schema: {
        description: "Get the authenticated user's notifications with unread count",
        tags: ["users", "notifications"],
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
    (request, reply) => notificationController.list(request, reply)
  );

  app.put<{ Params: { id: string } }>(
    "/me/notifications/:id/read",
    {
      preHandler: [validate({ params: notificationIdParamsSchema })],
      schema: {
        description: "Mark a notification as read",
        tags: ["users", "notifications"],
        security: [{ bearerAuth: [] }],
        params: { type: "object", required: ["id"], properties: { id: { type: "string", format: "uuid" } } },
      } as FastifySchema,
    },
    (request, reply) => notificationController.markRead(request, reply)
  );

  app.get(
    "/me/export",
    {
      schema: {
        description:
          "Export all of the authenticated user's data (profile, enrollments, quiz submissions, credentials, reward claims) as a downloadable JSON file — GDPR data portability.",
        tags: ["users"],
        security: [{ bearerAuth: [] }],
      } as FastifySchema,
    },
    (request, reply) => userController.exportData(request, reply)
  );

  app.delete(
    "/me",
    {
      schema: {
        description:
          "Delete (soft-delete) the authenticated user's account. Enrollments and credentials are preserved.",
        tags: ["users"],
        security: [{ bearerAuth: [] }],
        response: { 204: { type: "null" } },
      } as FastifySchema,
    },
    (request, reply) => userController.deleteMe(request, reply)
  );
}
