import { describe, it, expect, vi, beforeEach } from "vitest";

const { mockUpdate, mockSelect } = vi.hoisted(() => ({
  mockUpdate: vi.fn(),
  mockSelect: vi.fn(),
}));

vi.mock("../../../src/config/database.js", () => ({
  db: {
    update: mockUpdate,
    select: mockSelect,
  },
}));

vi.mock("../../../src/utils/logger.js", () => ({
  logger: {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  },
}));

vi.mock("../../../src/config/redis.js", () => ({
  redis: {
    get: vi.fn(),
    set: vi.fn(),
    del: vi.fn(),
  },
}));

describe("reconcile-pending-rewards", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("should have proper mock structure", () => {
    expect(mockUpdate).toBeDefined();
    expect(mockSelect).toBeDefined();
  });
});
