import type { FastifyRequest, FastifyReply } from "fastify";
import { courseService } from "./course.service.js";
import type { AuthenticatedRequest } from "../../middleware/auth.js";
import type { ListCoursesQuery, CourseIdParams, RecommendationsQuery } from "./course.types.js";

export class CourseController {
  /**
   * GET /api/courses
   * List available courses with optional filters.
   */
  async list(
    request: FastifyRequest<{ Querystring: ListCoursesQuery }>,
    reply: FastifyReply
  ): Promise<void> {
    const query = request.query ?? (request.query as ListCoursesQuery);
    const userId = (request as AuthenticatedRequest).authUser?.id ?? null;
    const result = await courseService.listCourses(userId, query);

    reply.send({
      success: true,
      data: result.courses,
      pagination: {
        page: query.page,
        limit: query.limit,
        total: result.total,
      },
    });
  }

  /**
   * GET /api/courses/:id
   * Get full course details.
   */
  async getById(
    request: FastifyRequest<{ Params: CourseIdParams }>,
    reply: FastifyReply
  ): Promise<void> {
    const { id } = request.params;
    const userId = (request as AuthenticatedRequest).authUser?.id ?? null;
    const course = await courseService.getCourseDetail(id, userId);

    reply.send({ success: true, data: course });
  }

  /**
   * POST /api/courses/:id/enroll
   * Enroll the authenticated user in a course.
   */
  async enroll(
    request: FastifyRequest<{ Params: CourseIdParams }>,
    reply: FastifyReply
  ): Promise<void> {
    const { id } = request.params;
    const { authUser } = request as AuthenticatedRequest;
    await courseService.enroll(authUser.id, id);

    reply.status(201).send({
      success: true,
      message: "Enrolled successfully",
    });
  }

  /**
   * GET /api/courses/recommended
   * Return a personalised ranked list of courses for the authenticated user.
   * Requires auth — recommendations are user-specific.
   */
  async getRecommendations(
    request: FastifyRequest<{ Querystring: RecommendationsQuery }>,
    reply: FastifyReply
  ): Promise<void> {
    const { authUser } = request as AuthenticatedRequest;
    const { limit } = request.query;
    const result = await courseService.getRecommendedCourses(authUser.id, limit);

    reply.send({
      success: true,
      data: result.courses,
      meta: {
        inferredDifficulty: result.inferredDifficulty,
        count: result.courses.length,
      },
    });
  }
}

export const courseController = new CourseController();
