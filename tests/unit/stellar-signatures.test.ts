import * as StellarSdk from "@stellar/stellar-sdk";
import { describe, expect, it, vi } from "vitest";

const platformKeypair = StellarSdk.Keypair.random();

vi.mock("../../src/config/stellar.js", () => ({
  getPlatformKeypair: () => platformKeypair,
}));

const {
  createMintAuthorization,
  createQuizProof,
  verifyQuizProof,
} = await import("../../src/stellar/signatures.js");

describe("Stellar signatures", () => {
  it("creates deterministic quiz proof hashes for identical inputs", () => {
    const first = createQuizProof("GUSER", "quiz-1", 9);
    const second = createQuizProof("GUSER", "quiz-1", 9);

    expect(second.hash).toBe(first.hash);
    expect(second.signature).toBe(first.signature);
  });

  it("verifies quiz proof against the original payload arguments", () => {
    const proof = createQuizProof("GUSER", "quiz-1", 9);

    expect(
      verifyQuizProof("GUSER", "quiz-1", 9, proof.hash, proof.signature)
    ).toBe(true);
  });

  it("rejects a quiz proof when payload arguments do not match the hash", () => {
    const proof = createQuizProof("GUSER", "quiz-1", 9);

    expect(
      verifyQuizProof("GOTHER", "quiz-1", 9, proof.hash, proof.signature)
    ).toBe(false);
    expect(
      verifyQuizProof("GUSER", "quiz-2", 9, proof.hash, proof.signature)
    ).toBe(false);
    expect(
      verifyQuizProof("GUSER", "quiz-1", 8, proof.hash, proof.signature)
    ).toBe(false);
  });

  it("creates deterministic mint authorization hashes for identical inputs", () => {
    const first = createMintAuthorization("GUSER", "course-1", 9);
    const second = createMintAuthorization("GUSER", "course-1", 9);

    expect(second.hash).toBe(first.hash);
    expect(second.signature).toBe(first.signature);
  });
});
