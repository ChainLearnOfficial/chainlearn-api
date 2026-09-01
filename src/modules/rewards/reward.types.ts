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

export const getLeaderboardSchema = z.object({
  limit: z.coerce.number().int().min(1).max(50).default(50),
});

export const getTransactionsSchema = z.object({
  page: z.coerce.number().int().min(1).default(1),
  limit: z.coerce.number().int().min(1).max(50).default(20),
});

// ─── Types ──────────────────────────────────────────────────────────────────

export type ClaimRewardBody = z.infer<typeof claimRewardSchema>;
export type GetHistoryQuery = z.infer<typeof getHistorySchema>;
export type GetLeaderboardQuery = z.infer<typeof getLeaderboardSchema>;
export type GetTransactionsQuery = z.infer<typeof getTransactionsSchema>;

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

export interface LeaderboardEntry {
  rank: number;
  displayName: string;
  credits: number;
}

export interface LeaderboardResponse {
  entries: LeaderboardEntry[];
  generatedAt: Date;
}

/** One row of GET /api/v1/rewards/transactions — a reward-related on-chain
 * transaction with its verification status against Stellar Horizon.
 * "pending" covers both "not yet indexed" and "Horizon lookup failed" —
 * callers should treat it as "not yet confirmed", not "known bad". */
export interface RewardTransaction {
  id: string;
  courseTitle: string;
  amount: number;
  txHash: string;
  status: "confirmed" | "pending" | "failed";
  blockHeight: number | null;
  confirmationCount: number | null;
  submittedAt: Date;
}
