import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("../../../src/config/stellar.js", () => ({
  getPlatformKeypair: vi.fn(() => mockKeypair),
  getNetworkPassphrase: vi.fn(() => "Test SDF Network ; September 2015"),
  getSorobanServer: vi.fn(() => mockSoroban),
}));

vi.mock("../../../src/config/index.js", () => ({
  config: {},
}));

vi.mock("../../../src/stellar/client.js", () => ({
  stellarClient: {
    submitTransaction: vi.fn(),
  },
}));

vi.mock("../../../src/utils/logger.js", () => ({
  logger: { info: vi.fn(), error: vi.fn(), warn: vi.fn(), debug: vi.fn() },
}));

vi.mock("../../../src/stellar/sequence-cache.js", () => ({
  sequenceCache: {
    getNextSequence: vi.fn(),
    invalidate: vi.fn(),
  },
}));

vi.mock("../../../src/utils/account-lock.js", () => ({
  withAccountLock: vi.fn((publicKey, fn) => fn()),
}));

vi.mock("@stellar/stellar-sdk", async () => {
  const actual = await vi.importActual("@stellar/stellar-sdk");
  return {
    ...actual,
    rpc: {
      Api: {
        isSimulationError: vi.fn(),
      },
      assembleTransaction: vi.fn((tx) => tx),
    },
  };
});

const mockKeypair = {
  publicKey: vi.fn(() => "GPLATFORM7ACNYQDROXIYWD3FJRQXRJCQMZXFUH7HZPXVZKZMN4F2PYQE"),
  sign: vi.fn(),
};

const mockSoroban = {
  simulateTransaction: vi.fn(),
};

import { invokeContract } from "../../../src/stellar/transactions.js";
import { stellarClient } from "../../../src/stellar/client.js";
import { sequenceCache } from "../../../src/stellar/sequence-cache.js";
import * as StellarSdk from "@stellar/stellar-sdk";

describe("Stellar Transactions", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe("invokeContract", () => {
    it("should invoke contract successfully", async () => {
      sequenceCache.getNextSequence = vi.fn().mockResolvedValue("100");
      mockSoroban.simulateTransaction.mockResolvedValue({
        results: [{ xdr: "result" }],
      });
      StellarSdk.rpc.Api.isSimulationError = vi.fn().mockReturnValue(false);
      stellarClient.submitTransaction = vi.fn().mockResolvedValue({ hash: "tx-hash" });

      const validContractId = "CDLZFC3SYJYDZT7K67VZ75HPJVIEUVNIXF47ZG2FB2RMQQVU2HHGCYSC";
      const result = await invokeContract(validContractId, "method_name", []);

      expect(result).toBe("tx-hash");
      expect(stellarClient.submitTransaction).toHaveBeenCalled();
    });

    it("should retry on sequence number conflict", async () => {
      let attempts = 0;
      sequenceCache.getNextSequence = vi.fn().mockResolvedValue("100");
      mockSoroban.simulateTransaction.mockResolvedValue({
        results: [{ xdr: "result" }],
      });
      StellarSdk.rpc.Api.isSimulationError = vi.fn().mockReturnValue(false);
      
      stellarClient.submitTransaction = vi.fn().mockImplementation(() => {
        attempts++;
        if (attempts === 1) {
          const error: any = new Error("Tx failed: bad_seq");
          error.message = "bad_seq";
          throw error;
        }
        return Promise.resolve({ hash: "tx-hash-retry" });
      });

      const validContractId = "CDLZFC3SYJYDZT7K67VZ75HPJVIEUVNIXF47ZG2FB2RMQQVU2HHGCYSC";
      const result = await invokeContract(validContractId, "method_name", []);

      expect(result).toBe("tx-hash-retry");
      expect(sequenceCache.invalidate).toHaveBeenCalled();
      expect(attempts).toBe(2);
    });
  });
});
