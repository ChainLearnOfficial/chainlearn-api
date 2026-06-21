import * as StellarSdk from "@stellar/stellar-sdk";
import crypto from "node:crypto";

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
 * Hash data for on-chain content references.
 */
export function sha256Hash(data: string): string {
  return crypto.createHash("sha256").update(data).digest("hex");
}
