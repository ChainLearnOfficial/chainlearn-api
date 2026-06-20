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
const HOME_DOMAIN = "chainlearn.io";

export class AuthService {
  /**
   * Generate a SEP-10 challenge transaction for the given Stellar address.
   * Stores the challenge transaction in Redis for later verification.
   */
  async createChallenge(stellarAddress: string): Promise<ChallengeResponse> {
    const now = Math.floor(Date.now() / 1000);
    const minTime = now;
    const maxTime = now + CHALLENGE_TTL_SECONDS;

    // Build a SEP-10 challenge transaction
    const account = new StellarSdk.Account(stellarAddress, "0");
    const challengeNonce = crypto.randomBytes(32).toString("base64");

    const transaction = new StellarSdk.TransactionBuilder(account, {
      fee: StellarSdk.BASE_FEE,
      networkPassphrase: getNetworkPassphrase(),
    })
      .addOperation(
        StellarSdk.Operation.manageData({
          name: HOME_DOMAIN,
          value: challengeNonce,
        })
      )
      .addOperation(
        StellarSdk.Operation.manageData({
          name: "auth_home_domain",
          value: HOME_DOMAIN,
        })
      )
      .setTimeout(maxTime - minTime)
      .build();

    const challengeEnvelope = transaction.toEnvelope().toXDR("base64");

    // Store challenge in Redis for verification
    await redis.setex(
      `${CHALLENGE_PREFIX}${stellarAddress}`,
      CHALLENGE_TTL_SECONDS,
      JSON.stringify({
        challengeEnvelope,
        stellarAddress,
        issuedAt: now,
        expiresAt: maxTime,
      })
    );

    logger.info({ stellarAddress }, "Challenge created");

    return {
      challenge: challengeEnvelope,
      networkPassphrase: getNetworkPassphrase(),
    };
  }

  /**
   * Verify a signed SEP-10 challenge transaction and issue a JWT.
   * Looks up or creates the user record.
   */
  async verifyChallenge(
    stellarAddress: string,
    signedChallenge: string
  ): Promise<AuthResponse> {
    // Retrieve stored challenge from Redis
    // Check that a challenge exists (single-use, must not be consumed yet)
    const challengeExists = await redis.exists(
      `${CHALLENGE_PREFIX}${stellarAddress}`
    );
    if (!challengeExists) {
      throw new UnauthorizedError("Challenge expired or not found");
    }

    // Decode the signed transaction envelope
    let transaction: StellarSdk.Transaction;
    try {
      transaction = StellarSdk.TransactionBuilder.fromXDR(
        signedChallenge,
        getNetworkPassphrase()
      ) as StellarSdk.Transaction;
    } catch {
      throw new UnauthorizedError("Invalid transaction envelope");
    }

    // Verify the source account matches the claimed stellar address
    if (transaction.source !== stellarAddress) {
      throw new UnauthorizedError("Transaction source does not match claimed address");
    }

    // Check time bounds to prevent stale/replay attacks
    const now = Math.floor(Date.now() / 1000);
    if (transaction.timeBounds) {
      const minTime = parseInt(transaction.timeBounds.minTime, 10);
      const maxTime = parseInt(transaction.timeBounds.maxTime, 10);
      if (now < minTime || now > maxTime) {
        throw new UnauthorizedError("Challenge has expired");
      }
    }

    // Verify the signature against the claimed public key
    const publicKeyKeypair = StellarSdk.Keypair.fromPublicKey(stellarAddress);
    const signature = transaction.signatures[0];
    if (!signature) {
      throw new UnauthorizedError("No signature found in transaction");
    }

    try {
      const txHash = transaction.hash();
      const sigDecoded = signature.signature();
      const key = publicKeyKeypair.rawPublicKey();

      const verified = StellarSdk.verify(txHash, sigDecoded, key);
      if (!verified) {
        throw new UnauthorizedError("Invalid signature");
      }
    } catch (error) {
      if (error instanceof UnauthorizedError) {
        throw error;
      }
      throw new UnauthorizedError("Signature verification failed");
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
