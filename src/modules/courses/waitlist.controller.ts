import type { FastifyRequest, FastifyReply } from "fastify";
import { waitlistService } from "./waitlist.service.js";
import type { AuthenticatedRequest } from "../../middleware/auth.js";
import type { JoinWaitlistBody, LeaveWaitlistBody } from "./waitlist.types.js";

export class WaitlistController {
  /**
   * POST /api/v1/courses/:id/waitlist
   * Join a course waitlist
   */
  async joinWaitlist(
    request: FastifyRequest<{ Body: JoinWaitlistBody }>,
    reply: FastifyReply
  ): Promise<void> {
    const { authUser } = request as AuthenticatedRequest;
    const { courseId } = request.body;

    const result = await waitlistService.joinWaitlist(authUser.id, courseId);
    reply.status(201).send({
      success: true,
      data: result,
    });
  }

  /**
   * DELETE /api/v1/courses/:id/waitlist
   * Leave a course waitlist
   */
  async leaveWaitlist(
    request: FastifyRequest<{ Body: LeaveWaitlistBody }>,
    reply: FastifyReply
  ): Promise<void> {
    const { authUser } = request as AuthenticatedRequest;
    const { courseId } = request.body;

    const result = await waitlistService.leaveWaitlist(authUser.id, courseId);
    reply.send({
      success: true,
      data: result,
    });
  }

  /**
   * GET /api/v1/courses/:id/waitlist/status
   * Get the user's waitlist status for a course
   */
  async getStatus(
    request: FastifyRequest<{ Params: { id: string } }>,
    reply: FastifyReply
  ): Promise<void> {
    const { authUser } = request as AuthenticatedRequest;
    const { id: courseId } = request.params;

    const status = await waitlistService.getWaitlistStatus(authUser.id, courseId);
    reply.send({
      success: true,
      data: status,
    });
  }
}

export const waitlistController = new WaitlistController();
