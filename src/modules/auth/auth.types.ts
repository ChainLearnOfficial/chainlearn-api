import { z } from 'zod';

export const ChallengeRequestSchema = z.object({
  stellarAddress: z.string().min(56).max(56), // Standard public key lengths
});

export const VerifyRequestSchema = z.object({
  stellarAddress: z.string().min(56).max(56),
  signedChallengeXDR: z.string(),
});

export interface ChallengeResponse {
  challenge: string;
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
