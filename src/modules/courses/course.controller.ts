import type { FastifyRequest, FastifyReply } from "fastify";
import { courseService } from "./course.service.js";
import type { AuthenticatedRequest } from "../../middleware/auth.js";
import type {
  ListCoursesQuery,
  CourseIdParams,
  PopularCoursesQuery,
  ReportCourseBody,
  EnrollCourseQuery,
  ShareCodeParams,
  ListReviewsQuery,
  CreateReviewBody,
  ListEnrolledUsersQuery,
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
   * GET /api/courses/:id/modules
   * List module metadata for a course.
   */
  async modulesPublic(
    request: FastifyRequest<{ Params: CourseIdParams }>,
    reply: FastifyReply
  ): Promise<void> {
    const { id } = request.params;
    const userId = (request as AuthenticatedRequest).authUser?.id ?? null;
    const course = await courseService.getCourseDetail(id, userId);

    reply.send({ success: true, data: course.modules });
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
    const { contentHashMismatch } = await courseService.enroll(authUser.id, id);

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
   * GET /api/v1/courses/:id/leaderboard
   * Top performers for a course, ranked by average quiz score (#324, #311).
   * Restored here — course.service.ts's getLeaderboard was left intact but
   * this passthrough was collateral damage of an unrelated upstream merge
   * (#440) that stripped several CourseController methods.
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
   * DELETE /api/v1/courses/:id/enroll
   * Drop the caller's enrollment in a course (#310).
   */
  async dropEnrollment(
    request: FastifyRequest<{ Params: CourseIdParams }>,
    reply: FastifyReply
  ): Promise<void> {
    const { id } = request.params;
    const { authUser } = request as AuthenticatedRequest;
    await courseService.dropEnrollment(authUser.id, id);

    reply.send({ success: true, message: "Enrollment dropped" });
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
   * POST /api/v1/courses/:id/report
   * Report a course for inappropriate content, errors, or other issues.
   */
  async report(
    request: FastifyRequest<{ Params: CourseIdParams; Body: ReportCourseBody }>,
    reply: FastifyReply
  ): Promise<void> {
    const { id } = request.params;
    const { authUser } = request as AuthenticatedRequest;
    const report = await courseService.reportCourse(authUser.id, id, request.body);

    reply.status(201).send({ success: true, data: report });
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

  /**
   * GET /api/v1/courses/recommended
   * Get personalized course recommendations based on enrollment history (#328).
   */
  async recommended(
    request: FastifyRequest<{ Querystring: PopularCoursesQuery }>,
    reply: FastifyReply
  ): Promise<void> {
    const { authUser } = request as AuthenticatedRequest;
    const { limit } = request.query;
    const recommendations = await courseService.getRecommendedCourses(authUser.id, limit);

    reply.send({ success: true, data: recommendations });
  }

  /**
   * GET /api/v1/courses/:id/reviews
   * List a course's reviews (paginated), alongside its average rating.
   */
  async reviews(
    request: FastifyRequest<{ Params: CourseIdParams; Querystring: ListReviewsQuery }>,
    reply: FastifyReply
  ): Promise<void> {
    const { id } = request.params;
    const result = await courseService.getCourseReviews(id, request.query);

    reply.send({
      success: true,
      data: result.reviews,
      pagination: {
        page: request.query.page,
        limit: request.query.limit,
        total: result.total,
      },
      summary: {
        averageRating: result.averageRating,
        totalReviews: result.totalReviews,
      },
    });
  }

  /**
   * GET /api/v1/courses/:id/enrolled-users
   * Admin-only: paginated list of users enrolled in a course with their
   * progress (quiz count, average score, completion status) (#355).
   */
  async enrolledUsers(
    request: FastifyRequest<{
      Params: CourseIdParams;
      Querystring: ListEnrolledUsersQuery;
    }>,
    reply: FastifyReply
  ): Promise<void> {
    const { id } = request.params;
    const result = await courseService.getEnrolledUsers(id, request.query);

    reply.send({
      success: true,
      data: result.users,
      pagination: {
        page: request.query.page,
        limit: request.query.limit,
        total: result.total,
      },
    });
  }

  /**
   * POST /api/v1/courses/:id/reviews
   * Rate and review a completed course. One review per user per course —
   * a repeat submission updates the existing review.
   */
  async createReview(
    request: FastifyRequest<{ Params: CourseIdParams; Body: CreateReviewBody }>,
    reply: FastifyReply
  ): Promise<void> {
    const { id } = request.params;
    const { authUser } = request as AuthenticatedRequest;
    const review = await courseService.upsertReview(authUser.id, id, request.body);

    reply.status(201).send({ success: true, data: review });
  }

  /**
   * GET /api/v1/courses/:id/syllabus
   * Returns the full course syllabus with module descriptions, estimated
   * duration, and learning objectives (#373). Cached for 5 minutes.
   */
  async syllabus(
    request: FastifyRequest<{ Params: CourseIdParams }>,
    reply: FastifyReply
  ): Promise<void> {
    const { id } = request.params;
    const syllabus = await courseService.getSyllabus(id);

    reply.send({ success: true, data: syllabus });
  }

  /**
   * GET /api/v1/courses/:id/enrollment-status
   * Detailed enrollment status for the authenticated user in a specific
   * course (#381).
   */
  async enrollmentStatus(
    request: FastifyRequest<{ Params: CourseIdParams }>,
    reply: FastifyReply
  ): Promise<void> {
    const { id } = request.params;
    const { authUser } = request as AuthenticatedRequest;
    const status = await courseService.getEnrollmentStatus(authUser.id, id);

    reply.send({ success: true, data: status });
  }

  /**
   * GET /api/v1/courses/:id/progress
   * The user's detailed progress in a specific course (#385).
   */
  async progress(
    request: FastifyRequest<{ Params: CourseIdParams }>,
    reply: FastifyReply
  ): Promise<void> {
    const { id } = request.params;
    const { authUser } = request as AuthenticatedRequest;
    const progress = await courseService.getCourseProgress(authUser.id, id);

    reply.send({ success: true, data: progress });
  }

  /**
   * GET /api/v1/courses/:id/modules/:moduleId/quiz-attempts
   * All quiz attempts for a course module by the authenticated user (#393).
   */
  async quizAttempts(
    request: FastifyRequest<{ Params: { id: string; moduleId: string } }>,
    reply: FastifyReply
  ): Promise<void> {
    const { id, moduleId } = request.params;
    const { authUser } = request as AuthenticatedRequest;
    const result = await courseService.getQuizAttempts(
      authUser.id,
      id,
      moduleId,
    );

    reply.send({ success: true, data: result });
  }
}

export const courseController = new CourseController();
