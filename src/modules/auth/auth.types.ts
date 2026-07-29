import { z } from "zod";

// ─── Request Schemas ────────────────────────────────────────────────────────

export const challengeSchema = z.object({
  stellarAddress: z
    .string()
    .length(56, "Stellar address must be 56 characters")
    .startsWith("G", "Stellar address must start with G"),
});

export const verifySchema = z.object({
  stellarAddress: z
    .string()
    .length(56)
    .startsWith("G"),
  challengeId: z.string().uuid("challengeId must be a valid UUID"),
  signedChallenge: z
    .string()
    .min(1, "Signed challenge is required")
    .max(10_000, "Signed challenge exceeds maximum allowed length"),
});

// ─── Types ──────────────────────────────────────────────────────────────────

export type ChallengeBody = z.infer<typeof challengeSchema>;
export type VerifyBody = z.infer<typeof verifySchema>;

export interface ChallengeResponse {
  challenge: string;
  challengeId: string;
  networkPassphrase: string;
}

export interface AuthResponse {
  token: string;
  user: {
    id: string;
    stellarAddress: string;
    displayName: string | null;
    isNewUser: boolean;
  };
}
