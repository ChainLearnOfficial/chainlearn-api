import { z } from "zod";

// ─── Request Schemas ────────────────────────────────────────────────────────

export const mintCredentialSchema = z.object({
  courseId: z.string().uuid("Invalid course ID"),
  submissionId: z.string().uuid("Invalid submission ID"),
  idempotencyKey: z.string().min(16).max(64),
});

export const batchMintCredentialSchema = z.object({
  submissions: z
    .array(
      z.object({
        courseId: z.string().uuid("Invalid course ID"),
        submissionId: z.string().uuid("Invalid submission ID"),
      }),
    )
    .min(1, "At least one submission is required")
    .max(20, "Too many submissions"),
});

// ─── Types ──────────────────────────────────────────────────────────────────

export type MintCredentialBody = z.infer<typeof mintCredentialSchema>;
export type BatchMintCredentialBody = z.infer<typeof batchMintCredentialSchema>;

export interface MintResult {
  credentialId: string;
  nftAssetCode: string;
  nftIssuer: string;
  mintTxHash: string;
  message: string;
}

export interface CredentialListItem {
  id: string;
  courseTitle: string;
  score: number;
  nftAssetCode: string | null;
  nftIssuer: string | null;
  mintTxHash: string | null;
  revoked: boolean;
  mintedAt: Date;
}

export interface BatchMintResultItem {
  courseId: string;
  submissionId: string;
  success: boolean;
  data?: MintResult;
  error?: {
    code: string;
    message: string;
  };
}
