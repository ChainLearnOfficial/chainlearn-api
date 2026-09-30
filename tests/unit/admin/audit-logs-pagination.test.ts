import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("../../../src/config/database.js", () => {
  const mockDb = { select: vi.fn() };
  return { db: mockDb };
});

import { db } from "../../../src/config/database.js";
import { auditService } from "../../../src/modules/admin/audit.service.js";
import { encodeCursor } from "../../../src/utils/cursor-pagination.js";

const mockDb = vi.mocked(db);

function countChain(value: number) {
  const chain: any = {};
  chain.select = vi.fn().mockReturnValue(chain);
  chain.from = vi.fn().mockReturnValue(chain);
  chain.where = vi.fn().mockResolvedValue([{ value }]);
  return chain;
}

function rowsChain(rows: unknown[]) {
  const chain: any = {};
  chain.select = vi.fn().mockReturnValue(chain);
  chain.from = vi.fn().mockReturnValue(chain);
  chain.where = vi.fn().mockReturnValue(chain);
  chain.orderBy = vi.fn().mockReturnValue(chain);
  chain.limit = vi.fn().mockReturnValue(chain);
  chain.offset = vi.fn().mockResolvedValue(rows);
  return chain;
}

function makeRow(id: string, createdAt: Date) {
  return { id, event: "test.event", fields: {}, createdAt };
}

describe("AuditService.listLogs cursor pagination (#482)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("returns nextCursor when there are more rows than the page limit", async () => {
    const rows = Array.from({ length: 3 }, (_, i) =>
      makeRow(`row-${i}`, new Date(2026, 0, 10 - i)),
    );
    mockDb.select
      .mockImplementationOnce(() => countChain(10))
      .mockImplementationOnce(() => rowsChain(rows));

    const result = await auditService.listLogs({ limit: 2, offset: 0 } as any);

    expect(result.logs).toHaveLength(2);
    expect(result.total).toBe(10);
    expect(result.nextCursor).not.toBeNull();
  });

  it("returns a null nextCursor when the page isn't full", async () => {
    const rows = [makeRow("row-0", new Date())];
    mockDb.select
      .mockImplementationOnce(() => countChain(1))
      .mockImplementationOnce(() => rowsChain(rows));

    const result = await auditService.listLogs({ limit: 20, offset: 0 } as any);

    expect(result.logs).toHaveLength(1);
    expect(result.nextCursor).toBeNull();
  });

  it("ignores offset when a cursor is provided", async () => {
    const cursor = encodeCursor({ createdAt: new Date(2026, 0, 5), id: "cursor-row" });
    const rows = [makeRow("row-a", new Date(2026, 0, 4))];
    mockDb.select
      .mockImplementationOnce(() => countChain(5))
      .mockImplementationOnce(() => rowsChain(rows));

    const result = await auditService.listLogs({
      limit: 20,
      offset: 50,
      cursor,
    } as any);

    expect(result.logs).toHaveLength(1);
  });

  it("treats an unparseable cursor as absent rather than throwing", async () => {
    mockDb.select
      .mockImplementationOnce(() => countChain(0))
      .mockImplementationOnce(() => rowsChain([]));

    await expect(
      auditService.listLogs({ limit: 20, offset: 0, cursor: "garbage" } as any),
    ).resolves.toEqual({ logs: [], total: 0, nextCursor: null });
  });
});
