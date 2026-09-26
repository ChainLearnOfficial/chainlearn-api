import { z } from "zod";

// ─── Request Schemas ────────────────────────────────────────────────────────

export const listUsersSchema = z.object({
  search: z.string().optional(),
  page: z.coerce.number().int().min(1).default(1),
  limit: z.coerce.number().int().min(1).max(50).default(20),
});

// ─── Credit Grants (#386) ────────────────────────────────────────────────────

/** Hard ceiling on a single grant, so a typo (or a hostile admin token)
 * can't mint an absurd balance. Generous relative to the 10 credits a passed
 * quiz is worth, but still bounded. */
export const MAX_CREDIT_GRANT = 1_000_000;

export const grantCreditsSchema = z.object({
  // Positive only — this endpoint adds credits. Taking credits away is the
  // separate deduct operation (#23), so a negative or zero `amount` here is
  // always a caller mistake rather than a request to subtract.
  amount: z.coerce
    .number()
    .int("Amount must be a whole number of credits")
    .positive("Amount must be greater than 0")
    .max(MAX_CREDIT_GRANT, `Amount must not exceed ${MAX_CREDIT_GRANT}`),
  // Required: an unattributed credit change is unauditable, and the whole
  // point of this endpoint is to leave a reason behind.
  reason: z.string().trim().min(1, "Reason is required").max(500),
  // Optional external pointer — a promotion code, a support ticket, a
  // campaign name. Purely for reconciliation; nothing looks it up. Blank is
  // normalized to absent so an empty form field doesn't store "".
  reference: z.preprocess(
    (v) => (typeof v === "string" && v.trim() === "" ? undefined : v),
    z.string().trim().min(1).max(200).optional(),
  ),
});

/** Route params for POST /admin/users/:id/credits/grant. */
export const userIdParamsSchema = z.object({
  id: z.string().uuid("Invalid user ID"),
});

// ─── Types ──────────────────────────────────────────────────────────────────

export type ListUsersQuery = z.infer<typeof listUsersSchema>;
export type GrantCreditsBody = z.infer<typeof grantCreditsSchema>;
export type UserIdParams = z.infer<typeof userIdParamsSchema>;

/** Response of POST /admin/v1/users/:id/credits/grant (#386). Reports the
 * balance on both sides of the grant so the caller doesn't have to re-read
 * the user to confirm what happened. */
export interface CreditGrantResult {
  userId: string;
  amount: number;
  reason: string;
  reference: string | null;
  creditsBefore: number;
  creditsAfter: number;
  grantedAt: Date;
}

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
