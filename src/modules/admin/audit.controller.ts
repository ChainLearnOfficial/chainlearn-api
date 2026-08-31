import type { FastifyRequest, FastifyReply } from "fastify";
import { auditService } from "./audit.service.js";
import type { ListAuditLogsQuery } from "./audit.types.js";

export class AuditController {
  /**
   * GET /api/v1/admin/audit-logs
   * Paginated, filterable audit log listing (admin only).
   */
  async list(
    request: FastifyRequest<{ Querystring: ListAuditLogsQuery }>,
    reply: FastifyReply,
  ): Promise<void> {
    const query = request.query;
    const result = await auditService.listLogs(query);

    reply.send({
      success: true,
      data: result.logs,
      pagination: {
        limit: query.limit,
        offset: query.offset,
        total: result.total,
      },
    });
  }
}

export const auditController = new AuditController();
