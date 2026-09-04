import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("../../../src/config/database.js", () => {
  const mockDb = { select: vi.fn() };
  return { db: mockDb };
});

vi.mock("../../../src/utils/logger.js", () => ({
  logger: { info: vi.fn(), error: vi.fn(), warn: vi.fn(), debug: vi.fn() },
}));

vi.mock("../../../src/audit/index.js", () => ({
  auditLog: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("../../../src/cache/index.js", () => ({
  cacheGet: vi.fn().mockResolvedValue(null),
  cacheSet: vi.fn().mockResolvedValue(undefined),
  cacheDel: vi.fn().mockResolvedValue(undefined),
  cacheInvalidatePattern: vi.fn().mockResolvedValue(undefined),
  cacheKey: (...parts: (string | number)[]) => parts.join(":"),
  cacheKeyPattern: (...parts: (string | number)[]) => `${parts.join(":")}:*`,
}));

vi.mock("../../../src/stellar/client.js", () => ({
  stellarClient: { getHorizonTransaction: vi.fn() },
}));

vi.mock("../../../src/utils/lock.js", () => ({
  withLock: vi.fn(async (_key: string, fn: () => Promise<any>) => fn()),
}));

vi.mock("../../../src/config/index.js", () => ({
  config: {},
}));

vi.mock("../../../src/metrics/index.js", () => ({
  stellarTxDurationSeconds: { observe: vi.fn() },
  credentialsMintedTotal: { inc: vi.fn() },
}));

vi.mock("../../../src/stellar/transactions.js", () => ({
  invokeContract: vi.fn(),
}));

vi.mock("../../../src/services/webhook-dispatcher.js", () => ({
  dispatchWebhook: vi.fn(),
}));

vi.mock("../../../src/services/retry-queue.js", () => ({
  enqueueReward: vi.fn(),
}));

import { db } from "../../../src/config/database.js";
import { stellarClient } from "../../../src/stellar/client.js";
import { credentialService } from "../../../src/modules/credentials/credential.service.js";

const mockDb = vi.mocked(db);
const mockHorizon = vi.mocked(stellarClient.getHorizonTransaction);

function credentialsSelectChain(rows: unknown[]) {
  const chain: any = {};
  chain.select = vi.fn().mockReturnValue(chain);
  chain.from = vi.fn().mockReturnValue(chain);
  chain.innerJoin = vi.fn().mockReturnValue(chain);
  chain.where = vi.fn().mockReturnValue(chain);
  // Terminal call — the awaited value.
  chain.orderBy = vi.fn().mockResolvedValue(rows);
  return chain;
}

describe("CredentialService.getAdminUserCredentials (#410)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockHorizon.mockReset();
  });

  it("returns rows with on-chain verification resolved per credential", async () => {
    const rows = [
      {
        id: "cred-1",
        score: 9,
        nftAssetCode: "CLABCD1234",
        mintTxHash: "txhash-1",
        revoked: false,
        mintedAt: new Date("2026-08-20T00:00:00Z"),
        courseTitle: "Stellar 101",
      },
      {
        id: "cred-2",
        score: 8,
        nftAssetCode: null,
        mintTxHash: null,
        revoked: false,
        mintedAt: new Date("2026-08-25T00:00:00Z"),
        courseTitle: "Soroban Deep Dive",
      },
    ];
    mockDb.select.mockReturnValue(credentialsSelectChain(rows));
    mockHorizon.mockResolvedValueOnce({
      status: "confirmed",
      ledger: 12345,
      confirmations: 7,
    });

    const items = await credentialService.getAdminUserCredentials("user-1");

    // One Horizon call for the row with a real hash, none for the null one.
    expect(mockHorizon).toHaveBeenCalledTimes(1);
    expect(mockHorizon).toHaveBeenCalledWith("txhash-1");

    expect(items).toHaveLength(2);
    expect(items[0]).toMatchObject({
      id: "cred-1",
      courseTitle: "Stellar 101",
      verification: {
        kind: "on_chain",
        status: "confirmed",
        ledger: 12345,
        confirmations: 7,
      },
    });
    // A row with no mint tx yet has nothing to verify on-chain — marked unknown.
    expect(items[1]).toMatchObject({
      id: "cred-2",
      verification: { kind: "none", status: "unknown" },
    });
  });

  it("maps the pending_indexer_confirmation placeholder to pending without a Horizon lookup", async () => {
    const rows = [
      {
        id: "cred-p",
        score: 7,
        nftAssetCode: "CLPEND01",
        mintTxHash: "pending_indexer_confirmation",
        revoked: false,
        mintedAt: new Date("2026-09-01T00:00:00Z"),
        courseTitle: "Migrations",
      },
    ];
    mockDb.select.mockReturnValue(credentialsSelectChain(rows));

    const items = await credentialService.getAdminUserCredentials("user-2");

    // The placeholder is not a real hash — nothing to look up on Horizon.
    expect(mockHorizon).not.toHaveBeenCalled();
    expect(items[0].verification).toEqual({
      kind: "on_chain",
      status: "pending",
      ledger: null,
      confirmations: null,
    });
  });

  it("returns the cached payload without touching the database", async () => {
    const { cacheGet } = await import("../../../src/cache/index.js");
    const mockedCacheGet = vi.mocked(cacheGet);
    mockedCacheGet.mockResolvedValueOnce([
      {
        id: "cached-1",
        courseTitle: "Cached Course",
        score: 10,
        nftAssetCode: "CACHED01",
        mintTxHash: "tx-cached",
        revoked: false,
        mintedAt: new Date(),
        verification: { kind: "on_chain", status: "confirmed", ledger: 1, confirmations: 2 },
      },
    ] as any);

    const items = await credentialService.getAdminUserCredentials("user-3");

    expect(mockDb.select).not.toHaveBeenCalled();
    expect(mockHorizon).not.toHaveBeenCalled();
    expect(items).toHaveLength(1);
    expect(items[0].courseTitle).toBe("Cached Course");

    mockedCacheGet.mockReset();
  });

  it("caches the result for 30s", async () => {
    const { cacheSet } = await import("../../../src/cache/index.js");
    const rows = [
      {
        id: "cred-4",
        score: 6,
        nftAssetCode: null,
        mintTxHash: null,
        revoked: true,
        mintedAt: new Date(),
        courseTitle: "Revoked Course",
      },
    ];
    mockDb.select.mockReturnValue(credentialsSelectChain(rows));

    await credentialService.getAdminUserCredentials("user-4");

    const call = vi.mocked(cacheSet).mock.calls.at(-1);
    // cacheSet(key, value, ttlSeconds) — the TTL is the third argument.
    expect(call?.[2]).toBe(30);
  });
});
