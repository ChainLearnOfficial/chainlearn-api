import { z } from "zod";

// ─── Request Schemas ────────────────────────────────────────────────────────

export const listUsersSchema = z.object({
  search: z.string().optional(),
  page: z.coerce.number().int().min(1).default(1),
  limit: z.coerce.number().int().min(1).max(50).default(20),
});

// ─── Types ──────────────────────────────────────────────────────────────────

export type ListUsersQuery = z.infer<typeof listUsersSchema>;

export interface AdminUserSummary {
  id: string;
  stellarAddress: string;
  displayName: string | null;
  isAdmin: boolean;
  credits: number;
  createdAt: Date;
  // Non-null for a soft-deleted account (#290) — surfaced rather than
  // filtered out of the listing so admins can distinguish "user never set
  // a display name" from "this account was deleted and its profile fields
  // were cleared".
  deletedAt: Date | null;
}

// ─── Admin user credentials listing (#410) ─────────────────────────────────

// Param shape shared with /:id/ban and /:id/activity — kept local (not
// zod-validated) to mirror the existing admin-users routes, which validate
// only where a body/query exists.
export interface UserIdParams {
  id: string;
}
