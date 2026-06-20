import crypto from "node:crypto";
import { getPlatformKeypair } from "../config/stellar.js";
import { logger } from "../utils/logger.js";

function hashPayload(payload: Record<string, unknown>): Buffer {
  return crypto.createHash("sha256").update(JSON.stringify(payload)).digest();
}

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
  const hash = hashPayload({ userAddress, quizId, score });
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
    const keypair = getPlatformKeypair();
    const hashBuffer = Buffer.from(hash, "hex");
    const expectedHash = hashPayload({ userAddress, quizId, score });

    if (!crypto.timingSafeEqual(hashBuffer, expectedHash)) {
      return false;
    }

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
  const hash = hashPayload({
    action: "mint_credential",
    userAddress,
    courseId,
    score,
  });
  const keypair = getPlatformKeypair();
  const signature = keypair.sign(hash);

  return {
    hash: hash.toString("hex"),
    signature: signature.toString("base64"),
  };
}
