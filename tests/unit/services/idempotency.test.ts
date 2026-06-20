import { beforeEach, describe, expect, it, vi } from "vitest";

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

vi.mock("../../../src/config/database.js", () => ({
  db: mockDb,
}));

import {
  hashRequestBody,
  reserveIdempotencyKey,
  storeIdempotentResponse,
  storeIdempotencyTxHash,
  cleanupExpiredIdempotencyKeys,
} from "../../../src/middleware/idempotency.js";

describe("idempotency helper", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("hashes semantically identical request bodies the same way", () => {
    const first = hashRequestBody({ submissionId: "a", idempotencyKey: "k" });
    const second = hashRequestBody({ idempotencyKey: "k", submissionId: "a" });

    expect(first).toBe(second);
  });

  it("returns a cached record when the same key already has a stored response", async () => {
    mockDb.query.idempotencyKeys.findFirst.mockResolvedValueOnce({
      key: "test-key",
      userId: "user-1",
      endpoint: "/api/rewards/claim",
      requestHash: hashRequestBody({ submissionId: "sub-1", idempotencyKey: "test-key" }),
      responseStatus: 200,
      responseBody: { success: true },
      txHash: "tx-1",
      createdAt: new Date(),
      expiresAt: new Date(Date.now() + 1000),
    });

    const result = await reserveIdempotencyKey({
      key: "test-key",
      userId: "user-1",
      endpoint: "/api/rewards/claim",
      requestBody: { submissionId: "sub-1", idempotencyKey: "test-key" },
    });

    expect(result.state).toBe("cached");
    expect(result.record.responseBody).toEqual({ success: true });
  });

  it("rejects reuse of the same key with a different request body", async () => {
    mockDb.query.idempotencyKeys.findFirst.mockResolvedValueOnce({
      key: "test-key",
      userId: "user-1",
      endpoint: "/api/rewards/claim",
      requestHash: hashRequestBody({ submissionId: "sub-1", idempotencyKey: "test-key" }),
      responseStatus: null,
      responseBody: null,
      txHash: null,
      createdAt: new Date(),
      expiresAt: new Date(Date.now() + 1000),
    });

    await expect(
      reserveIdempotencyKey({
        key: "test-key",
        userId: "user-1",
        endpoint: "/api/rewards/claim",
        requestBody: { submissionId: "sub-2", idempotencyKey: "test-key" },
      })
    ).rejects.toMatchObject({ statusCode: 409 });
  });

  it("updates the stored tx hash and response body", async () => {
    const updateSet = vi.fn().mockReturnValue({
      where: vi.fn().mockResolvedValue(undefined),
    });

    mockDb.update.mockReturnValue({
      set: updateSet,
    });

    await storeIdempotencyTxHash("test-key", "tx-1");
    await storeIdempotentResponse("test-key", 200, { success: true });

    expect(mockDb.update).toHaveBeenCalledTimes(2);
    expect(updateSet).toHaveBeenCalled();
  });

  it("cleans up expired keys", async () => {
    mockDb.delete.mockReturnValue({
      where: vi.fn().mockReturnValue({
        returning: vi.fn().mockResolvedValue([{ key: "expired-key" }]),
      }),
    });

    const removed = await cleanupExpiredIdempotencyKeys();

    expect(removed).toBe(1);
  });
});