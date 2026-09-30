import { z } from "zod";

// ─── Request Schemas ────────────────────────────────────────────────────────

export const listAuditLogsSchema = z.object({
  event: z.string().optional(),
  dateFrom: z.string().datetime().optional(),
  dateTo: z.string().datetime().optional(),
  limit: z.coerce.number().int().min(1).max(100).default(20),
  offset: z.coerce.number().int().min(0).default(0),
  /** Opaque keyset cursor from a previous response's `nextCursor` (#482).
   *  When present, takes precedence over `offset` — O(1) regardless of how
   *  far a client has paged, unlike offset which must scan past every prior row. */
  cursor: z.string().optional(),
});

// ─── Types ──────────────────────────────────────────────────────────────────

export type ListAuditLogsQuery = z.infer<typeof listAuditLogsSchema>;

export interface AuditLogEntry {
  id: string;
  event: string;
  fields: unknown;
  createdAt: Date;
}

export interface ListAuditLogsResult {
  logs: AuditLogEntry[];
  total: number;
  /** Present when there may be more results; pass back as `cursor` to
   *  fetch the next page (#482). */
  nextCursor: string | null;
}
