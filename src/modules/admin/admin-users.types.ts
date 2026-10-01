import { z } from "zod";

// ─── Request schemas ──────────────────────────────────────────────────────────

export const userIdParamsSchema = z.object({
  userId: z.string().uuid("Invalid user ID"),
});

export const creditAdjustmentSchema = z.object({
  amount: z
    .number()
    .int("Amount must be an integer")
    .positive("Amount must be greater than zero"),
  reason: z.string().min(1).max(255),
});

// ─── Types ────────────────────────────────────────────────────────────────────

export type UserIdParams = z.infer<typeof userIdParamsSchema>;
export type CreditAdjustmentBody = z.infer<typeof creditAdjustmentSchema>;

export interface CreditAdjustmentResult {
  userId: string;
  previousCredits: number;
  newCredits: number;
  delta: number;
}
