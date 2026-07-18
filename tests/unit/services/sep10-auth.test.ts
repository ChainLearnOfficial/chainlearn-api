import { describe, it, expect, vi, beforeEach } from "vitest";
import * as StellarSdk from "@stellar/stellar-sdk";

vi.mock("ioredis", () => ({
  default: vi.fn().mockImplementation(() => ({
    setex: vi.fn(),
    get: vi.fn(),
    del: vi.fn(),
    exists: vi.fn(),
  })),
}));

vi.mock("../../../src/config/redis.js", () => ({
  redis: {
    setex: vi.fn(),
    get: vi.fn(),
    del: vi.fn(),
    exists: vi.fn(),
  },
}));

vi.mock("../../../src/config/database.js", () => {
  const mockDb = {
    query: {
      users: {
        findFirst: vi.fn(),
      },
    },
    insert: vi.fn(),
  };
  return { db: mockDb };
});

vi.mock("../../../src/config/stellar.js", () => ({
  getNetworkPassphrase: vi.fn().mockReturnValue(StellarSdk.Networks.TESTNET),
  getPlatformKeypair: vi.fn(),
}));

vi.mock("../../../src/utils/logger.js", () => ({
  logger: { info: vi.fn(), error: vi.fn(), warn: vi.fn() },
}));

import { authService } from "../../../src/modules/auth/auth.service.js";
import { db } from "../../../src/config/database.js";
import { redis } from "../../../src/config/redis.js";

const mockDb = vi.mocked(db);
const mockRedis = vi.mocked(redis);

describe("AuthService - SEP-10 Verification", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe("createChallenge", () => {
    it("should create a SEP-10 challenge transaction", async () => {
      const keypair = StellarSdk.Keypair.random();
      const stellarAddress = keypair.publicKey();

      const result = await authService.createChallenge(stellarAddress);

      expect(result.challenge).toBeDefined();
      expect(result.networkPassphrase).toBe(StellarSdk.Networks.TESTNET);
      expect(mockRedis.setex).toHaveBeenCalledWith(
        `sep10:challenge:${stellarAddress}`,
        300,
        expect.any(String)
      );
    });
  });

  describe("verifyChallenge", () => {
    it("should reject when no challenge exists in Redis", async () => {
      const stellarAddress =
        "GALICE0000000000000000000000000000000000000000000000000000000";
      mockRedis.exists.mockResolvedValue(0);

      await expect(
        authService.verifyChallenge(stellarAddress, "some-signed-challenge")
      ).rejects.toThrow("Challenge expired or not found");
    });

    it("should reject invalid transaction envelope", async () => {
      const stellarAddress =
        "GALICE0000000000000000000000000000000000000000000000000000000";
      mockRedis.exists.mockResolvedValue(1);

      await expect(
        authService.verifyChallenge(stellarAddress, "invalid-xdr-data")
      ).rejects.toThrow("Invalid transaction envelope");
    });

    it("should reject when transaction source does not match claimed address", async () => {
      const keypair = StellarSdk.Keypair.random();
      const stellarAddress = keypair.publicKey();
      const differentKeypair = StellarSdk.Keypair.random();
      const differentAddress = differentKeypair.publicKey();

      mockRedis.exists.mockResolvedValue(1);

      const account = new StellarSdk.Account(differentAddress, "0");
      const transaction = new StellarSdk.TransactionBuilder(account, {
        fee: StellarSdk.BASE_FEE,
        networkPassphrase: StellarSdk.Networks.TESTNET,
      })
        .addOperation(
          StellarSdk.Operation.manageData({
            name: "chainlearn.io",
            value: "test-nonce",
          })
        )
        .setTimeout(300)
        .build();

      transaction.sign(differentKeypair);
      const signedXdr = transaction.toEnvelope().toXDR("base64");

      await expect(
        authService.verifyChallenge(stellarAddress, signedXdr)
      ).rejects.toThrow("Transaction source does not match claimed address");
    });

    it("should reject when challenge has expired", async () => {
      const keypair = StellarSdk.Keypair.random();
      const stellarAddress = keypair.publicKey();

      mockRedis.exists.mockResolvedValue(1);

      const account = new StellarSdk.Account(stellarAddress, "0");
      const transaction = new StellarSdk.TransactionBuilder(account, {
        fee: StellarSdk.BASE_FEE,
        networkPassphrase: StellarSdk.Networks.TESTNET,
      })
        .addOperation(
          StellarSdk.Operation.manageData({
            name: "chainlearn.io",
            value: "test-nonce",
          })
        )
        .setTimebounds(
          Math.floor(Date.now() / 1000) - 600,
          Math.floor(Date.now() / 1000) - 300
        )
        .build();

      transaction.sign(keypair);
      const signedXdr = transaction.toEnvelope().toXDR("base64");

      await expect(
        authService.verifyChallenge(stellarAddress, signedXdr)
      ).rejects.toThrow("Challenge has expired");
    });

    it("should reject when transaction has no time bounds", async () => {
      const keypair = StellarSdk.Keypair.random();
      const stellarAddress = keypair.publicKey();

      mockRedis.exists.mockResolvedValue(1);

      const account = new StellarSdk.Account(stellarAddress, "0");
      const transaction = new StellarSdk.TransactionBuilder(account, {
        fee: StellarSdk.BASE_FEE,
        networkPassphrase: StellarSdk.Networks.TESTNET,
      })
        .addOperation(
          StellarSdk.Operation.manageData({
            name: "chainlearn.io",
            value: "test-nonce",
          })
        )
        .setTimeout(StellarSdk.TimeoutInfinite)
        .build();

      transaction.sign(keypair);
      const signedXdr = transaction.toEnvelope().toXDR("base64");

      await expect(
        authService.verifyChallenge(stellarAddress, signedXdr)
      ).rejects.toThrow("Transaction missing required time bounds");
    });

    it("should reject when transaction lacks expected manageData operation", async () => {
      const keypair = StellarSdk.Keypair.random();
      const stellarAddress = keypair.publicKey();

      mockRedis.exists.mockResolvedValue(1);

      const account = new StellarSdk.Account(stellarAddress, "0");
      const transaction = new StellarSdk.TransactionBuilder(account, {
        fee: StellarSdk.BASE_FEE,
        networkPassphrase: StellarSdk.Networks.TESTNET,
      })
        .addOperation(
          StellarSdk.Operation.manageData({
            name: "wrong_operation_name",
            value: "test-nonce",
          })
        )
        .setTimeout(300)
        .build();

      transaction.sign(keypair);
      const signedXdr = transaction.toEnvelope().toXDR("base64");

      await expect(
        authService.verifyChallenge(stellarAddress, signedXdr)
      ).rejects.toThrow("Invalid challenge transaction: missing manageData operation");
    });

    it("should reject when signature is invalid", async () => {
      const keypair = StellarSdk.Keypair.random();
      const stellarAddress = keypair.publicKey();

      mockRedis.exists.mockResolvedValue(1);

      const account = new StellarSdk.Account(stellarAddress, "0");
      const transaction = new StellarSdk.TransactionBuilder(account, {
        fee: StellarSdk.BASE_FEE,
        networkPassphrase: StellarSdk.Networks.TESTNET,
      })
        .addOperation(
          StellarSdk.Operation.manageData({
            name: "chainlearn.io",
            value: "test-nonce",
          })
        )
        .setTimeout(300)
        .build();

      const wrongKeypair = StellarSdk.Keypair.random();
      transaction.sign(wrongKeypair);
      const signedXdr = transaction.toEnvelope().toXDR("base64");

      await expect(
        authService.verifyChallenge(stellarAddress, signedXdr)
      ).rejects.toThrow("Invalid signature");
    });

    it("should accept valid signed challenge and create new user", async () => {
      const keypair = StellarSdk.Keypair.random();
      const stellarAddress = keypair.publicKey();

      mockRedis.exists.mockResolvedValue(1);
      mockRedis.del.mockResolvedValue(1);

      mockDb.query.users.findFirst.mockResolvedValue(null);
      mockDb.insert.mockReturnValue({
        values: vi.fn().mockReturnValue({
          returning: vi.fn().mockResolvedValue([
            {
              id: "user-1",
              stellarAddress,
              displayName: null,
            },
          ]),
        }),
      });

      const account = new StellarSdk.Account(stellarAddress, "0");
      const transaction = new StellarSdk.TransactionBuilder(account, {
        fee: StellarSdk.BASE_FEE,
        networkPassphrase: StellarSdk.Networks.TESTNET,
      })
        .addOperation(
          StellarSdk.Operation.manageData({
            name: "chainlearn.io",
            value: "test-nonce",
          })
        )
        .setTimeout(300)
        .build();

      transaction.sign(keypair);
      const signedXdr = transaction.toEnvelope().toXDR("base64");

      const result = await authService.verifyChallenge(
        stellarAddress,
        signedXdr
      );

      expect(result.user.id).toBe("user-1");
      expect(result.user.stellarAddress).toBe(stellarAddress);
      expect(result.user.isNewUser).toBe(true);
      expect(mockRedis.del).toHaveBeenCalledWith(
        `sep10:challenge:${stellarAddress}`
      );
    });

    it("should accept valid signed challenge and find existing user", async () => {
      const keypair = StellarSdk.Keypair.random();
      const stellarAddress = keypair.publicKey();

      mockRedis.exists.mockResolvedValue(1);
      mockRedis.del.mockResolvedValue(1);

      mockDb.query.users.findFirst.mockResolvedValue({
        id: "existing-user",
        stellarAddress,
        displayName: "Test User",
      });

      const account = new StellarSdk.Account(stellarAddress, "0");
      const transaction = new StellarSdk.TransactionBuilder(account, {
        fee: StellarSdk.BASE_FEE,
        networkPassphrase: StellarSdk.Networks.TESTNET,
      })
        .addOperation(
          StellarSdk.Operation.manageData({
            name: "chainlearn.io",
            value: "test-nonce",
          })
        )
        .setTimeout(300)
        .build();

      transaction.sign(keypair);
      const signedXdr = transaction.toEnvelope().toXDR("base64");

      const result = await authService.verifyChallenge(
        stellarAddress,
        signedXdr
      );

      expect(result.user.id).toBe("existing-user");
      expect(result.user.displayName).toBe("Test User");
      expect(result.user.isNewUser).toBe(false);
      expect(mockDb.insert).not.toHaveBeenCalled();
    });
  });
});
