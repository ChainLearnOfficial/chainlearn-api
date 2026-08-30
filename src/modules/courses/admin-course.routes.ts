import type { FastifyInstance, FastifySchema } from "fastify";
import { adminCourseController } from "./admin-course.controller.js";
import { authGuard, adminGuard } from "../../middleware/auth.js";
import { validate } from "../../middleware/validation.js";
import {
  createCourseSchema,
  updateCourseSchema,
  courseIdParamsSchema,
} from "./course.types.js";

/** Admin-only course management (#292). Every route requires an admin user. */
export async function adminCourseRoutes(app: FastifyInstance): Promise<void> {
  app.addHook("onRequest", authGuard);
  app.addHook("preHandler", adminGuard);

  app.post<{ Body: import("./course.types.js").CreateCourseBody }>(
    "/",
    {
      preHandler: [validate({ body: createCourseSchema })],
      schema: {
        description: "Create a course (admin only)",
        tags: ["admin", "courses"],
        security: [{ bearerAuth: [] }],
        body: {
          type: "object",
          required: ["title", "description"],
          properties: {
            title: { type: "string", minLength: 1, maxLength: 255 },
            description: { type: "string", minLength: 1 },
            difficulty: {
              type: "string",
              enum: ["beginner", "intermediate", "advanced"],
            },
            tags: {
              type: "array",
              items: { type: "string", minLength: 1, maxLength: 50 },
              maxItems: 20,
            },
            courseModules: {
              type: "array",
              maxItems: 100,
              items: {
                type: "object",
                required: ["id", "title"],
                properties: {
                  id: { type: "string", minLength: 1, maxLength: 100 },
                  title: { type: "string", minLength: 1, maxLength: 255 },
                  description: { type: "string", maxLength: 1000 },
                  estimatedDurationMinutes: {
                    type: "integer",
                    minimum: 1,
                    maximum: 1440,
                  },
                },
              },
            },
            contentHash: { type: "string", maxLength: 64 },
          },
        },
      } as FastifySchema,
    },
    (request, reply) => adminCourseController.create(request, reply)
  );

  app.put<{
    Params: { id: string };
    Body: import("./course.types.js").UpdateCourseBody;
  }>(
    "/:id",
    {
      preHandler: [
        validate({ params: courseIdParamsSchema, body: updateCourseSchema }),
      ],
      schema: {
        description: "Update a course (admin only)",
        tags: ["admin", "courses"],
        security: [{ bearerAuth: [] }],
        params: { type: "object", required: ["id"], properties: { id: { type: "string", format: "uuid" } } },
        body: {
          type: "object",
          properties: {
            title: { type: "string", minLength: 1, maxLength: 255 },
            description: { type: "string", minLength: 1 },
            difficulty: {
              type: "string",
              enum: ["beginner", "intermediate", "advanced"],
            },
            tags: {
              type: "array",
              items: { type: "string", minLength: 1, maxLength: 50 },
              maxItems: 20,
            },
            courseModules: {
              type: "array",
              maxItems: 100,
              items: {
                type: "object",
                required: ["id", "title"],
                properties: {
                  id: { type: "string", minLength: 1, maxLength: 100 },
                  title: { type: "string", minLength: 1, maxLength: 255 },
                  description: { type: "string", maxLength: 1000 },
                  estimatedDurationMinutes: {
                    type: "integer",
                    minimum: 1,
                    maximum: 1440,
                  },
                },
              },
            },
            contentHash: { type: "string", maxLength: 64 },
            isActive: { type: "boolean" },
          },
        },
      } as FastifySchema,
    },
    (request, reply) => adminCourseController.update(request, reply)
  );

  app.delete<{ Params: { id: string } }>(
    "/:id",
    {
      preHandler: [validate({ params: courseIdParamsSchema })],
      schema: {
        description: "Soft-delete a course (admin only)",
        tags: ["admin", "courses"],
        security: [{ bearerAuth: [] }],
        params: { type: "object", required: ["id"], properties: { id: { type: "string", format: "uuid" } } },
      } as FastifySchema,
    },
    (request, reply) => adminCourseController.remove(request, reply)
  );
}
