import type { FastifyInstance, FastifySchema } from "fastify";
import { auditController } from "./audit.controller.js";
import { authGuard, adminGuard } from "../../middleware/auth.js";
import { validate } from "../../middleware/validation.js";
import { listAuditLogsSchema } from "./audit.types.js";

/** Admin-only audit log querying (#289). Every route requires an admin user. */
export async function auditRoutes(app: FastifyInstance): Promise<void> {
  app.addHook("onRequest", authGuard);
  app.addHook("preHandler", adminGuard);

  app.get<{ Querystring: import("./audit.types.js").ListAuditLogsQuery }>(
    "/",
    {
      preHandler: [validate({ querystring: listAuditLogsSchema })],
      schema: {
        description:
          "List audit log entries, paginated and filterable by event and date range (admin only)",
        tags: ["admin", "audit-logs"],
        security: [{ bearerAuth: [] }],
        querystring: {
          type: "object",
          properties: {
            event: { type: "string" },
            dateFrom: { type: "string", format: "date-time" },
            dateTo: { type: "string", format: "date-time" },
            limit: { type: "integer", minimum: 1, maximum: 100, default: 20 },
            offset: { type: "integer", minimum: 0, default: 0 },
          },
        },
      } as FastifySchema,
    },
    (request, reply) => auditController.list(request, reply),
  );
}
