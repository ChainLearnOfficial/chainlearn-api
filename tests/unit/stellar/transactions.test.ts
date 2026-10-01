import { describe, it, expect, vi, beforeEach } from "vitest";

const VALID_PUBLIC_KEY = "GBZXN7PIRZGNMHGA7MUQZM7GIMH2ILRNSP7K7IIPQ5RQB2CHEMYFQ7S";

const { mockKeypair, mockContract, mockTx, mockSimResult } = vi.hoisted(() => {
  const mockTx = {
    sign: vi.fn(),
  };
  const mockContract = {
    call: vi.fn().mockReturnValue({ type: "invokeHostFunction" }),
  };
  const mockSimResult = {
    transactionData: { build: () => ({}) },
    results: [],
  };
  return {
    mockKeypair: {
      publicKey: vi.fn().mockReturnValue("GBZXN7PIRZGNMHGA7MUQZM7GIMH2ILRNSP7K7IIPQ5RQB2CHEMYFQ7S"),
      sign: vi.fn(),
      secret: vi.fn().mockReturnValue("SCZANGBA5YHTNYVVV7C3QHFGBF5WXV2OYXBKDFFDGTPCCPGF7Q7S5YJ4"),
    },
    mockContract,
    mockTx,
    mockSimResult,
  };
});

vi.mock("@stellar/stellar-sdk", async () => {
  const actual = await vi.importActual<typeof import("@stellar/stellar-sdk")>("@stellar/stellar-sdk");
  return {
    ...actual,
    Contract: vi.fn().mockImplementation(() => mockContract),
    TransactionBuilder: vi.fn().mockImplementation(() => ({
      addOperation: vi.fn().mockReturnThis(),
      setTimeout: vi.fn().mockReturnThis(),
      build: vi.fn().mockReturnValue(mockTx),
    })),
    Account: vi.fn(),
    BASE_FEE: "100",
    Operation: {
      payment: vi.fn(),
    },
    Asset: {
      native: vi.fn(),
    },
    rpc: {
      ...actual.rpc,
      Api: {
        isSimulationError: vi.fn().mockReturnValue(false),
      },
      assembleTransaction: vi.fn().mockReturnValue({
        build: vi.fn().mockReturnValue(mockTx),
      }),
    },
  };
});

vi.mock("../../../src/config/stellar.js", () => ({
  getPlatformKeypair: vi.fn().mockReturnValue(mockKeypair),
  getNetworkPassphrase: vi.fn().mockReturnValue("Test SDF Network ; September 2015"),
  getSorobanServer: vi.fn().mockReturnValue({
    simulateTransaction: vi.fn().mockResolvedValue(mockSimResult),
  }),
}));

vi.mock("../../../src/config/index.js", () => ({
  config: {
    STELLAR_NETWORK: "testnet",
  },
}));

vi.mock("../../../src/stellar/client.js", () => ({
  stellarClient: {
    getAccount: vi.fn(),
    submitTransaction: vi.fn(),
  },
}));

vi.mock("../../../src/stellar/sequence-cache.js", () => ({
  sequenceCache: {
    getNextSequence: vi.fn(),
    invalidate: vi.fn(),
  },
}));

vi.mock("../../../src/utils/account-lock.js", () => ({
  withAccountLock: vi.fn((_id: string, fn: () => Promise<any>) => fn()),
}));

vi.mock("../../../src/utils/logger.js", () => ({
  logger: { info: vi.fn(), error: vi.fn(), warn: vi.fn() },
}));

import StellarSdk from "@stellar/stellar-sdk";
import { invokeContract } from "../../../src/stellar/transactions.js";
import { stellarClient } from "../../../src/stellar/client.js";
import { sequenceCache } from "../../../src/stellar/sequence-cache.js";
import { StellarError } from "../../../src/utils/errors.js";

describe("invokeContract", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("should build and submit a transaction successfully", async () => {
    vi.mocked(sequenceCache.getNextSequence).mockResolvedValue("100");
    vi.mocked(stellarClient.submitTransaction).mockResolvedValue({
      hash: "abc123",
    } as any);

    const contractId = "CAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA234";
    const args = [StellarSdk.nativeToScVal("test", { type: "string" })];
    const result = await invokeContract(contractId, "my_method", args);

    expect(result).toBe("abc123");
    expect(sequenceCache.getNextSequence).toHaveBeenCalledWith(VALID_PUBLIC_KEY);
    expect(stellarClient.submitTransaction).toHaveBeenCalledTimes(1);
  });

  it("should retry on tx_bad_seq and invalidate cache", async () => {
    vi.mocked(sequenceCache.getNextSequence)
      .mockResolvedValueOnce("100")
      .mockResolvedValueOnce("101");

    vi.mocked(stellarClient.submitTransaction)
      .mockRejectedValueOnce(new StellarError("tx failed: [\"tx_bad_seq\"]"))
      .mockResolvedValueOnce({ hash: "def456" } as any);

    const contractId = "CAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA234";
    const args = [StellarSdk.nativeToScVal("test", { type: "string" })];
    const result = await invokeContract(contractId, "my_method", args);

    expect(result).toBe("def456");
    expect(sequenceCache.invalidate).toHaveBeenCalledWith(VALID_PUBLIC_KEY);
    expect(sequenceCache.getNextSequence).toHaveBeenCalledTimes(2);
  });
});