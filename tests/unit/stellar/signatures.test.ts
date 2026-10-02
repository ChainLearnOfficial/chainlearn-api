import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("../../../src/config/stellar.js", () => ({
  getPlatformKeypair: vi.fn(() => mockKeypair),
}));

vi.mock("../../../src/utils/logger.js", () => ({
  logger: { info: vi.fn(), error: vi.fn(), warn: vi.fn(), debug: vi.fn() },
}));

const mockKeypair = {
  sign: vi.fn((data) => Buffer.from("mock-signature")),
};

import { createQuizProof, createMintAuthorization } from "../../../src/stellar/signatures.js";

describe("Stellar Signatures", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe("createQuizProof", () => {
    it("should create a valid quiz proof", () => {
      const proof = createQuizProof("GUSER123", "quiz-1", 85);

      expect(proof).toHaveProperty("hash");
      expect(proof).toHaveProperty("signature");
      expect(typeof proof.hash).toBe("string");
      expect(typeof proof.signature).toBe("string");
      expect(mockKeypair.sign).toHaveBeenCalled();
    });

    it("should create different proofs for different inputs", () => {
      const proof1 = createQuizProof("GUSER123", "quiz-1", 85);
      const proof2 = createQuizProof("GUSER456", "quiz-1", 85);

      expect(proof1.hash).not.toBe(proof2.hash);
    });
  });

  describe("createMintAuthorization", () => {
    it("should create a valid mint authorization", () => {
      const auth = createMintAuthorization("GUSER123", "course-1", 90);

      expect(auth).toHaveProperty("hash");
      expect(auth).toHaveProperty("signature");
      expect(typeof auth.hash).toBe("string");
      expect(typeof auth.signature).toBe("string");
      expect(mockKeypair.sign).toHaveBeenCalled();
    });
  });
});
