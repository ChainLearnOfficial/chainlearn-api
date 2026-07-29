import { z } from "zod";

// ─── Request Schemas ────────────────────────────────────────────────────────

export const claimRewardSchema = z.object({
  submissionId: z.string().uuid("Invalid submission ID"),
  idempotencyKey: z.string().min(16).max(64),
});

export const getHistorySchema = z.object({
  page: z.coerce.number().int().min(1).default(1),
  limit: z.coerce.number().int().min(1).max(50).default(20),
});

// ─── Types ──────────────────────────────────────────────────────────────────

export type ClaimRewardBody = z.infer<typeof claimRewardSchema>;
export type GetHistoryQuery = z.infer<typeof getHistorySchema>;

export interface RewardClaimResult {
  submissionId: string;
  amount: number;
  txHash: string | null;
  queued: boolean;
  message: string;
}

export interface RewardHistoryItem {
  id: string;
  courseTitle: string;
  score: number;
  amount: number;
  txHash: string | null;
  claimedAt: Date;
}
