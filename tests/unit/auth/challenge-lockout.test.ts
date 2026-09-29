import { describe, it, expect, vi, beforeEach } from "vitest";
import * as StellarSdk from "@stellar/stellar-sdk";

const mockRedis = vi.hoisted(() => ({
  ttl: vi.fn(),
  setex: vi.fn(),
  incr: vi.fn(),
  expire: vi.fn(),
  del: vi.fn(),
  getdel: vi.fn(),
}));

vi.mock("../../../src/config/redis.js", () => ({ redis: mockRedis }));
vi.mock("../../../src/utils/logger.js", () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));
vi.mock("../../../src/audit/index.js", () => ({
  auditLog: vi.fn().mockResolvedValue(undefined),
}));
vi.mock("../../../src/config/database.js", () => ({
  db: { query: { users: { findFirst: vi.fn() } }, insert: vi.fn() },
}));
vi.mock("../../../src/config/stellar.js", () => ({
  getNetworkPassphrase: vi.fn().mockReturnValue(StellarSdk.Networks.TESTNET),
  getPlatformKeypair: vi.fn(),
}));

import { authService } from "../../../src/modules/auth/auth.service.js";
import { RateLimitError } from "../../../src/utils/errors.js";

// A syntactically and checksum-valid Stellar public key — StellarSdk.Account
// validates the full StrKey checksum, not just the "G" prefix/length, so a
// placeholder like "GALICE000...0" fails before the lockout check even runs.
const STELLAR_ADDRESS = "GCSBAPA5MWV3IOFPFXFEZ4H7U4NUVJE3Q4FR5MADZRXH6MQDC4X4CHCM";

describe("AuthService.createChallenge lockout gate (#488)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("rejects with RateLimitError (not proceeding to build a challenge) when the address is locked out", async () => {
    mockRedis.ttl.mockResolvedValue(42);

    await expect(authService.createChallenge(STELLAR_ADDRESS)).rejects.toThrow(RateLimitError);
    expect(mockRedis.setex).not.toHaveBeenCalled();
  });

  it("reports the lockout's remaining time as retryAfterSeconds", async () => {
    mockRedis.ttl.mockResolvedValue(42);

    try {
      await authService.createChallenge(STELLAR_ADDRESS);
      expect.unreachable("expected createChallenge to throw");
    } catch (err) {
      expect(err).toBeInstanceOf(RateLimitError);
      expect((err as RateLimitError).retryAfterSeconds).toBe(42);
    }
  });

  it("proceeds to build a challenge when the address is not locked out", async () => {
    mockRedis.ttl.mockResolvedValue(-2);
    mockRedis.setex.mockResolvedValue("OK");

    const result = await authService.createChallenge(STELLAR_ADDRESS);
    expect(result.challenge).toBeTruthy();
    expect(mockRedis.setex).toHaveBeenCalled();
  });
});
