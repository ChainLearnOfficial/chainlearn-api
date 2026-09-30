import type { FastifyRequest, FastifyReply } from "fastify";
import { badgeService } from "./badge.service.js";
import type { AuthenticatedRequest } from "../../middleware/auth.js";
import type {
  CreateBadgeBody,
  UpdateBadgeBody,
  BadgeIdParams,
} from "./badge.types.js";

export class BadgeController {
  /**
   * POST /api/v1/admin/badges
   * Create a new badge definition (admin only, #380).
   */
  async adminCreate(
    request: FastifyRequest<{ Body: CreateBadgeBody }>,
    reply: FastifyReply,
  ): Promise<void> {
    const badge = await badgeService.createBadge(request.body);
    reply.status(201).send({ success: true, data: badge });
  }

  /**
   * GET /api/v1/admin/badges
   * List all badge definitions (admin only, #380).
   */
  async adminList(
    _request: FastifyRequest,
    reply: FastifyReply,
  ): Promise<void> {
    const badges = await badgeService.listBadges();
    reply.send({ success: true, data: badges });
  }

  /**
   * GET /api/v1/admin/badges/:id
   * Get a badge definition by ID (admin only, #380).
   */
  async adminGet(
    request: FastifyRequest<{ Params: BadgeIdParams }>,
    reply: FastifyReply,
  ): Promise<void> {
    const { id } = request.params;
    const badge = await badgeService.getBadge(id);
    reply.send({ success: true, data: badge });
  }

  /**
   * PUT /api/v1/admin/badges/:id
   * Update a badge definition (admin only, #380).
   */
  async adminUpdate(
    request: FastifyRequest<{ Params: BadgeIdParams; Body: UpdateBadgeBody }>,
    reply: FastifyReply,
  ): Promise<void> {
    const { id } = request.params;
    const badge = await badgeService.updateBadge(id, request.body);
    reply.send({ success: true, data: badge });
  }

  /**
   * DELETE /api/v1/admin/badges/:id
   * Delete a badge definition (admin only, #380).
   */
  async adminDelete(
    request: FastifyRequest<{ Params: BadgeIdParams }>,
    reply: FastifyReply,
  ): Promise<void> {
    const { id } = request.params;
    await badgeService.deleteBadge(id);
    reply.send({ success: true, message: "Badge deleted" });
  }

  /**
   * GET /api/v1/users/me/badges
   * Get authenticated user's earned badges and progress toward unearned badges (#379).
   */
  async getUserBadges(
    request: FastifyRequest,
    reply: FastifyReply,
  ): Promise<void> {
    const { authUser } = request as AuthenticatedRequest;
    const result = await badgeService.getUserBadges(authUser.id);
    reply.send({ success: true, data: result });
  }
}

export const badgeController = new BadgeController();
