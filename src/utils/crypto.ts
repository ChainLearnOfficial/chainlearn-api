import * as StellarSdk from "@stellar/stellar-sdk";
import { getPlatformKeypair, getNetworkPassphrase } from "../config/stellar.js";
import crypto from "node:crypto";

/**
 * Sign an arbitrary message hash with the platform keypair.
 * Used for quiz proof signatures and reward authorization.
 */
export function signWithPlatformKey(message: Buffer): string {
  const keypair = getPlatformKeypair();
  return keypair.sign(message).toString("base64");
}

/**
 * Verify a Stellar signature against a public key.
 */
export function verifyStellarSignature(
  message: Buffer,
  signature: string,
  publicKey: string
): boolean {
  try {
    const keypair = StellarSdk.Keypair.fromPublicKey(publicKey);
    return keypair.verify(message, Buffer.from(signature, "base64"));
  } catch {
    return false;
  }
}

/**
 * Generate a deterministic challenge token for SEP-10 auth.
 */
export function generateChallengeToken(account: string): string {
  const nonce = crypto.randomBytes(32).toString("base64");
  const timestamp = Date.now();
  return JSON.stringify({ account, nonce, timestamp });
}

/**
 * Hash data for on-chain content references.
 */
export function sha256Hash(data: string): string {
  return crypto.createHash("sha256").update(data).digest("hex");
}
