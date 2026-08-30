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
}
