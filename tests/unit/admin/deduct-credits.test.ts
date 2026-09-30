import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("../../../src/config/database.js", () => {
  const mockDb = { update: vi.fn(), select: vi.fn() };
  return { db: mockDb };
});

vi.mock("../../../src/utils/logger.js", () => ({
  logger: { info: vi.fn(), error: vi.fn(), warn: vi.fn() },
}));

vi.mock("../../../src/audit/index.js", () => ({
  auditLog: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("../../../src/cache/index.js", () => ({
  cacheDel: vi.fn().mockResolvedValue(undefined),
  cacheInvalidatePattern: vi.fn().mockResolvedValue(undefined),
  cacheKey: (...parts: (string | number)[]) => parts.join(":"),
  cacheKeyPattern: (...parts: (string | number)[]) => `${parts.join(":")}:*`,
}));

import { db } from "../../../src/config/database.js";
import { adminUsersService } from "../../../src/modules/admin/admin-users.service.js";
import { NotFoundError, ValidationError } from "../../../src/utils/errors.js";

const mockDb = vi.mocked(db);

function updateChain(returningResult: unknown[]) {
  const chain: any = {};
  chain.update = vi.fn().mockReturnValue(chain);
  chain.set = vi.fn().mockReturnValue(chain);
  chain.where = vi.fn().mockReturnValue(chain);
  chain.returning = vi.fn().mockResolvedValue(returningResult);
  return chain;
}

function selectChain(result: unknown[]) {
  const chain: any = {};
  chain.select = vi.fn().mockReturnValue(chain);
  chain.from = vi.fn().mockReturnValue(chain);
  chain.where = vi.fn().mockResolvedValue(result);
  return chain;
}

describe("AdminUsersService.deductCredits atomic guard (#476)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("deducts in a single UPDATE and returns the new balance when funds are sufficient", async () => {
    mockDb.update.mockReturnValue(updateChain([{ id: "user-1", credits: 40 }]));

    const result = await adminUsersService.deductCredits("user-1", 10, "penalty");

    expect(mockDb.update).toHaveBeenCalledTimes(1);
    // The balance check never runs a separate SELECT before the UPDATE —
    // that's the whole point of collapsing check-then-act into one query.
    expect(mockDb.select).not.toHaveBeenCalled();
    expect(result.creditsBefore).toBe(50);
    expect(result.creditsAfter).toBe(40);
  });

  it("throws ValidationError (not NotFoundError) when the guarded UPDATE finds no row because the balance was insufficient", async () => {
    mockDb.update.mockReturnValue(updateChain([]));
    mockDb.select.mockReturnValue(selectChain([{ credits: 5 }]));

    await expect(
      adminUsersService.deductCredits("user-1", 10, "penalty"),
    ).rejects.toThrow(ValidationError);
  });

  it("throws NotFoundError when the user doesn't exist or is soft-deleted", async () => {
    mockDb.update.mockReturnValue(updateChain([]));
    mockDb.select.mockReturnValue(selectChain([]));

    await expect(
      adminUsersService.deductCredits("missing-user", 10, "penalty"),
    ).rejects.toThrow(NotFoundError);
  });

  it("never lets credits go negative even when a concurrent grant races the check", async () => {
    // Simulate the exact race the issue describes: the guarded UPDATE is
    // the only place balance is enforced, so a concurrent request can't
    // sneak a deduction through between a separate check and a separate
    // write — there is no separate write here to sneak between.
    mockDb.update.mockReturnValue(updateChain([]));
    mockDb.select.mockReturnValue(selectChain([{ credits: 3 }]));

    try {
      await adminUsersService.deductCredits("user-1", 10, "penalty");
      expect.unreachable("expected deductCredits to throw");
    } catch (err) {
      expect(err).toBeInstanceOf(ValidationError);
      expect((err as ValidationError).errors.amount[0]).toMatch(/Insufficient credits/);
    }
  });
});
