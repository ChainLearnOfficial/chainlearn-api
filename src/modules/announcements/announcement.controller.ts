import type { FastifyRequest, FastifyReply } from "fastify";
import { announcementService } from "./announcement.service.js";
import type {
  AnnouncementIdParams,
  CreateAnnouncementBody,
  UpdateAnnouncementBody,
  ListAnnouncementsAdminQuery,
} from "./announcement.types.js";

export class AnnouncementController {
  /**
   * GET /api/v1/announcements
   * Active, unexpired announcements — public, no auth required.
   */
  async listActive(_request: FastifyRequest, reply: FastifyReply): Promise<void> {
    const items = await announcementService.listActive();

    reply.send({ success: true, data: items });
  }

  /**
   * GET /api/v1/admin/announcements
   * Every announcement, paginated (admin only).
   */
  async listAll(
    request: FastifyRequest<{ Querystring: ListAnnouncementsAdminQuery }>,
    reply: FastifyReply
  ): Promise<void> {
    const page = await announcementService.listAll(request.query);

    reply.send({
      success: true,
      data: page.announcements,
      pagination: {
        page: request.query.page,
        limit: request.query.limit,
        total: page.total,
      },
    });
  }

  /**
   * POST /api/v1/admin/announcements
   * Create a platform-wide announcement (admin only).
   */
  async create(
    request: FastifyRequest<{ Body: CreateAnnouncementBody }>,
    reply: FastifyReply
  ): Promise<void> {
    const announcement = await announcementService.create(request.body);

    reply.status(201).send({ success: true, data: announcement });
  }

  /**
   * PUT /api/v1/admin/announcements/:id
   * Update an announcement (admin only).
   */
  async update(
    request: FastifyRequest<{ Params: AnnouncementIdParams; Body: UpdateAnnouncementBody }>,
    reply: FastifyReply
  ): Promise<void> {
    const { id } = request.params;
    const announcement = await announcementService.update(id, request.body);

    reply.send({ success: true, data: announcement });
  }

  /**
   * DELETE /api/v1/admin/announcements/:id
   * Delete an announcement (admin only).
   */
  async remove(
    request: FastifyRequest<{ Params: AnnouncementIdParams }>,
    reply: FastifyReply
  ): Promise<void> {
    const { id } = request.params;
    await announcementService.remove(id);

    reply.status(204).send();
  }
}

export const announcementController = new AnnouncementController();
