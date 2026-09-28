import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("../../../src/config/database.js", () => {
  const mockDb = {
    select: vi.fn(),
    insert: vi.fn(),
    update: vi.fn(),
    delete: vi.fn(),
    query: { courses: { findFirst: vi.fn() } },
  };
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

vi.mock("../../../src/config/index.js", () => ({
  config: { MAX_ENROLLMENTS: 10, AVATAR_UPLOAD_MAX_BYTES: 2 * 1024 * 1024 },
}));

vi.mock("../../../src/cache/index.js", () => ({
  cacheGet: vi.fn().mockResolvedValue(null),
  cacheSet: vi.fn().mockResolvedValue(undefined),
  cacheDel: vi.fn().mockResolvedValue(undefined),
  cacheInvalidatePattern: vi.fn().mockResolvedValue(undefined),
  cacheKey: (...parts: (string | number)[]) => parts.join(":"),
  cacheKeyPattern: (...parts: (string | number)[]) => `${parts.join(":")}:*`,
}));

import { db } from "../../../src/config/database.js";
import { auditLog } from "../../../src/audit/index.js";
import { courseService } from "../../../src/modules/courses/course.service.js";

const mockDb = vi.mocked(db);

function selectChain(result: unknown[]) {
  const chain: any = {};
  chain.select = vi.fn().mockReturnValue(chain);
  chain.from = vi.fn().mockReturnValue(chain);
  chain.where = vi.fn().mockImplementation(() => {
    return {
      orderBy: vi.fn().mockResolvedValue(result),
      then: (resolve: any) => resolve(result),
    };
  });
  return chain;
}

describe("CourseService — Module Content CRUD & Reorder (#382)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("lists module content ordered by orderIndex", async () => {
    (mockDb.query.courses.findFirst as any).mockResolvedValue({ id: "course-1" } as any);
    const contentRows = [
      {
        id: "c1",
        courseId: "course-1",
        moduleId: "m1",
        title: "Lesson 1",
        type: "text",
        content: { body: "Hello" },
        orderIndex: 0,
        createdAt: new Date(),
        updatedAt: new Date(),
      },
      {
        id: "c2",
        courseId: "course-1",
        moduleId: "m1",
        title: "Video 1",
        type: "video",
        content: { videoUrl: "https://example.com/video.mp4" },
        orderIndex: 1,
        createdAt: new Date(),
        updatedAt: new Date(),
      },
    ];

    mockDb.select.mockReturnValue(selectChain(contentRows));

    const result = await courseService.listModuleContent("course-1", "m1");

    expect(result.length).toBe(2);
    expect(result[0].title).toBe("Lesson 1");
    expect(result[1].type).toBe("video");
  });

  it("creates a text content item and logs audit", async () => {
    (mockDb.query.courses.findFirst as any).mockResolvedValue({ id: "course-1" } as any);
    mockDb.select.mockReturnValue({
      from: vi.fn().mockReturnValue({
        where: vi.fn().mockResolvedValue([{ maxOrder: 2 }]),
      }),
    } as any);

    const createdRow = {
      id: "new-content-1",
      courseId: "course-1",
      moduleId: "m1",
      title: "New Markdown Lesson",
      type: "text",
      content: { body: "# Title\nLesson content" },
      orderIndex: 3,
      createdAt: new Date(),
      updatedAt: new Date(),
    };

    mockDb.insert.mockReturnValue({
      values: vi.fn().mockReturnValue({
        returning: vi.fn().mockResolvedValue([createdRow]),
      }),
    } as any);

    const result = await courseService.createModuleContent("course-1", "m1", {
      title: "New Markdown Lesson",
      type: "text",
      content: { body: "# Title\nLesson content" },
    });

    expect(result.id).toBe("new-content-1");
    expect(result.orderIndex).toBe(3);
    expect(auditLog).toHaveBeenCalledWith("course.module.content.created", {
      courseId: "course-1",
      moduleId: "m1",
      contentId: "new-content-1",
    });
  });

  it("updates a content item and logs audit", async () => {
    const existing = {
      id: "c1",
      courseId: "course-1",
      moduleId: "m1",
      title: "Old Title",
      type: "text",
      content: { body: "Old body" },
      orderIndex: 0,
      createdAt: new Date(),
      updatedAt: new Date(),
    };

    mockDb.select.mockReturnValue(selectChain([existing]));

    const updatedRow = {
      ...existing,
      title: "Updated Title",
      content: { body: "Updated body" },
    };

    mockDb.update.mockReturnValue({
      set: vi.fn().mockReturnValue({
        where: vi.fn().mockReturnValue({
          returning: vi.fn().mockResolvedValue([updatedRow]),
        }),
      }),
    } as any);

    const result = await courseService.updateModuleContent("course-1", "m1", "c1", {
      title: "Updated Title",
      content: { body: "Updated body" },
    });

    expect(result.title).toBe("Updated Title");
    expect(auditLog).toHaveBeenCalledWith("course.module.content.updated", {
      courseId: "course-1",
      moduleId: "m1",
      contentId: "c1",
    });
  });

  it("deletes a content item and logs audit", async () => {
    const existing = {
      id: "c1",
      courseId: "course-1",
      moduleId: "m1",
    };

    mockDb.select.mockReturnValue(selectChain([existing]));
    mockDb.delete.mockReturnValue({
      where: vi.fn().mockResolvedValue(undefined),
    } as any);

    await courseService.deleteModuleContent("course-1", "m1", "c1");

    expect(auditLog).toHaveBeenCalledWith("course.module.content.deleted", {
      courseId: "course-1",
      moduleId: "m1",
      contentId: "c1",
    });
  });

  it("reorders content items atomically", async () => {
    (mockDb.query.courses.findFirst as any).mockResolvedValue({ id: "course-1" } as any);
    const existingItems = [
      { id: "c1", courseId: "course-1", moduleId: "m1", orderIndex: 0 },
      { id: "c2", courseId: "course-1", moduleId: "m1", orderIndex: 1 },
    ];

    mockDb.select
      .mockReturnValueOnce(selectChain(existingItems))
      .mockReturnValueOnce(selectChain([
        { ...existingItems[1], orderIndex: 0, title: "Item 2", type: "text", content: {}, createdAt: new Date(), updatedAt: new Date() },
        { ...existingItems[0], orderIndex: 1, title: "Item 1", type: "text", content: {}, createdAt: new Date(), updatedAt: new Date() },
      ]));

    mockDb.update.mockReturnValue({
      set: vi.fn().mockReturnValue({
        where: vi.fn().mockResolvedValue(undefined),
      }),
    } as any);

    const reordered = await courseService.reorderModuleContent("course-1", "m1", ["c2", "c1"]);

    expect(reordered.length).toBe(2);
    expect(reordered[0].id).toBe("c2");
    expect(reordered[1].id).toBe("c1");
    expect(auditLog).toHaveBeenCalledWith("course.module.content.reordered", {
      courseId: "course-1",
      moduleId: "m1",
      contentIds: ["c2", "c1"],
    });
  });
});
