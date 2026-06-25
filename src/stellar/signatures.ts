import * as StellarSdk from "@stellar/stellar-sdk";
import crypto from "node:crypto";
import { getPlatformKeypair } from "../config/stellar.js";
import { logger } from "../utils/logger.js";

/**
 * Generate a signed proof that a user passed a quiz.
 * The platform signs (userAddress + quizId + score) so the on-chain
 * contract can verify the reward claim without trusting the client.
 */
export function createQuizProof(
  userAddress: string,
  quizId: string,
  score: number
): { hash: string; signature: string } {
  const payload = Buffer.from(
    JSON.stringify({ userAddress, quizId, score })
  );

  const hash = crypto.createHash("sha256").update(payload).digest();
  const keypair = getPlatformKeypair();
  const signature = keypair.sign(hash);

  logger.debug({ userAddress, quizId, score }, "Quiz proof generated");

  return {
    hash: hash.toString("hex"),
    signature: signature.toString("base64"),
  };
}

/**
 * Verify a quiz proof signature (for server-side double-check).
 */
export function verifyQuizProof(
  userAddress: string,
  quizId: string,
  score: number,
  hash: string,
  signature: string
): boolean {
  try {
    const expectedPayload = Buffer.from(
      JSON.stringify({ userAddress, quizId, score })
    );
    const expectedHash = crypto.createHash("sha256").update(expectedPayload).digest("hex");

    if (hash !== expectedHash) {
      logger.warn({ quizId, provided: hash, expected: expectedHash }, "Quiz proof hash mismatch");
      return false;
    }

    const keypair = getPlatformKeypair();
    const hashBuffer = Buffer.from(hash, "hex");
    return keypair.verify(hashBuffer, Buffer.from(signature, "base64"));
  } catch (err) {
    logger.warn({ err, quizId }, "Quiz proof verification failed");
    return false;
  }
}

/**
 * Create a signed authorization for credential (NFT) minting.
 */
export function createMintAuthorization(
  userAddress: string,
  courseId: string,
  score: number
): { hash: string; signature: string } {
  const payload = Buffer.from(
    JSON.stringify({
      action: "mint_credential",
      userAddress,
      courseId,
      score,
      timestamp: Date.now(),
    })
  );

  const hash = crypto.createHash("sha256").update(payload).digest();
  const keypair = getPlatformKeypair();
  const signature = keypair.sign(hash);

  return {
    hash: hash.toString("hex"),
    signature: signature.toString("base64"),
  };
}
