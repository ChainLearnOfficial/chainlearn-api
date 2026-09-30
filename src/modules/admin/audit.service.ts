import { and, count, desc, eq, gte, lt, lte, or } from "drizzle-orm";
import { db } from "../../config/database.js";
import { auditLogs } from "../../database/schema.js";
import { decodeCursor, encodeCursor } from "../../utils/cursor-pagination.js";
import type { ListAuditLogsQuery, ListAuditLogsResult } from "./audit.types.js";

export class AuditService {
  /**
   * Paginated, filterable audit log listing for the admin console (#289).
   * `event` is an exact match; `dateFrom`/`dateTo` bound `createdAt`
   * (inclusive on both ends). Backed by idx_audit_logs_event and
   * idx_audit_logs_created_at so both the filter and the default
   * newest-first ordering are served by an index rather than a full scan.
   *
   * Accepts either `offset` (backward-compatible, O(offset)) or `cursor`
   * (#482, O(1) regardless of how deep the client has paged) — `cursor`
   * wins if both are present. An unparseable cursor is treated as absent
   * (starts from the first page) rather than erroring, since a stale or
   * tampered cursor shouldn't break the client's next request.
   */
  async listLogs(query: ListAuditLogsQuery): Promise<ListAuditLogsResult> {
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

    const filterWhere = conditions.length > 0 ? and(...conditions) : undefined;

    const cursor = query.cursor ? decodeCursor(query.cursor) : null;
    const keysetCondition = cursor
      ? or(
          lt(auditLogs.createdAt, cursor.createdAt),
          and(eq(auditLogs.createdAt, cursor.createdAt), lt(auditLogs.id, cursor.id)),
        )
      : undefined;

    const rowsWhere =
      filterWhere && keysetCondition
        ? and(filterWhere, keysetCondition)
        : (filterWhere ?? keysetCondition);

    // Fetch one extra row to know whether there's a next page without a
    // second COUNT query on the hot path.
    const [[totalResult], rows] = await Promise.all([
      db.select({ value: count() }).from(auditLogs).where(filterWhere),
      db
        .select()
        .from(auditLogs)
        .where(rowsWhere)
        .orderBy(desc(auditLogs.createdAt), desc(auditLogs.id))
        .limit(query.limit + 1)
        .offset(cursor ? 0 : query.offset),
    ]);

    const hasMore = rows.length > query.limit;
    const page = hasMore ? rows.slice(0, query.limit) : rows;
    const lastRow = page[page.length - 1];

    return {
      logs: page.map((row) => ({
        id: row.id,
        event: row.event,
        fields: row.fields,
        createdAt: row.createdAt,
      })),
      total: totalResult?.value ?? 0,
      nextCursor: hasMore && lastRow ? encodeCursor(lastRow) : null,
    };
  }
}

export const auditService = new AuditService();
