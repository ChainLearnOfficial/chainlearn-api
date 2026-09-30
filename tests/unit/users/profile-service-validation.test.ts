import { beforeEach, describe, expect, it, vi } from "vitest";

const { mockUpdate } = vi.hoisted(() => ({ mockUpdate: vi.fn() }));

vi.mock("../../../src/config/database.js", () => ({
  db: {
    update: mockUpdate,
    query: { users: { findFirst: vi.fn() } },
  },
}));

vi.mock("../../../src/cache/index.js", () => ({
  cacheGet: vi.fn(),
  cacheSet: vi.fn(),
  cacheDel: vi.fn(),
  cacheInvalidatePattern: vi.fn(),
  cacheKey: vi.fn((...parts: string[]) => parts.join(":")),
  cacheKeyPattern: vi.fn((...parts: string[]) => parts.join(":")),
}));

vi.mock("../../../src/config/index.js", () => ({
  config: { AVATAR_UPLOAD_MAX_BYTES: 5_000_000, AVATAR_UPLOAD_DIR: "uploads" },
}));

import { userService } from "../../../src/modules/users/user.service.js";
import { ValidationError } from "../../../src/utils/errors.js";

describe("UserService.updateProfile service-boundary validation (#534)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });
  it("rejects over-length profile data before touching the database", async () => {
    const result = userService.updateProfile("user-1", {
      displayName: "a".repeat(101),
    } as never);

    await expect(result).rejects.toBeInstanceOf(ValidationError);
    await expect(result).rejects.toMatchObject({
      errors: { displayName: expect.any(Array) },
    });
    expect(mockUpdate).not.toHaveBeenCalled();
  });

  it("rejects null for string fields when called outside the route layer", async () => {
    const result = userService.updateProfile("user-1", {
      language: null,
    } as never);

    await expect(result).rejects.toBeInstanceOf(ValidationError);
    await expect(result).rejects.toMatchObject({
      errors: { language: expect.any(Array) },
    });
    expect(mockUpdate).not.toHaveBeenCalled();
  });
});