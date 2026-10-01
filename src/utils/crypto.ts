import crypto from "node:crypto";

/**
 * Hash data for on-chain content references.
 */
export function sha256Hash(data: string): string {
  return crypto.createHash("sha256").update(data).digest("hex");
}

/**
 * Constant-time string comparison to prevent timing side-channel attacks.
 * Uses crypto.timingSafeEqual internally; pads the shorter buffer so both
 * are the same length (required by the Node.js API).
 */
export function safeEqual(a: string, b: string): boolean {
  const bufA = Buffer.from(a);
  const bufB = Buffer.from(b);
  if (bufA.length !== bufB.length) {
    // Pad the shorter buffer to match the longer one so timingSafeEqual
    // doesn't throw. The length mismatch itself is not secret — an
    // attacker learns nothing from it that they couldn't already see by
    // comparing the strings directly.
    const padded = Buffer.alloc(Math.max(bufA.length, bufB.length));
    bufA.copy(padded);
    const paddedB = Buffer.alloc(padded.length);
    bufB.copy(paddedB);
    return crypto.timingSafeEqual(padded, paddedB);
  }
  return crypto.timingSafeEqual(bufA, bufB);
}
