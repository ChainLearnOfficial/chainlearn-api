import type { FastifyRequest, FastifyReply } from "fastify";
import { courseService } from "./course.service.js";
import type {
  CourseIdParams,
  CreateCourseBody,
  UpdateCourseBody,
  CreateModuleBody,
  UpdateModuleBody,
  ModuleParams,
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
   * POST /api/admin/courses/:id/duplicate
   * Duplicate a course (metadata, modules, quizzes) into a new draft course.
   */
  async duplicate(
    request: FastifyRequest<{ Params: CourseIdParams }>,
    reply: FastifyReply
  ): Promise<void> {
    const { id } = request.params;
    const course = await courseService.duplicateCourse(id);

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
}

export const adminCourseController = new AdminCourseController();
