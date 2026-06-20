import { describe, expect, it, vi } from "vitest";
import * as StellarSdk from "@stellar/stellar-sdk";

const platformKeypair = StellarSdk.Keypair.random();

vi.mock("../../../src/config/stellar.js", () => ({
  getPlatformKeypair: () => platformKeypair,
}));

vi.mock("../../../src/utils/logger.js", () => ({
  logger: {
    debug: vi.fn(),
    warn: vi.fn(),
  },
}));

import {
  createMintAuthorization,
  createQuizProof,
  verifyQuizProof,
} from "../../../src/stellar/signatures.js";

describe("stellar signatures", () => {
  it("creates deterministic quiz proofs for the same arguments", () => {
    const first = createQuizProof("GUSER", "quiz-1", 4);
    const second = createQuizProof("GUSER", "quiz-1", 4);

    expect(second).toEqual(first);
  });

  it("verifies quiz proofs against the reconstructed deterministic payload", () => {
    const proof = createQuizProof("GUSER", "quiz-1", 4);

    expect(
      verifyQuizProof("GUSER", "quiz-1", 4, proof.hash, proof.signature)
    ).toBe(true);
    expect(
      verifyQuizProof("GUSER", "quiz-2", 4, proof.hash, proof.signature)
    ).toBe(false);
    expect(
      verifyQuizProof("GUSER", "quiz-1", 3, proof.hash, proof.signature)
    ).toBe(false);
  });

  it("rejects quiz proofs with a mismatched hash", () => {
    const proof = createQuizProof("GUSER", "quiz-1", 4);
    const otherProof = createQuizProof("GUSER", "quiz-1", 5);

    expect(
      verifyQuizProof("GUSER", "quiz-1", 4, otherProof.hash, proof.signature)
    ).toBe(false);
  });

  it("creates deterministic mint authorizations for the same arguments", () => {
    const first = createMintAuthorization("GUSER", "course-1", 4);
    const second = createMintAuthorization("GUSER", "course-1", 4);

    expect(second).toEqual(first);
  });
});
