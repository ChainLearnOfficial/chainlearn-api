import type { FastifyRequest, FastifyReply } from "fastify";
import { userService } from "./user.service.js";
import type { AuthenticatedRequest } from "../../middleware/auth.js";
import { config } from "../../config/index.js";
import { ValidationError } from "../../utils/errors.js";
import type { ActivityQuery, UpdateProfileBody } from "./user.types.js";

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
    const data = request.body;
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

  /**
   * GET /api/users/me/activity
   * Return the authenticated user's recent activity timeline.
   */
  async getActivity(
    request: FastifyRequest<{ Querystring: ActivityQuery }>,
    reply: FastifyReply
  ): Promise<void> {
    const { authUser } = request as AuthenticatedRequest;
    const activity = await userService.getActivity(authUser.id, request.query);

    reply.send({
      success: true,
      data: activity.activities,
      pagination: {
        nextCursor: activity.nextCursor,
      },
    });
  }

  /**
   * PUT /api/users/me/avatar
   * Upload and replace the authenticated user's avatar image.
   */
  async updateAvatar(
    request: FastifyRequest,
    reply: FastifyReply
  ): Promise<void> {
    const { authUser } = request as AuthenticatedRequest;

    if (!request.isMultipart()) {
      throw new ValidationError({
        avatar: ["Request must be multipart/form-data"],
      });
    }

    const file = await request.file({
      limits: {
        fileSize: config.AVATAR_UPLOAD_MAX_BYTES,
        files: 1,
      },
    });

    if (!file) {
      throw new ValidationError({
        avatar: ["Avatar image is required"],
      });
    }

    const buffer = await file.toBuffer();
    const profile = await userService.updateAvatar(authUser.id, {
      buffer,
      filename: file.filename,
      mimetype: file.mimetype,
      size: buffer.byteLength,
    });

    reply.send({ success: true, data: profile });
  }
}

export const userController = new UserController();
