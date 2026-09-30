/**
 * URLs for a user's certificates (#371).
 *
 * Verification points at the mint transaction on the public Stellar explorer,
 * which anyone can open to confirm the credential was issued on-chain. The
 * download URL is this API's own certificate document endpoint; it is absolute
 * when PUBLIC_BASE_URL is configured and a root-relative path otherwise.
 */

export function buildVerificationUrl(
  network: "testnet" | "mainnet",
  mintTxHash: string | null,
): string | null {
  if (!mintTxHash) return null;
  const explorerNetwork = network === "mainnet" ? "public" : "testnet";
  return `https://stellar.expert/explorer/${explorerNetwork}/tx/${mintTxHash}`;
}

export function buildCertificateDownloadUrl(
  publicBaseUrl: string | undefined,
  credentialId: string,
): string {
  const base = publicBaseUrl?.replace(/\/$/, "") ?? "";
  return `${base}/api/v1/credentials/${credentialId}/certificate`;
}
