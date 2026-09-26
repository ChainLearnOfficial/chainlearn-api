import { describe, it, expect } from "vitest";
import {
  buildCertificateDownloadUrl,
  buildVerificationUrl,
} from "../../../src/modules/credentials/certificate.js";

describe("certificate URLs", () => {
  it("links the mint transaction on the matching explorer network", () => {
    expect(buildVerificationUrl("testnet", "abc")).toBe(
      "https://stellar.expert/explorer/testnet/tx/abc",
    );
    expect(buildVerificationUrl("mainnet", "abc")).toBe(
      "https://stellar.expert/explorer/public/tx/abc",
    );
  });

  it("has no verification URL without a mint transaction", () => {
    expect(buildVerificationUrl("testnet", null)).toBeNull();
  });

  it("builds an absolute download URL when a public base URL is configured", () => {
    expect(buildCertificateDownloadUrl("https://api.example.com/", "id-1")).toBe(
      "https://api.example.com/api/v1/credentials/id-1/certificate",
    );
  });

  it("builds a root-relative download URL otherwise", () => {
    expect(buildCertificateDownloadUrl(undefined, "id-1")).toBe(
      "/api/v1/credentials/id-1/certificate",
    );
  });
});
