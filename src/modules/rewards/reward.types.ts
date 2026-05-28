import { z } from "zod";

// ─── Request Schemas ────────────────────────────────────────────────────────

export const claimRewardSchema = z.object({
  submissionId: z.string().uuid("Invalid submission ID"),
});

// ─── Types ──────────────────────────────────────────────────────────────────

export type ClaimRewardBody = z.infer<typeof claimRewardSchema>;

export interface RewardClaimResult {
  submissionId: string;
  amount: number;
  txHash: string;
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
