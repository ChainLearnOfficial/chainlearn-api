import type { FastifyInstance, FastifySchema } from "fastify";
import { courseController } from "./course.controller.js";
import { authGuard, optionalAuth } from "../../middleware/auth.js";
import { validate } from "../../middleware/validation.js";
import { listCoursesSchema, courseIdParamsSchema } from "./course.types.js";

export async function courseRoutes(app: FastifyInstance): Promise<void> {
  app.get<{ Querystring: import("./course.types.js").ListCoursesQuery }>(
    "/",
    {
      preHandler: [optionalAuth, validate({ querystring: listCoursesSchema })],
      schema: {
        description: "List available courses",
        tags: ["courses"],
        querystring: {
          type: "object",
          properties: {
            difficulty: { type: "string", enum: ["beginner", "intermediate", "advanced"] },
            search: { type: "string" },
            page: { type: "integer", minimum: 1, default: 1 },
            limit: { type: "integer", minimum: 1, maximum: 50, default: 20 },
          },
        },
      } as FastifySchema,
    },
    (request, reply) => courseController.list(request, reply)
  );

  app.get<{ Params: { id: string } }>(
    "/:id",
    {
      preHandler: [optionalAuth, validate({ params: courseIdParamsSchema })],
      schema: {
        description: "Get course details by ID",
        tags: ["courses"],
        params: { type: "object", required: ["id"], properties: { id: { type: "string", format: "uuid" } } },
      } as FastifySchema,
    },
    (request, reply) => courseController.getById(request, reply)
  );

  app.post<{ Params: { id: string } }>(
    "/:id/enroll",
    {
      preHandler: [authGuard, validate({ params: courseIdParamsSchema })],
      schema: {
        description: "Enroll in a course",
        tags: ["courses"],
        security: [{ bearerAuth: [] }],
        params: { type: "object", required: ["id"], properties: { id: { type: "string", format: "uuid" } } },
      } as FastifySchema,
    },
    (request, reply) => courseController.enroll(request, reply)
  );
}
