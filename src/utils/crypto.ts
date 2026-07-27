import crypto from "node:crypto";

/**
 * Hash data for on-chain content references.
 */
export function sha256Hash(data: string): string {
  return crypto.createHash("sha256").update(data).digest("hex");
}
