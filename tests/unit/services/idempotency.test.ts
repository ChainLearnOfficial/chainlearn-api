import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("../../../src/config/database.js", () => {
  const mockDb = {
    query: {
      idempotencyKeys: {
        findFirst: vi.fn(),
      },
    },
    insert: vi.fn(),
    update: vi.fn(),
    delete: vi.fn(),
  };
  return { db: mockDb };
});

vi.mock("../../../src/utils/logger.js", () => ({
  logger: { info: vi.fn(), error: vi.fn(), warn: vi.fn() },
}));

import { db } from "../../../src/config/database.js";
import {
  checkIdempotency,
  storeIdempotentResponse,
  cleanupIdempotencyKeys,
} from "../../../src/middleware/idempotency.js";

const mockDb = vi.mocked(db);

function makeChainable(result: unknown) {
  const chain: Record<string, unknown> = {};
  chain.then = (resolve: Function, reject: Function) =>
    Promise.resolve(result).then(resolve, reject);
  chain.where = vi.fn().mockReturnValue(chain);
  chain.set = vi.fn().mockReturnValue(chain);
  chain.values = vi.fn().mockReturnValue(chain);
  chain.returning = vi.fn().mockResolvedValue(result);
  return chain;
}

describe("Idempotency Middleware", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe("checkIdempotency", () => {
    it("should return cached=true when key exists with same request hash and response", async () => {
      const existingRecord = {
        key: "test-key-1234567890",
        requestHash: "abc123",
        responseBody: { success: true, data: { id: "1" } },
        responseStatus: 200,
      };

      vi.mocked(mockDb.query.idempotencyKeys.findFirst).mockResolvedValue(
        existingRecord as any
      );

      const sha256Hash = (await import("../../../src/utils/crypto.js")).sha256Hash;
      const requestBody = { submissionId: "sub-1" };
      const expectedHash = sha256Hash(JSON.stringify(requestBody));

      existingRecord.requestHash = expectedHash;

      const result = await checkIdempotency(
        "test-key-1234567890",
        "user-1",
        "/rewards/claim",
        requestBody
      );

      expect(result.cached).toBe(true);
      expect(result.response).toEqual({
        status: 200,
        body: { success: true, data: { id: "1" } },
      });
    });

    it("should return cached=false and insert new key when key does not exist", async () => {
      vi.mocked(mockDb.query.idempotencyKeys.findFirst).mockResolvedValue(
        undefined
      );

      const insertChain = makeChainable([]);
      mockDb.insert.mockReturnValue(insertChain);

      const result = await checkIdempotency(
        "new-key-1234567890",
        "user-1",
        "/rewards/claim",
        { submissionId: "sub-1" }
      );

      expect(result.cached).toBe(false);
      expect(mockDb.insert).toHaveBeenCalled();
    });

    it("should throw ConflictError when key is reused with different request body", async () => {
      const existingRecord = {
        key: "test-key-1234567890",
        requestHash: "different-hash",
        responseBody: { success: true },
        responseStatus: 200,
      };

      vi.mocked(mockDb.query.idempotencyKeys.findFirst).mockResolvedValue(
        existingRecord as any
      );

      await expect(
        checkIdempotency(
          "test-key-1234567890",
          "user-1",
          "/rewards/claim",
          { submissionId: "sub-2" }
        )
      ).rejects.toThrow("Idempotency key reused with different request body");
    });

    it("should throw ConflictError when key exists with same hash but no response body", async () => {
      const sha256Hash = (await import("../../../src/utils/crypto.js")).sha256Hash;
      const requestBody = { submissionId: "sub-1" };
      const requestHash = sha256Hash(JSON.stringify(requestBody));

      const existingRecord = {
        key: "test-key-1234567890",
        requestHash,
        responseBody: null,
        responseStatus: null,
      };

      vi.mocked(mockDb.query.idempotencyKeys.findFirst).mockResolvedValue(
        existingRecord as any
      );

      await expect(
        checkIdempotency(
          "test-key-1234567890",
          "user-1",
          "/rewards/claim",
          requestBody
        )
      ).rejects.toThrow("Idempotency key reused with different request body");
    });
  });

  describe("storeIdempotentResponse", () => {
    it("should update the idempotency key with response data", async () => {
      const updateChain = makeChainable([]);
      const whereChain = makeChainable([]);
      updateChain.where = vi.fn().mockReturnValue(whereChain);
      mockDb.update.mockReturnValue(updateChain);

      await storeIdempotentResponse(
        "test-key-1234567890",
        200,
        { success: true, data: { id: "1" } },
        "tx-hash-abc"
      );

      expect(mockDb.update).toHaveBeenCalled();
      expect(updateChain.set).toHaveBeenCalledWith({
        responseStatus: 200,
        responseBody: { success: true, data: { id: "1" } },
        txHash: "tx-hash-abc",
      });
    });

    it("should set txHash to null when not provided", async () => {
      const updateChain = makeChainable([]);
      const whereChain = makeChainable([]);
      updateChain.where = vi.fn().mockReturnValue(whereChain);
      mockDb.update.mockReturnValue(updateChain);

      await storeIdempotentResponse("test-key-1234567890", 400, {
        success: false,
        error: "Bad request",
      });

      expect(updateChain.set).toHaveBeenCalledWith({
        responseStatus: 400,
        responseBody: { success: false, error: "Bad request" },
        txHash: null,
      });
    });
  });

  describe("cleanupIdempotencyKeys", () => {
    it("should delete expired keys and return count", async () => {
      const deletedRows = [
        { key: "expired-key-1" },
        { key: "expired-key-2" },
      ];

      const deleteChain = makeChainable(deletedRows);
      mockDb.delete.mockReturnValue(deleteChain);

      const count = await cleanupIdempotencyKeys();

      expect(count).toBe(2);
      expect(mockDb.delete).toHaveBeenCalled();
    });

    it("should return 0 when no expired keys exist", async () => {
      const deleteChain = makeChainable([]);
      mockDb.delete.mockReturnValue(deleteChain);

      const count = await cleanupIdempotencyKeys();

      expect(count).toBe(0);
    });
  });
});
