import type { FastifyInstance, FastifySchema } from "fastify";
import { courseController } from "./course.controller.js";
import { authGuard, optionalAuth } from "../../middleware/auth.js";
import { validate } from "../../middleware/validation.js";
import {
  listCoursesSchema,
  courseIdParamsSchema,
  recommendationsQuerySchema,
} from "./course.types.js";

export async function courseRoutes(app: FastifyInstance): Promise<void> {
  app.get<{ Querystring: import("./course.types.js").ListCoursesQuery }>(
    "/",
    {
      preHandler: [optionalAuth, validate({ querystring: listCoursesSchema })],
      schema: {
        description: "List available courses",
        tags: ["courses"],
      } as FastifySchema,
    },
    (request, reply) => courseController.list(request, reply)
  );

  // Must be registered before /:id so the literal segment "recommended" is
  // not swallowed by the UUID param pattern.
  app.get<{ Querystring: import("./course.types.js").RecommendationsQuery }>(
    "/recommended",
    {
      preHandler: [
        authGuard,
        validate({ querystring: recommendationsQuerySchema }),
      ],
      schema: {
        description:
          "Get personalised course recommendations for the authenticated user",
        tags: ["courses"],
      } as FastifySchema,
    },
    (request, reply) => courseController.getRecommendations(request, reply)
  );

  app.get<{ Params: { id: string } }>(
    "/:id",
    {
      preHandler: [optionalAuth, validate({ params: courseIdParamsSchema })],
      schema: {
        description: "Get course details by ID",
        tags: ["courses"],
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
      } as FastifySchema,
    },
    (request, reply) => courseController.enroll(request, reply)
  );
}
