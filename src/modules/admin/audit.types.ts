import { z } from "zod";

// ─── Request Schemas ────────────────────────────────────────────────────────

export const listAuditLogsSchema = z.object({
  event: z.string().optional(),
  dateFrom: z.string().datetime().optional(),
  dateTo: z.string().datetime().optional(),
  limit: z.coerce.number().int().min(1).max(100).default(20),
  offset: z.coerce.number().int().min(0).default(0),
});

// ─── Types ──────────────────────────────────────────────────────────────────

export type ListAuditLogsQuery = z.infer<typeof listAuditLogsSchema>;

export interface AuditLogEntry {
  id: string;
  event: string;
  fields: unknown;
  createdAt: Date;
}
