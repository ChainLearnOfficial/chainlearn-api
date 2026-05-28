import type { FastifyRequest, FastifyReply } from "fastify";
import { userService } from "./user.service.js";
import type { AuthenticatedRequest } from "../../middleware/auth.js";
import type { UpdateProfileBody } from "./user.types.js";

export class UserController {
  /**
   * GET /api/users/me
   * Return the authenticated user's profile.
   */
  async getMe(
    request: FastifyRequest,
    reply: FastifyReply
  ): Promise<void> {
    const { authUser } = request as AuthenticatedRequest;
    const profile = await userService.getProfile(authUser.id);

    reply.send({ success: true, data: profile });
  }

  /**
   * PUT /api/users/me
   * Update the authenticated user's profile.
   */
  async updateMe(
    request: FastifyRequest<{ Body: UpdateProfileBody }>,
    reply: FastifyReply
  ): Promise<void> {
    const { authUser } = request as AuthenticatedRequest;
    const data = (request as any).validatedBody;
    const profile = await userService.updateProfile(authUser.id, data);

    reply.send({ success: true, data: profile });
  }

  /**
   * GET /api/users/me/progress
   * Return learning progress stats for the authenticated user.
   */
  async getProgress(
    request: FastifyRequest,
    reply: FastifyReply
  ): Promise<void> {
    const { authUser } = request as AuthenticatedRequest;
    const progress = await userService.getProgress(authUser.id);

    reply.send({ success: true, data: progress });
  }
}

export const userController = new UserController();
