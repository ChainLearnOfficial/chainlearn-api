import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("../../../src/config/database.js", () => {
  const mockDb = { select: vi.fn(), update: vi.fn(), transaction: vi.fn() };
  return { db: mockDb };
});

vi.mock("../../../src/utils/logger.js", () => ({
  logger: { info: vi.fn(), error: vi.fn(), warn: vi.fn() },
}));

vi.mock("../../../src/utils/lock.js", () => ({
  withLock: vi.fn(async (_key: string, fn: () => Promise<any>) => fn()),
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

vi.mock("../../../src/config/index.js", () => ({
  config: { MAX_ENROLLMENTS: 10 },
}));

import { db } from "../../../src/config/database.js";
import { courseService } from "../../../src/modules/courses/course.service.js";

const mockDb = vi.mocked(db);

function selectChain(result: unknown[]) {
  const chain: any = {};
  chain.select = vi.fn().mockReturnValue(chain);
  chain.from = vi.fn().mockReturnValue(chain);
  chain.where = vi.fn().mockResolvedValue(result);
  return chain;
}

describe("CourseService — admin module management (#304)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("creates a module appended at the end of the existing list", async () => {
    const course = { id: "course-1", modules: [{ id: "m1", title: "Intro", description: "", order: 0 }] };
    mockDb.select.mockReturnValue(selectChain([course]));
    const setMock = vi.fn().mockReturnValue({ where: vi.fn().mockResolvedValue(undefined) });
    mockDb.update.mockReturnValue({ set: setMock } as any);

    const created = await courseService.createModule("course-1", {
      title: "Advanced",
      description: "desc",
    });

    expect(created.title).toBe("Advanced");
    expect(created.order).toBe(1);
    expect(setMock).toHaveBeenCalledWith({
      modules: [
        { id: "m1", title: "Intro", description: "", order: 0 },
        expect.objectContaining({ title: "Advanced", order: 1 }),
      ],
    });
  });

  it("throws NotFoundError when the course does not exist", async () => {
    mockDb.select.mockReturnValue(selectChain([]));

    await expect(
      courseService.createModule("missing-course", { title: "X", description: "" }),
    ).rejects.toThrow("Course not found");
  });

  it("updates an existing module's fields", async () => {
    const course = {
      id: "course-1",
      modules: [{ id: "m1", title: "Intro", description: "old", order: 0 }],
    };
    mockDb.select.mockReturnValue(selectChain([course]));
    const setMock = vi.fn().mockReturnValue({ where: vi.fn().mockResolvedValue(undefined) });
    mockDb.update.mockReturnValue({ set: setMock } as any);

    const updated = await courseService.updateModule("course-1", "m1", {
      description: "new",
    });

    expect(updated).toEqual({ id: "m1", title: "Intro", description: "new", order: 0 });
  });

  it("throws NotFoundError when updating a module that doesn't exist", async () => {
    const course = { id: "course-1", modules: [] };
    mockDb.select.mockReturnValue(selectChain([course]));

    await expect(
      courseService.updateModule("course-1", "missing", { title: "X" }),
    ).rejects.toThrow("Module not found");
  });

  it("deletes a module and removes its associated quizzes", async () => {
    const course = {
      id: "course-1",
      modules: [{ id: "m1", title: "Intro", description: "", order: 0 }],
    };
    const updateSet = vi.fn().mockReturnValue({ where: vi.fn().mockResolvedValue(undefined) });
    const deleteWhere = vi.fn().mockResolvedValue(undefined);

    mockDb.transaction.mockImplementation(async (fn: any) => {
      const tx: any = {};
      tx.select = vi.fn().mockReturnValue(selectChain([course]));
      tx.update = vi.fn().mockReturnValue({ set: updateSet });
      tx.delete = vi.fn().mockReturnValue({ where: deleteWhere });
      return fn(tx);
    });

    await courseService.deleteModule("course-1", "m1");

    expect(updateSet).toHaveBeenCalledWith({ modules: [] });
    expect(deleteWhere).toHaveBeenCalled();
  });

  it("throws NotFoundError when deleting a module that doesn't exist", async () => {
    const course = { id: "course-1", modules: [] };
    mockDb.transaction.mockImplementation(async (fn: any) => {
      const tx: any = {};
      tx.select = vi.fn().mockReturnValue(selectChain([course]));
      return fn(tx);
    });

    await expect(courseService.deleteModule("course-1", "missing")).rejects.toThrow(
      "Module not found",
    );
  });
});
