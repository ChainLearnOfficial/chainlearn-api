import type { FastifyInstance } from "fastify";
import { courseController } from "./course.controller.js";
import { authGuard, optionalAuth } from "../../middleware/auth.js";
import { validate } from "../../middleware/validation.js";
import { listCoursesSchema, courseIdParamsSchema } from "./course.types.js";

export async function courseRoutes(app: FastifyInstance): Promise<void> {
  // Public listing — auth optional (to show enrollment status)
  app.get(
    "/",
    {
      preHandler: [optionalAuth, validate({ querystring: listCoursesSchema })],
      schema: {
        description: "List available courses",
        tags: ["courses"],
      },
    },
    courseController.list.bind(courseController)
  );

  // Public detail — auth optional
  app.get(
    "/:id",
    {
      preHandler: [optionalAuth, validate({ params: courseIdParamsSchema })],
      schema: {
        description: "Get course details by ID",
        tags: ["courses"],
      },
    },
    courseController.getById.bind(courseController)
  );

  // Enrollment requires authentication
  app.post(
    "/:id/enroll",
    {
      preHandler: [authGuard, validate({ params: courseIdParamsSchema })],
      schema: {
        description: "Enroll in a course",
        tags: ["courses"],
      },
    },
    courseController.enroll.bind(courseController)
  );
}
