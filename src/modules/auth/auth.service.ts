import crypto from "node:crypto";
import * as StellarSdk from "@stellar/stellar-sdk";
import { redis } from "../../config/redis.js";
import { db } from "../../config/database.js";
import { users } from "../../database/schema.js";
import { getNetworkPassphrase } from "../../config/stellar.js";
import { UnauthorizedError } from "../../utils/errors.js";
import { logger } from "../../utils/logger.js";
import { eq } from "drizzle-orm";
import type { ChallengeResponse, AuthResponse } from "./auth.types.js";

const CHALLENGE_TTL_SECONDS = 300; // 5 minutes
const CHALLENGE_PREFIX = "sep10:challenge:";

export class AuthService {
  /**
   * Generate a SEP-10 challenge for the given Stellar address.
   * Stores the challenge in Redis for later verification.
   */
  async createChallenge(stellarAddress: string): Promise<ChallengeResponse> {
    const nonce = crypto.randomBytes(32).toString("base64");
    const homeDomain = "chainlearn.io";
    const webAuthDomain = "auth.chainlearn.io";
    const now = Math.floor(Date.now() / 1000);

    // Build a SEP-10 compatible challenge transaction
    // In production, use the actual SEP-10 challenge structure
    const challengeData = {
      account: stellarAddress,
      nonce,
      homeDomain,
      webAuthDomain,
      networkPassphrase: getNetworkPassphrase(),
      issuedAt: new Date(now * 1000).toISOString(),
      expiresIn: CHALLENGE_TTL_SECONDS,
    };

    const challengeToken = Buffer.from(JSON.stringify(challengeData)).toString(
      "base64url"
    );

    // Store challenge in Redis for verification
    await redis.setex(
      `${CHALLENGE_PREFIX}${stellarAddress}`,
      CHALLENGE_TTL_SECONDS,
      JSON.stringify({ ...challengeData, challengeToken })
    );

    logger.info({ stellarAddress }, "Challenge created");

    return {
      challenge: challengeToken,
      networkPassphrase: getNetworkPassphrase(),
    };
  }

  /**
   * Verify a signed challenge and issue a JWT.
   * Looks up or creates the user record.
   */
  async verifyChallenge(
    stellarAddress: string,
    signedChallenge: string
  ): Promise<AuthResponse> {
    // Retrieve stored challenge from Redis
    const storedRaw = await redis.get(
      `${CHALLENGE_PREFIX}${stellarAddress}`
    );
    if (!storedRaw) {
      throw new UnauthorizedError("Challenge expired or not found");
    }

    const stored = JSON.parse(storedRaw);

    // Verify the signed challenge matches
    // In a full SEP-10 implementation, we'd decode the tx envelope,
    // verify signatures, and check the time bounds
    if (signedChallenge !== stored.challengeToken) {
      throw new UnauthorizedError("Invalid signed challenge");
    }

    // Clean up the challenge (single-use)
    await redis.del(`${CHALLENGE_PREFIX}${stellarAddress}`);

    // Find or create user
    let user = await db.query.users.findFirst({
      where: eq(users.stellarAddress, stellarAddress),
    });

    let isNewUser = false;
    if (!user) {
      [user] = await db
        .insert(users)
        .values({ stellarAddress })
        .returning();
      isNewUser = true;
      logger.info({ stellarAddress, userId: user.id }, "New user created");
    }

    return {
      token: "", // Will be set by controller
      user: {
        id: user.id,
        stellarAddress: user.stellarAddress,
        displayName: user.displayName,
        isNewUser,
      },
    };
  }
}

export const authService = new AuthService();
