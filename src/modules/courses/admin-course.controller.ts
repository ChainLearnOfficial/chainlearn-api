import type { FastifyRequest, FastifyReply } from "fastify";
import { courseService } from "./course.service.js";
import type {
  CourseIdParams,
  CreateCourseBody,
  UpdateCourseBody,
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
}

export const adminCourseController = new AdminCourseController();
