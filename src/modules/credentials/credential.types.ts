import { z } from "zod";

// ─── Request Schemas ────────────────────────────────────────────────────────

export const mintCredentialSchema = z.object({
  courseId: z.string().uuid("Invalid course ID"),
  submissionId: z.string().uuid("Invalid submission ID"),
});

// ─── Types ──────────────────────────────────────────────────────────────────

export type MintCredentialBody = z.infer<typeof mintCredentialSchema>;

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
