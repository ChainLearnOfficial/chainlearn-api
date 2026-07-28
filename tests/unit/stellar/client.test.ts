import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("../../../src/config/stellar.js", () => ({
  getHorizonServer: vi.fn(() => mockHorizon),
  getSorobanServer: vi.fn(() => mockSoroban),
  getNetworkPassphrase: vi.fn(() => "Test SDF Network ; September 2015"),
}));

vi.mock("../../../src/utils/logger.js", () => ({
  logger: { info: vi.fn(), error: vi.fn(), warn: vi.fn(), debug: vi.fn() },
}));

vi.mock("../../../src/stellar/resilience.js", () => ({
  stellarRetry: {
    execute: vi.fn((fn) => fn()),
  },
  circuitBreakerExecute: vi.fn((fn) => fn()),
  withTimeout: vi.fn((promise) => promise),
}));

const mockHorizon = {
  loadAccount: vi.fn(),
  submitTransaction: vi.fn(),
};

const mockSoroban = {};

import { StellarClient } from "../../../src/stellar/client.js";
import { StellarError } from "../../../src/utils/errors.js";

describe("StellarClient", () => {
  let client: StellarClient;

  beforeEach(() => {
    vi.clearAllMocks();
    client = new StellarClient();
  });

  describe("getAccount", () => {
    it("should load account successfully", async () => {
      const mockAccount = { id: "GABC123", sequence: "12345" };
      mockHorizon.loadAccount.mockResolvedValue(mockAccount);

      const result = await client.getAccount("GABC123");

      expect(result).toEqual(mockAccount);
      expect(mockHorizon.loadAccount).toHaveBeenCalledWith("GABC123");
    });

    it("should throw StellarError when account not found", async () => {
      mockHorizon.loadAccount.mockRejectedValue(new Error("Not found"));

      await expect(client.getAccount("GINVALID")).rejects.toThrow(StellarError);
    });
  });

  describe("submitTransaction", () => {
    it("should submit transaction successfully", async () => {
      const mockTx = { sign: vi.fn() } as any;
      const mockResponse = { hash: "tx-hash-abc", successful: true };
      mockHorizon.submitTransaction.mockResolvedValue(mockResponse);

      const result = await client.submitTransaction(mockTx);

      expect(result).toEqual(mockResponse);
      expect(mockHorizon.submitTransaction).toHaveBeenCalledWith(mockTx);
    });

    it("should throw StellarError on transaction failure", async () => {
      const mockTx = { sign: vi.fn() } as any;
      const error = {
        response: {
          data: {
            extras: {
              result_codes: { transaction: "tx_failed" },
              envelope_xdr: "xdr-data",
            },
          },
        },
      };
      mockHorizon.submitTransaction.mockRejectedValue(error);

      await expect(client.submitTransaction(mockTx)).rejects.toThrow(StellarError);
    });
  });
});
