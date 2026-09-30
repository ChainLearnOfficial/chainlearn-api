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

export const refreshSchema = z.object({
  refreshToken: z
    .string()
    .min(1, "refreshToken is required")
    .max(512, "refreshToken exceeds maximum allowed length"),
});

// Body is optional — logout works with just the Authorization header. When a
// body is sent, `refreshToken` is the only accepted field.
export const logoutSchema = z
  .object({
    refreshToken: z
      .string()
      .min(1)
      .max(512, "refreshToken exceeds maximum allowed length")
      .optional(),
  })
  .optional();

export const sessionIdParamsSchema = z.object({
  sessionId: z.string().uuid("Invalid session ID"),
});

// ─── Types ──────────────────────────────────────────────────────────────────

export type ChallengeBody = z.infer<typeof challengeSchema>;
export type VerifyBody = z.infer<typeof verifySchema>;
export type RefreshBody = z.infer<typeof refreshSchema>;
export type LogoutBody = z.infer<typeof logoutSchema>;
export type SessionIdParams = z.infer<typeof sessionIdParamsSchema>;

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

export interface VerifyResponseData {
  /** Short-lived (24h) access token. */
  token: string;
  /** Long-lived (7d) single-use refresh token — rotated on every use. */
  refreshToken: string;
  user: AuthResponse["user"];
}

export interface RefreshResponseData {
  token: string;
  refreshToken: string;
}
