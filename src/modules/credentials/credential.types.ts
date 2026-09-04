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

export interface AdminUserCredentialItem {
  id: string;
  courseTitle: string;
  score: number;
  nftAssetCode: string | null;
  mintTxHash: string | null;
  revoked: boolean;
  mintedAt: Date;
  verification:
    | { kind: "none"; status: "not_minted" | "unknown" }
    | { kind: "on_chain"; status: "confirmed" | "pending" | "failed"; ledger: number | null; confirmations: number | null };
}

// ─── Admin: user credentials listing (#410) ────────────────────────────────

// Verification state resolved per credential in getAdminUserCredentials:
// "not_minted" for rows with no mint tx yet, otherwise the live Horizon
// verification of the stored mint tx hash. Keep in sync with the union on
// AdminUserCredentialItem above.
export type AdminCredentialVerification =
  AdminUserCredentialItem["verification"];

// Body/route schemas for #410 live in admin.types.ts (admin_users params use
// the plain :id param shape shared by the module).
