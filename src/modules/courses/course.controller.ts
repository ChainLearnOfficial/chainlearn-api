import type { FastifyRequest, FastifyReply } from "fastify";
import { courseService } from "./course.service.js";
import type { AuthenticatedRequest } from "../../middleware/auth.js";
import type {
  ListCoursesQuery,
  CourseIdParams,
  PopularCoursesQuery,
  EnrollCourseQuery,
  ShareCodeParams,
} from "./course.types.js";

export class CourseController {
  /**
   * GET /api/courses/stats
   * Return aggregate active course statistics.
   */
  async stats(
    _request: FastifyRequest,
    reply: FastifyReply
  ): Promise<void> {
    const stats = await courseService.getStats();

    reply.send({ success: true, data: stats });
  }

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
    request: FastifyRequest<{ Params: CourseIdParams; Querystring: EnrollCourseQuery }>,
    reply: FastifyReply
  ): Promise<void> {
    const { id } = request.params;
    const { authUser } = request as AuthenticatedRequest;
    const { contentHashMismatch } = await courseService.enroll(
      authUser.id,
      id,
      request.query?.ref,
    );

    if (contentHashMismatch) {
      reply.header(
        "X-Content-Warning",
        "Course content hash does not match the on-chain version",
      );
    }

    reply.status(201).send({
      success: true,
      message: "Enrolled successfully",
    });
  }

  /**
   * POST /api/v1/courses/:id/share
   * Get (or create) the caller's referral link for a course (#325).
   */
  async share(
    request: FastifyRequest<{ Params: CourseIdParams }>,
    reply: FastifyReply
  ): Promise<void> {
    const { id } = request.params;
    const { authUser } = request as AuthenticatedRequest;
    const link = await courseService.createShareLink(authUser.id, id);

    reply.status(201).send({ success: true, data: link });
  }

  /**
   * GET /api/v1/courses/shared/:code
   * Resolve a referral link to its course, counting the click (#325).
   */
  async resolveShare(
    request: FastifyRequest<{ Params: ShareCodeParams }>,
    reply: FastifyReply
  ): Promise<void> {
    const { code } = request.params;
    const viewerId = (request as AuthenticatedRequest).authUser?.id ?? null;
    const resolved = await courseService.resolveShareLink(code, viewerId);

    reply.send({ success: true, data: resolved });
  }

  /**
   * GET /api/courses/:id/modules
   * List a course's modules with the authenticated (enrolled) user's
   * per-module completion status (#286).
   */
  async modules(
    request: FastifyRequest<{ Params: CourseIdParams }>,
    reply: FastifyReply
  ): Promise<void> {
    const { id } = request.params;
    const { authUser } = request as AuthenticatedRequest;
    const modules = await courseService.getCourseModules(authUser.id, id);

    reply.send({ success: true, data: modules });
  }

  /**
   * GET /api/v1/courses/:id/leaderboard
   * Top performers for a course, ranked by average quiz score (#324).
   */
  async leaderboard(
    request: FastifyRequest<{ Params: CourseIdParams }>,
    reply: FastifyReply
  ): Promise<void> {
    const { id } = request.params;
    const leaderboard = await courseService.getLeaderboard(id);

    reply.send({ success: true, data: leaderboard });
  }

  /**
   * GET /api/courses/popular
   * List active courses ordered by enrollment count descending.
   */
  async popular(
    request: FastifyRequest<{ Querystring: PopularCoursesQuery }>,
    reply: FastifyReply
  ): Promise<void> {
    const { limit } = request.query;
    const courses = await courseService.getPopularCourses(limit);

    reply.send({ success: true, data: courses });
  }
}

export const courseController = new CourseController();
