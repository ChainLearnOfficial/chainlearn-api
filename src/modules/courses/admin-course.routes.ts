import type { FastifyInstance, FastifySchema } from "fastify";
import { adminCourseController } from "./admin-course.controller.js";
import { authGuard, adminGuard } from "../../middleware/auth.js";
import { validate } from "../../middleware/validation.js";
import {
  createCourseSchema,
  updateCourseSchema,
  courseIdParamsSchema,
  createModuleSchema,
  updateModuleSchema,
  moduleParamsSchema,
  listEnrolledUsersQuerySchema,
  enrollmentTrendsQuerySchema,
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

  app.post(
    "/import",
    {
      schema: {
        description:
          "Bulk-create a course (and its modules) from an uploaded JSON file — multipart/form-data with a single file part (admin only) (#366)",
        tags: ["admin", "courses"],
        security: [{ bearerAuth: [] }],
        consumes: ["multipart/form-data"],
      } as FastifySchema,
    },
    (request, reply) => adminCourseController.import(request, reply)
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

  app.post<{ Params: { id: string } }>(
    "/:id/archive",
    {
      preHandler: [validate({ params: courseIdParamsSchema })],
      schema: {
        description:
          "Archive a course: hides it from public listings while preserving data and enrolled users' access (admin only)",
        tags: ["admin", "courses"],
        security: [{ bearerAuth: [] }],
        params: { type: "object", required: ["id"], properties: { id: { type: "string", format: "uuid" } } },
      } as FastifySchema,
    },
    (request, reply) => adminCourseController.archive(request, reply)
  );

  app.post<{ Params: { id: string } }>(
    "/:id/publish",
    {
      preHandler: [validate({ params: courseIdParamsSchema })],
      schema: {
        description:
          "Publish a course after validating required content (title, description, difficulty, modules, and a quiz per module) is present (admin only)",
        tags: ["admin", "courses"],
        security: [{ bearerAuth: [] }],
        params: { type: "object", required: ["id"], properties: { id: { type: "string", format: "uuid" } } },
      } as FastifySchema,
    },
    (request, reply) => adminCourseController.publish(request, reply)
  );

  app.post<{ Params: { id: string } }>(
    "/:id/duplicate",
    {
      preHandler: [validate({ params: courseIdParamsSchema })],
      schema: {
        description:
          "Duplicate a course, its modules, and quizzes into a new draft course (admin only)",
        tags: ["admin", "courses"],
        security: [{ bearerAuth: [] }],
        params: { type: "object", required: ["id"], properties: { id: { type: "string", format: "uuid" } } },
      } as FastifySchema,
    },
    (request, reply) => adminCourseController.duplicate(request, reply)
  );

  app.post<{
    Params: { id: string };
    Body: import("./course.types.js").CreateModuleBody;
  }>(
    "/:id/modules",
    {
      preHandler: [
        validate({ params: courseIdParamsSchema, body: createModuleSchema }),
      ],
      schema: {
        description: "Create a course module definition (admin only)",
        tags: ["admin", "courses"],
        security: [{ bearerAuth: [] }],
        params: { type: "object", required: ["id"], properties: { id: { type: "string", format: "uuid" } } },
        body: {
          type: "object",
          required: ["title"],
          properties: {
            title: { type: "string", minLength: 1, maxLength: 255 },
            description: { type: "string", maxLength: 2000 },
            order: { type: "integer", minimum: 0 },
          },
        },
      } as FastifySchema,
    },
    (request, reply) => adminCourseController.createModule(request, reply)
  );

  app.put<{
    Params: { id: string; moduleId: string };
    Body: import("./course.types.js").UpdateModuleBody;
  }>(
    "/:id/modules/:moduleId",
    {
      preHandler: [
        validate({ params: moduleParamsSchema, body: updateModuleSchema }),
      ],
      schema: {
        description: "Update a course module definition (admin only)",
        tags: ["admin", "courses"],
        security: [{ bearerAuth: [] }],
        params: {
          type: "object",
          required: ["id", "moduleId"],
          properties: {
            id: { type: "string", format: "uuid" },
            moduleId: { type: "string", minLength: 1, maxLength: 100 },
          },
        },
        body: {
          type: "object",
          properties: {
            title: { type: "string", minLength: 1, maxLength: 255 },
            description: { type: "string", maxLength: 2000 },
            order: { type: "integer", minimum: 0 },
          },
        },
      } as FastifySchema,
    },
    (request, reply) => adminCourseController.updateModule(request, reply)
  );

  app.delete<{ Params: { id: string; moduleId: string } }>(
    "/:id/modules/:moduleId",
    {
      preHandler: [validate({ params: moduleParamsSchema })],
      schema: {
        description: "Delete a course module definition and its quizzes (admin only)",
        tags: ["admin", "courses"],
        security: [{ bearerAuth: [] }],
        params: {
          type: "object",
          required: ["id", "moduleId"],
          properties: {
            id: { type: "string", format: "uuid" },
            moduleId: { type: "string", minLength: 1, maxLength: 100 },
          },
        },
      } as FastifySchema,
    },
    (request, reply) => adminCourseController.removeModule(request, reply)
  );

  app.get<{ Params: { id: string } }>(
    "/:id/analytics",
    {
      preHandler: [validate({ params: courseIdParamsSchema })],
      schema: {
        description:
          "Detailed course analytics: enrollment trends (daily/weekly), completion rate, average time-to-complete, average quiz score, and modules with the lowest average score (admin only, cached 1 hour)",
        tags: ["admin", "courses"],
        security: [{ bearerAuth: [] }],
        params: { type: "object", required: ["id"], properties: { id: { type: "string", format: "uuid" } } },
      } as FastifySchema,
    },
    (request, reply) => adminCourseController.analytics(request, reply)
  );

  app.get<{
    Params: { id: string };
    Querystring: import("./course.types.js").ListEnrolledUsersQuery;
  }>(
    "/:id/enrolled-users",
    {
      preHandler: [
        validate({
          params: courseIdParamsSchema,
          querystring: listEnrolledUsersQuerySchema,
        }),
      ],
      schema: {
        description:
          "List a course's enrolled users (paginated) with their quiz progress (admin only)",
        tags: ["admin", "courses"],
        security: [{ bearerAuth: [] }],
        params: { type: "object", required: ["id"], properties: { id: { type: "string", format: "uuid" } } },
        querystring: {
          type: "object",
          properties: {
            page: { type: "integer", minimum: 1, default: 1 },
            limit: { type: "integer", minimum: 1, maximum: 50, default: 20 },
          },
        },
      } as FastifySchema,
    },
    (request, reply) => adminCourseController.listEnrolledUsers(request, reply)
  );

  app.get<{
    Params: { id: string };
    Querystring: import("./course.types.js").EnrollmentTrendsQuery;
  }>(
    "/:id/enrollment-trends",
    {
      preHandler: [
        validate({
          params: courseIdParamsSchema,
          querystring: enrollmentTrendsQuerySchema,
        }),
      ],
      schema: {
        description:
          "Enrollment trends for a course over time with configurable range (7d/30d/90d) and granularity (daily/weekly/monthly) (admin only, cached 1 hour, #391)",
        tags: ["admin", "courses"],
        security: [{ bearerAuth: [] }],
        params: { type: "object", required: ["id"], properties: { id: { type: "string", format: "uuid" } } },
        querystring: {
          type: "object",
          properties: {
            range: { type: "string", enum: ["7d", "30d", "90d"], default: "30d" },
            granularity: { type: "string", enum: ["daily", "weekly", "monthly"], default: "daily" },
          },
        },
      } as FastifySchema,
    },
    (request, reply) => adminCourseController.enrollmentTrends(request, reply)
  );
}
