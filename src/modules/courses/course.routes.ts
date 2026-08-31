import type { FastifyInstance, FastifySchema } from "fastify";
import { courseController } from "./course.controller.js";
import { authGuard, optionalAuth } from "../../middleware/auth.js";
import { validate } from "../../middleware/validation.js";
import {
  listCoursesSchema,
  courseIdParamsSchema,
  popularCoursesQuerySchema,
  enrollCourseQuerySchema,
  shareCodeParamsSchema,
  listReviewsQuerySchema,
  createReviewSchema,
} from "./course.types.js";

export async function courseRoutes(app: FastifyInstance): Promise<void> {
  app.get(
    "/stats",
    {
      schema: {
        description: "Get aggregate course statistics",
        tags: ["courses"],
      } as FastifySchema,
    },
    (request, reply) => courseController.stats(request, reply)
  );

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

  app.get<{ Querystring: import("./course.types.js").PopularCoursesQuery }>(
    "/popular",
    {
      preHandler: [validate({ querystring: popularCoursesQuerySchema })],
      schema: {
        description: "List the most popular active courses by enrollment count",
        tags: ["courses"],
        querystring: {
          type: "object",
          properties: {
            limit: { type: "integer", minimum: 1, maximum: 50, default: 10 },
          },
        },
      } as FastifySchema,
    },
    (request, reply) => courseController.popular(request, reply)
  );

  app.get<{ Querystring: import("./course.types.js").PopularCoursesQuery }>(
    "/recommended",
    {
      preHandler: [authGuard, validate({ querystring: popularCoursesQuerySchema })],
      schema: {
        description:
          "Get personalized course recommendations based on enrollment history and interests (#328)",
        tags: ["courses"],
        security: [{ bearerAuth: [] }],
        querystring: {
          type: "object",
          properties: {
            limit: { type: "integer", minimum: 1, maximum: 50, default: 10 },
          },
        },
      } as FastifySchema,
    },
    (request, reply) => courseController.recommended(request, reply)
  );

  app.get<{ Params: { code: string } }>(
    "/shared/:code",
    {
      preHandler: [optionalAuth, validate({ params: shareCodeParamsSchema })],
      schema: {
        description:
          "Resolve a course referral link, counting the click (#325)",
        tags: ["courses"],
        params: {
          type: "object",
          required: ["code"],
          properties: { code: { type: "string" } },
        },
      } as FastifySchema,
    },
    (request, reply) => courseController.resolveShare(request, reply)
  );

  app.get<{ Params: { id: string } }>(
    "/:id/leaderboard",
    {
      preHandler: [validate({ params: courseIdParamsSchema })],
      schema: {
        description:
          "Per-course leaderboard: top 20 learners by average quiz score",
        tags: ["courses"],
        params: { type: "object", required: ["id"], properties: { id: { type: "string", format: "uuid" } } },
      } as FastifySchema,
    },
    (request, reply) => courseController.leaderboard(request, reply)
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

  app.get<{ Params: { id: string } }>(
    "/:id/modules",
    {
      preHandler: [authGuard, validate({ params: courseIdParamsSchema })],
      schema: {
        description: "List a course's modules with the caller's per-module completion status",
        tags: ["courses"],
        security: [{ bearerAuth: [] }],
        params: { type: "object", required: ["id"], properties: { id: { type: "string", format: "uuid" } } },
      } as FastifySchema,
    },
    (request, reply) => courseController.modules(request, reply)
  );

  app.post<{ Params: { id: string }; Querystring: import("./course.types.js").EnrollCourseQuery }>(
    "/:id/enroll",
    {
      preHandler: [
        authGuard,
        validate({
          params: courseIdParamsSchema,
          querystring: enrollCourseQuerySchema,
        }),
      ],
      schema: {
        description: "Enroll in a course (optionally via a referral link)",
        tags: ["courses"],
        security: [{ bearerAuth: [] }],
        params: { type: "object", required: ["id"], properties: { id: { type: "string", format: "uuid" } } },
        querystring: {
          type: "object",
          properties: { ref: { type: "string" } },
        },
      } as FastifySchema,
    },
    (request, reply) => courseController.enroll(request, reply)
  );

  app.get<{ Params: { id: string }; Querystring: import("./course.types.js").ListReviewsQuery }>(
    "/:id/reviews",
    {
      preHandler: [
        validate({ params: courseIdParamsSchema, querystring: listReviewsQuerySchema }),
      ],
      schema: {
        description: "List a course's reviews (paginated), with average rating",
        tags: ["courses"],
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
    (request, reply) => courseController.reviews(request, reply)
  );

  app.post<{ Params: { id: string }; Body: import("./course.types.js").CreateReviewBody }>(
    "/:id/reviews",
    {
      preHandler: [
        authGuard,
        validate({ params: courseIdParamsSchema, body: createReviewSchema }),
      ],
      schema: {
        description:
          "Rate and review a completed course (one review per user per course, updatable)",
        tags: ["courses"],
        security: [{ bearerAuth: [] }],
        params: { type: "object", required: ["id"], properties: { id: { type: "string", format: "uuid" } } },
        body: {
          type: "object",
          required: ["rating"],
          properties: {
            rating: { type: "integer", minimum: 1, maximum: 5 },
            reviewText: { type: "string", maxLength: 2000 },
          },
        },
      } as FastifySchema,
    },
    (request, reply) => courseController.createReview(request, reply)
  );

  app.post<{ Params: { id: string } }>(
    "/:id/share",
    {
      preHandler: [authGuard, validate({ params: courseIdParamsSchema })],
      schema: {
        description:
          "Generate a shareable referral link (with QR code) for a course (#325)",
        tags: ["courses"],
        security: [{ bearerAuth: [] }],
        params: { type: "object", required: ["id"], properties: { id: { type: "string", format: "uuid" } } },
      } as FastifySchema,
    },
    (request, reply) => courseController.share(request, reply)
  );
}
