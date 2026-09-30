import type { FastifyRequest, FastifyReply } from "fastify";
import { dashboardService } from "./dashboard.service.js";

export class DashboardController {
  /**
   * GET /api/v1/admin/dashboard
   * Platform-wide statistics for the admin console (#367).
   */
  async stats(_request: FastifyRequest, reply: FastifyReply): Promise<void> {
    const stats = await dashboardService.getStats();

    reply.send({ success: true, data: stats });
  }
}

export const dashboardController = new DashboardController();
