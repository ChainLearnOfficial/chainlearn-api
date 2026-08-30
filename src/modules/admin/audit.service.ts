import { and, count, desc, eq, gte, lte } from "drizzle-orm";
import { db } from "../../config/database.js";
import { auditLogs } from "../../database/schema.js";
import type { AuditLogEntry, ListAuditLogsQuery } from "./audit.types.js";

export class AuditService {
  /**
   * Paginated, filterable audit log listing for the admin console (#289).
   * `event` is an exact match; `dateFrom`/`dateTo` bound `createdAt`
   * (inclusive on both ends). Backed by idx_audit_logs_event and
   * idx_audit_logs_created_at so both the filter and the default
   * newest-first ordering are served by an index rather than a full scan.
   */
  async listLogs(
    query: ListAuditLogsQuery,
  ): Promise<{ logs: AuditLogEntry[]; total: number }> {
    const conditions = [];
    if (query.event) {
      conditions.push(eq(auditLogs.event, query.event));
    }
    if (query.dateFrom) {
      conditions.push(gte(auditLogs.createdAt, new Date(query.dateFrom)));
    }
    if (query.dateTo) {
      conditions.push(lte(auditLogs.createdAt, new Date(query.dateTo)));
    }

    const where = conditions.length > 0 ? and(...conditions) : undefined;

    const [[totalResult], rows] = await Promise.all([
      db.select({ value: count() }).from(auditLogs).where(where),
      db
        .select()
        .from(auditLogs)
        .where(where)
        .orderBy(desc(auditLogs.createdAt))
        .limit(query.limit)
        .offset(query.offset),
    ]);

    return {
      logs: rows.map((row) => ({
        id: row.id,
        event: row.event,
        fields: row.fields,
        createdAt: row.createdAt,
      })),
      total: totalResult?.value ?? 0,
    };
  }
}

export const auditService = new AuditService();
