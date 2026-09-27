import type { FastifyRequest, FastifyReply } from "fastify";
import { courseService } from "./course.service.js";
import { ValidationError } from "../../utils/errors.js";
import { importCourseSchema } from "./course.types.js";
import type {
  CourseIdParams,
  CreateCourseBody,
  UpdateCourseBody,
  DraftCourseBody,
  CreateModuleBody,
  UpdateModuleBody,
  ModuleParams,
  ListEnrolledUsersQuery,
  EnrollmentTrendsQuery,
  ReorderModulesBody,
  CloneCourseBody,
  ContentParams,
  CreateContentBody,
  UpdateContentBody,
  ReorderContentBody,
} from "./course.types.js";

export class AdminCourseController {
  /**
   * POST /api/admin/courses
   * Create a new course.
   */
  async create(
    request: FastifyRequest<{ Body: CreateCourseBody }>,
    reply: FastifyReply
  ): Promise<void> {
    const course = await courseService.createCourse(request.body);

    reply.status(201).send({ success: true, data: course });
  }

  /**
   * POST /api/v1/admin/courses/import
   * Bulk-create a course (and its modules) from an uploaded JSON file (#366).
   */
  async import(
    request: FastifyRequest,
    reply: FastifyReply
  ): Promise<void> {
    if (!request.isMultipart()) {
      throw new ValidationError({
        file: ["Request must be multipart/form-data"],
      });
    }

    const file = await request.file();
    if (!file) {
      throw new ValidationError({
        file: ["A JSON file is required"],
      });
    }

    const buffer = await file.toBuffer();
    let parsed: unknown;
    try {
      parsed = JSON.parse(buffer.toString("utf-8"));
    } catch {
      throw new ValidationError({
        file: ["File must contain valid JSON"],
      });
    }

    const result = importCourseSchema.safeParse(parsed);
    if (!result.success) {
      throw new ValidationError({
        file: result.error.issues.map(
          (issue) => `${issue.path.join(".")}: ${issue.message}`,
        ),
      });
    }

    const imported = await courseService.importCourse(result.data);

    reply.status(201).send({ success: true, data: imported });
  }

  /**
   * PUT /api/admin/courses/:id
   * Update an existing course.
   */
  async update(
    request: FastifyRequest<{ Params: CourseIdParams; Body: UpdateCourseBody }>,
    reply: FastifyReply
  ): Promise<void> {
    const { id } = request.params;
    const course = await courseService.updateCourse(id, request.body);

    reply.send({ success: true, data: course });
  }

  /**
   * DELETE /api/admin/courses/:id
   * Soft-delete a course (sets isActive = false).
   */
  async remove(
    request: FastifyRequest<{ Params: CourseIdParams }>,
    reply: FastifyReply
  ): Promise<void> {
    const { id } = request.params;
    await courseService.deleteCourse(id);

    reply.send({ success: true, message: "Course deactivated" });
  }

  /**
   * POST /api/admin/courses/:id/archive
   * Archive a course (sets isActive = false, archivedAt = now()). Distinct
   * from `remove`: archiving records when it happened so it can be told
   * apart from other reasons a course might be inactive (#358).
   */
  async archive(
    request: FastifyRequest<{ Params: CourseIdParams }>,
    reply: FastifyReply
  ): Promise<void> {
    const { id } = request.params;
    await courseService.archiveCourse(id);

    reply.send({ success: true, message: "Course archived" });
  }

  /**
   * POST /api/admin/courses/:id/publish
   * Validate required content is present, then publish (isActive = true).
   */
  async publish(
    request: FastifyRequest<{ Params: CourseIdParams }>,
    reply: FastifyReply
  ): Promise<void> {
    const { id } = request.params;
    const course = await courseService.publishCourse(id);

    reply.send({ success: true, data: course });
  }

  /**
   * POST /api/v1/admin/courses/:id/draft
   * Save course content as a draft without publishing it (#376).
   */
  async saveDraft(
    request: FastifyRequest<{ Params: CourseIdParams; Body: DraftCourseBody }>,
    reply: FastifyReply
  ): Promise<void> {
    const { id } = request.params;
    const course = await courseService.saveDraft(id, request.body);

    reply.send({ success: true, data: course });
  }

  /**
   * GET /api/v1/admin/courses/:id/engagement
   * Detailed engagement metrics for a course (#377).
   */
  async engagement(
    request: FastifyRequest<{ Params: CourseIdParams }>,
    reply: FastifyReply
  ): Promise<void> {
    const { id } = request.params;
    const engagement = await courseService.getCourseEngagement(id);

    reply.send({ success: true, data: engagement });
  }

  /**
   * POST /api/admin/courses/:id/duplicate
   * Duplicate a course (metadata, modules, quizzes) into a new draft course.
   */
  async duplicate(
    request: FastifyRequest<{ Params: CourseIdParams; Body?: CloneCourseBody }>,
    reply: FastifyReply
  ): Promise<void> {
    const { id } = request.params;
    const course = await courseService.cloneCourse(id, request.body?.title);

    reply.status(201).send({ success: true, data: course });
  }

  /**
   * POST /api/v1/admin/courses/:id/clone
   * Clone a course (metadata, modules, content, quizzes) into a new draft course (#378).
   */
  async clone(
    request: FastifyRequest<{ Params: CourseIdParams; Body?: CloneCourseBody }>,
    reply: FastifyReply
  ): Promise<void> {
    const { id } = request.params;
    const course = await courseService.cloneCourse(id, request.body?.title);

    reply.status(201).send({ success: true, data: course });
  }

  /**
   * POST /api/admin/courses/:id/modules
   * Create a module definition for a course.
   */
  async createModule(
    request: FastifyRequest<{ Params: CourseIdParams; Body: CreateModuleBody }>,
    reply: FastifyReply
  ): Promise<void> {
    const { id } = request.params;
    const module = await courseService.createModule(id, request.body);

    reply.status(201).send({ success: true, data: module });
  }

  /**
   * PUT /api/admin/courses/:id/modules/:moduleId
   * Update a module definition.
   */
  async updateModule(
    request: FastifyRequest<{ Params: ModuleParams; Body: UpdateModuleBody }>,
    reply: FastifyReply
  ): Promise<void> {
    const { id, moduleId } = request.params;
    const module = await courseService.updateModule(id, moduleId, request.body);

    reply.send({ success: true, data: module });
  }

  /**
   * DELETE /api/admin/courses/:id/modules/:moduleId
   * Delete a module definition and its associated quizzes.
   */
  async removeModule(
    request: FastifyRequest<{ Params: ModuleParams }>,
    reply: FastifyReply
  ): Promise<void> {
    const { id, moduleId } = request.params;
    await courseService.deleteModule(id, moduleId);

    reply.send({ success: true, message: "Module deleted" });
  }

  /**
   * GET /api/v1/admin/courses/:id/analytics
   * Detailed analytics: enrollment trends, completion rate, average quiz
   * score, average time-to-complete, and modules learners struggle with
   * most (cached 1 hour).
   */
  async analytics(
    request: FastifyRequest<{ Params: CourseIdParams }>,
    reply: FastifyReply
  ): Promise<void> {
    const { id } = request.params;
    const analytics = await courseService.getCourseAnalytics(id);

    reply.send({ success: true, data: analytics });
  }

  /**
   * GET /api/admin/courses/:id/enrolled-users
   * Paginated list of users enrolled in a course, with progress (#340).
   */
  async listEnrolledUsers(
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
   * GET /api/v1/admin/courses/:id/enrollment-trends
   * Enrollment trends for a course over time (#391).
   */
  async enrollmentTrends(
    request: FastifyRequest<{
      Params: CourseIdParams;
      Querystring: EnrollmentTrendsQuery;
    }>,
    reply: FastifyReply
  ): Promise<void> {
    const { id } = request.params;
    const result = await courseService.getEnrollmentTrends(id, request.query);

    reply.send({ success: true, data: result });
  }

  /**
   * POST /api/v1/admin/courses/:id/modules/reorder
   * Reorder course modules atomically (#374).
   */
  async reorderModules(
    request: FastifyRequest<{ Params: CourseIdParams; Body: ReorderModulesBody }>,
    reply: FastifyReply
  ): Promise<void> {
    const { id } = request.params;
    const modules = await courseService.reorderModules(
      id,
      request.body.moduleIds,
    );

    reply.send({ success: true, data: modules });
  }

  /**
   * GET /api/v1/admin/courses/:id/modules/:moduleId/content
   * List content items within a module (#382).
   */
  async listContent(
    request: FastifyRequest<{ Params: ModuleParams }>,
    reply: FastifyReply
  ): Promise<void> {
    const { id, moduleId } = request.params;
    const items = await courseService.listModuleContent(id, moduleId);

    reply.send({ success: true, data: items });
  }

  /**
   * POST /api/v1/admin/courses/:id/modules/:moduleId/content
   * Create a content item within a module (#382).
   */
  async createContent(
    request: FastifyRequest<{ Params: ModuleParams; Body: CreateContentBody }>,
    reply: FastifyReply
  ): Promise<void> {
    const { id, moduleId } = request.params;
    const item = await courseService.createModuleContent(id, moduleId, request.body);

    reply.status(201).send({ success: true, data: item });
  }

  /**
   * PUT /api/v1/admin/courses/:id/modules/:moduleId/content/:contentId
   * Update a content item within a module (#382).
   */
  async updateContent(
    request: FastifyRequest<{ Params: ContentParams; Body: UpdateContentBody }>,
    reply: FastifyReply
  ): Promise<void> {
    const { id, moduleId, contentId } = request.params;
    const item = await courseService.updateModuleContent(id, moduleId, contentId, request.body);

    reply.send({ success: true, data: item });
  }

  /**
   * DELETE /api/v1/admin/courses/:id/modules/:moduleId/content/:contentId
   * Delete a content item within a module (#382).
   */
  async deleteContent(
    request: FastifyRequest<{ Params: ContentParams }>,
    reply: FastifyReply
  ): Promise<void> {
    const { id, moduleId, contentId } = request.params;
    await courseService.deleteModuleContent(id, moduleId, contentId);

    reply.send({ success: true, message: "Content item deleted" });
  }

  /**
   * POST/PUT /api/v1/admin/courses/:id/modules/:moduleId/content/reorder
   * Reorder content items within a module (#382).
   */
  async reorderContent(
    request: FastifyRequest<{ Params: ModuleParams; Body: ReorderContentBody }>,
    reply: FastifyReply
  ): Promise<void> {
    const { id, moduleId } = request.params;
    const items = await courseService.reorderModuleContent(
      id,
      moduleId,
      request.body.contentIds
    );

    reply.send({ success: true, data: items });
  }
}

export const adminCourseController = new AdminCourseController();
