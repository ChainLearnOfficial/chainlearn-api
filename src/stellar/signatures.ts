import * as StellarSdk from "@stellar/stellar-sdk";
import crypto from "node:crypto";
import { getPlatformKeypair } from "../config/stellar.js";
import { logger } from "../utils/logger.js";

/** Maximum age of a signed payload before it is considered stale (5 minutes). */
export const PROOF_TTL_MS = 5 * 60 * 1000;

export interface QuizProof {
  hash: string;
  signature: string;
  nonce: string;
  timestamp: string;
}

export interface MintAuthorization {
  hash: string;
  signature: string;
  nonce: string;
  timestamp: string;
}

/**
 * Generate a signed proof that a user passed a quiz.
 *
 * The payload includes a random nonce and ISO timestamp so the proof is
 * single-use and expires after PROOF_TTL_MS. The on-chain contract must
 * reject proofs whose timestamp is older than the TTL and must track
 * consumed nonces to prevent replay attacks.
 */
export function createQuizProof(
  userAddress: string,
  quizId: string,
  score: number
): QuizProof {
  const nonce = crypto.randomUUID();
  const timestamp = new Date().toISOString();

  const payload = Buffer.from(
    JSON.stringify({ userAddress, quizId, score, nonce, timestamp })
  );

  const hash = crypto.createHash("sha256").update(payload).digest();
  const keypair = getPlatformKeypair();
  const signature = keypair.sign(hash);

  logger.debug({ userAddress, quizId, score, nonce }, "Quiz proof generated");

  return {
    hash: hash.toString("hex"),
    signature: signature.toString("base64"),
    nonce,
    timestamp,
  };
}

/**
 * Create a signed authorization for credential (NFT) minting.
 *
 * Includes a nonce and timestamp to prevent replay attacks. The on-chain
 * contract must enforce that each nonce is consumed at most once and that
 * the timestamp falls within the acceptable TTL window.
 */
export function createMintAuthorization(
  userAddress: string,
  courseId: string,
  score: number
): MintAuthorization {
  const nonce = crypto.randomUUID();
  const timestamp = new Date().toISOString();

  const payload = Buffer.from(
    JSON.stringify({
      action: "mint_credential",
      userAddress,
      courseId,
      score,
      nonce,
      timestamp,
    })
  );

  const hash = crypto.createHash("sha256").update(payload).digest();
  const keypair = getPlatformKeypair();
  const signature = keypair.sign(hash);

  return {
    hash: hash.toString("hex"),
    signature: signature.toString("base64"),
    nonce,
    timestamp,
  };
}
