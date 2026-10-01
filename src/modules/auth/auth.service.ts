import crypto from "node:crypto";
import * as StellarSdk from "@stellar/stellar-sdk";
import { redis } from "../../config/redis.js";
import { db } from "../../config/database.js";
import { users } from "../../database/schema.js";
import { getNetworkPassphrase } from "../../config/stellar.js";
import { RateLimitError, UnauthorizedError } from "../../utils/errors.js";
import { logger } from "../../utils/logger.js";
import { eq } from "drizzle-orm";
import type { ChallengeResponse, AuthResponse } from "./auth.types.js";
import { safeEqual } from "../../utils/crypto.js";
import {
  checkAuthLockout,
  clearAuthFailures,
  recordAuthFailure,
} from "../../utils/auth-attempt-tracker.js";

const CHALLENGE_TTL_SECONDS = 300; // 5 minutes
const CHALLENGE_PREFIX = "sep10:challenge:";
const HOME_DOMAIN = "chainlearn.io";

export class AuthService {
  /**
   * Generate a SEP-10 challenge transaction for the given Stellar address.
   * Stores the challenge transaction in Redis for later verification.
   */
  async createChallenge(stellarAddress: string): Promise<ChallengeResponse> {
    // #488: an address locked out from repeated verify failures can't even
    // draw a fresh challenge until the lockout expires — otherwise lockout
    // would only block the verify step, not the attempt itself.
    const lockout = await checkAuthLockout(stellarAddress);
    if (lockout.lockedOut) {
      throw new RateLimitError(
        "Too many failed authentication attempts for this account. Please try again later.",
        lockout.retryAfterSeconds,
      );
    }

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

    // A random, per-request ID makes the Redis key unpredictable so an
    // attacker cannot overwrite or delete a pending challenge by issuing a
    // new createChallenge request for the same address (DoS via key clobber).
    const challengeId = crypto.randomUUID();

    await redis.setex(
      `${CHALLENGE_PREFIX}${stellarAddress}:${challengeId}`,
      CHALLENGE_TTL_SECONDS,
      JSON.stringify({
        challengeEnvelope,
        stellarAddress,
        issuedAt: now,
        expiresAt: maxTime,
      })
    );

    logger.info({ stellarAddress, challengeId }, "Challenge created");

    return {
      challenge: challengeEnvelope,
      challengeId,
      networkPassphrase: getNetworkPassphrase(),
    };
  }

  /**
   * Verify a signed SEP-10 challenge transaction and issue a JWT.
   * Looks up or creates the user record.
   *
   * Wraps verifyChallengeInternal with per-account failure tracking (#488):
   * locked-out addresses are rejected before any verification work runs;
   * every UnauthorizedError from the inner method counts as a failure and
   * can trigger a lockout; success clears the address's failure history.
   * The inner method's own verification logic (signature, nonce, time
   * bounds) is unchanged — this only wraps it.
   */
  async verifyChallenge(
    stellarAddress: string,
    challengeId: string,
    signedChallenge: string
  ): Promise<AuthResponse> {
    const lockout = await checkAuthLockout(stellarAddress);
    if (lockout.lockedOut) {
      throw new RateLimitError(
        "Too many failed authentication attempts for this account. Please try again later.",
        lockout.retryAfterSeconds,
      );
    }

    try {
      const result = await this.verifyChallengeInternal(
        stellarAddress,
        challengeId,
        signedChallenge,
      );
      await clearAuthFailures(stellarAddress);
      return result;
    } catch (err) {
      if (err instanceof UnauthorizedError) {
        await recordAuthFailure(stellarAddress, { challengeId });
      }
      throw err;
    }
  }

  private async verifyChallengeInternal(
    stellarAddress: string,
    challengeId: string,
    signedChallenge: string
  ): Promise<AuthResponse> {
    // Atomically retrieve and delete the challenge (single-use, must not be consumed yet).
    // The key includes the per-request challengeId so it cannot be guessed or clobbered.
    const challengeData = await redis.getdel(
      `${CHALLENGE_PREFIX}${stellarAddress}:${challengeId}`
    );
    if (!challengeData) {
      throw new UnauthorizedError("Challenge expired or not found");
    }

    let storedChallenge: { challengeEnvelope: string };
    try {
      storedChallenge = JSON.parse(challengeData);
    } catch (err) {
      // This is the server's own Redis-stored value, not client input, so
      // a parse failure here is an internal anomaly worth tracking.
      logger.warn(
        { err, stellarAddress, challengeId },
        "Corrupt stored SEP-10 challenge record",
      );
      logger.debug({ err, stellarAddress }, "Stored challenge is not valid JSON");
      throw new UnauthorizedError("Corrupt stored challenge");
    }

    // Decode the transaction the server itself issued, to read back the
    // random nonce it embedded — this is the value the client's submission
    // must match. Without this, any validly-signed transaction containing a
    // manageData operation named HOME_DOMAIN would pass verification,
    // regardless of whether it's the actual challenge this server issued.
    let issuedTransaction: StellarSdk.Transaction;
    try {
      issuedTransaction = StellarSdk.TransactionBuilder.fromXDR(
        storedChallenge.challengeEnvelope,
        getNetworkPassphrase()
      ) as StellarSdk.Transaction;
    } catch (err) {
      // Same as above — this decodes the server's own issued envelope, not
      // client input, so a decode failure here is an internal anomaly.
      logger.warn(
        { err, stellarAddress, challengeId },
        "Failed to decode server-issued SEP-10 challenge envelope",
      );
      logger.debug({ err, stellarAddress }, "Stored challenge envelope failed to decode from XDR");
      throw new UnauthorizedError("Corrupt stored challenge");
    }
    const issuedNonceOp = issuedTransaction.operations.find(
      (op) => op.type === "manageData" && op.name === HOME_DOMAIN
    ) as StellarSdk.Operation.ManageData | undefined;
    if (!issuedNonceOp || !issuedNonceOp.value) {
      throw new UnauthorizedError("Corrupt stored challenge");
    }
    const issuedNonce = Buffer.from(issuedNonceOp.value).toString("base64");

    // Decode the signed transaction envelope
    let transaction: StellarSdk.Transaction;
    try {
      transaction = StellarSdk.TransactionBuilder.fromXDR(
        signedChallenge,
        getNetworkPassphrase()
      ) as StellarSdk.Transaction;
    } catch (err) {
      logger.debug({ err, stellarAddress }, "Signed challenge envelope failed to decode from XDR");
      throw new UnauthorizedError("Invalid transaction envelope");
    }

    // Verify the source account matches the claimed stellar address
    if (transaction.source !== stellarAddress) {
      throw new UnauthorizedError("Transaction source does not match claimed address");
    }

    // Verify time bounds exist and are valid (required by SEP-10)
    if (!transaction.timeBounds) {
      throw new UnauthorizedError("Transaction missing required time bounds");
    }
    const now = Math.floor(Date.now() / 1000);
    const minTime = parseInt(transaction.timeBounds.minTime, 10);
    const maxTime = parseInt(transaction.timeBounds.maxTime, 10);
    if (maxTime === 0) {
      throw new UnauthorizedError("Transaction missing required time bounds");
    }
    if (now < minTime || now > maxTime) {
      throw new UnauthorizedError("Challenge has expired");
    }

    // Verify the transaction's manageData operation carries the exact nonce
    // this server issued for this address — not merely that some manageData
    // operation with the right name exists. Per SEP-10, the server must
    // verify the challenge transaction matches the one it issued; comparing
    // only the operation name would let any validly-signed transaction with
    // a manageData op named HOME_DOMAIN (a public, guessable constant) pass.
    const submittedNonceOp = transaction.operations.find(
      (op) => op.type === "manageData" && op.name === HOME_DOMAIN
    ) as StellarSdk.Operation.ManageData | undefined;
    if (!submittedNonceOp || !submittedNonceOp.value) {
      throw new UnauthorizedError("Invalid challenge transaction: missing manageData operation");
    }
    const submittedNonce = Buffer.from(submittedNonceOp.value).toString("base64");
    if (!safeEqual(submittedNonce, issuedNonce)) {
      throw new UnauthorizedError("Challenge transaction does not match the issued challenge");
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

    // Find or create user atomically. A plain findFirst + insert is a
    // TOCTOU race: two concurrent registrations for the same address both
    // see no row, both attempt the insert, and the second throws a unique-
    // constraint error (500). ON CONFLICT DO UPDATE makes the upsert atomic
    // so concurrent requests converge on the same row.
    const existingBefore = await db.query.users.findFirst({
      where: eq(users.stellarAddress, stellarAddress),
    });

    const isNewUser = !existingBefore;

    const [user] = await db
      .insert(users)
      .values({ stellarAddress })
      .onConflictDoUpdate({
        target: users.stellarAddress,
        set: { updatedAt: new Date() },
      })
      .returning();

    if (isNewUser) {
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
