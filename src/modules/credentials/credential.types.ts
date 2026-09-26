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

export const certificateIdParamsSchema = z.object({
  id: z.string().uuid("Invalid credential ID"),
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

/** A earned certificate with its verification and download links (#371). */
export interface CertificateItem {
  credentialId: string;
  courseId: string;
  courseTitle: string;
  score: number;
  issuedAt: Date;
  nftAssetCode: string | null;
  nftIssuer: string | null;
  /** Public explorer link to the on-chain mint transaction, or null when none. */
  verificationUrl: string | null;
  downloadUrl: string;
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
