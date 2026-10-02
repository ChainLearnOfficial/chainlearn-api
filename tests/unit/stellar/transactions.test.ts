import { describe, it, expect, vi, beforeEach } from "vitest";
import { StellarError } from "../../../src/utils/errors.js";

const VALID_PUBLIC_KEY = "GAXK5L7G7U7YGH4WGONDXK3ZO2RMGET6ANTTSBCN7CNNRWBFUO5NGXAM";
const VALID_CONTRACT_ID = "CAZ7YFMK5FGL3NF2E2NJ3Q7XXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXX";

const { mockSubmitTransaction, mockGetAccount, mockSimulateTransaction, mockInvalidate, mockGetNextSequence, mockContractCall } = vi.hoisted(() => ({
  mockSubmitTransaction: vi.fn(),
  mockGetAccount: vi.fn(),
  mockSimulateTransaction: vi.fn(),
  mockInvalidate: vi.fn(),
  mockGetNextSequence: vi.fn(),
  mockContractCall: vi.fn(),
}));

vi.mock("../../../src/stellar/client.js", () => ({
  stellarClient: {
    submitTransaction: mockSubmitTransaction,
    getAccount: mockGetAccount,
  },
}));

vi.mock("../../../src/stellar/sequence-cache.js", () => ({
  sequenceCache: {
    getNextSequence: mockGetNextSequence,
    invalidate: mockInvalidate,
  },
}));

vi.mock("../../../src/utils/account-lock.js", () => ({
  withAccountLock: vi.fn((_id: string, fn: () => Promise<any>) => fn()),
}));

vi.mock("../../../src/config/stellar.js", () => ({
  getPlatformKeypair: vi.fn(() => ({
    publicKey: () => VALID_PUBLIC_KEY,
    sign: vi.fn(),
  })),
  getNetworkPassphrase: vi.fn(() => "Test SDF Network ; September 2015"),
  getSorobanServer: vi.fn(() => ({
    simulateTransaction: mockSimulateTransaction,
  })),
}));

vi.mock("../../../src/config/index.js", () => ({
  config: {
    STELLAR_QUIZ_CONTRACT_ID: VALID_CONTRACT_ID,
  },
}));

vi.mock("../../../src/utils/logger.js", () => ({
  logger: {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  },
}));

vi.mock("@stellar/stellar-sdk", async () => {
  const actual = await vi.importActual<typeof import("@stellar/stellar-sdk")>("@stellar/stellar-sdk");
  return {
    ...actual,
    Contract: vi.fn().mockImplementation(() => ({
      call: mockContractCall,
    })),
    TransactionBuilder: vi.fn().mockImplementation(() => ({
      addOperation: vi.fn().mockReturnThis(),
      setTimeout: vi.fn().mockReturnThis(),
      build: vi.fn().mockReturnValue({
        sign: vi.fn(),
      }),
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
      Api: {
        isSimulationError: vi.fn().mockReturnValue(false),
      },
      assembleTransaction: vi.fn().mockReturnValue({
        build: vi.fn().mockReturnValue({
          sign: vi.fn(),
        }),
      }),
    },
  };
});

import { invokeContract } from "../../../src/stellar/transactions.js";

describe("invokeContract", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockGetNextSequence.mockResolvedValue("100");
    mockSimulateTransaction.mockResolvedValue({
      transactionData: {},
      results: [],
    });
    mockContractCall.mockReturnValue([]);
  });

  it("should submit a transaction successfully", async () => {
    mockSubmitTransaction.mockResolvedValue({ hash: "abc123" });
    mockSimulateTransaction.mockResolvedValue({
      transactionData: { toXDR: () => "AAAA" },
      results: [{}],
    });

    const result = await invokeContract(VALID_CONTRACT_ID, "method", []);
    expect(result).toBe("abc123");
    expect(mockSubmitTransaction).toHaveBeenCalledTimes(1);
  });

  it("should retry on sequence conflict and invalidate cache", async () => {
    mockSubmitTransaction
      .mockRejectedValueOnce(new StellarError('tx failed: ["tx_bad_seq"]'))
      .mockResolvedValueOnce({ hash: "def456" });

    const result = await invokeContract(VALID_CONTRACT_ID, "method", []);
    expect(result).toBe("def456");
    expect(mockInvalidate).toHaveBeenCalledWith(VALID_PUBLIC_KEY);
    expect(mockSubmitTransaction).toHaveBeenCalledTimes(2);
  });
});