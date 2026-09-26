import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("../../../src/config/database.js", () => {
  const mockDb = { select: vi.fn(), insert: vi.fn(), update: vi.fn(), query: { courses: { findFirst: vi.fn() } } };
  return { db: mockDb };
});

vi.mock("../../../src/utils/logger.js", () => ({
  logger: { info: vi.fn(), error: vi.fn(), warn: vi.fn() },
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
  chain.where = vi.fn().mockResolvedValue(result);
  return chain;
}

describe("CourseService — Course Cloning (#378)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("deep copies course metadata, modules, content, and quizzes into draft course", async () => {
    const originalCourseId = "course-1111-2222";
    const originalModuleId = "mod-1";
    const originalCourse = {
      id: originalCourseId,
      title: "Original Stellar Course",
      description: "Learn Soroban",
      difficulty: "beginner",
      tags: ["stellar", "rust"],
      modules: [{ id: originalModuleId, title: "Module 1", description: "Intro", order: 0 }],
      courseModules: [{ id: originalModuleId, title: "Module 1", description: "Intro" }],
      accessibilityScore: 90,
      prerequisites: [],
      isActive: true,
      isDraft: false,
      createdAt: new Date(),
    };

    const existingContent = [
      {
        id: "content-1",
        courseId: originalCourseId,
        moduleId: originalModuleId,
        title: "Intro Text",
        type: "text",
        content: { body: "Welcome to Soroban" },
        orderIndex: 0,
      },
    ];

    const existingQuizzes = [
      {
        id: "quiz-1",
        courseId: originalCourseId,
        moduleId: originalModuleId,
        questions: [{ id: "q1", text: "What is Stellar?", options: ["A", "B"], correctIndex: 0 }],
      },
    ];

    // mock select calls in sequence: original course, module content, quizzes
    mockDb.select
      .mockReturnValueOnce(selectChain([originalCourse]))
      .mockReturnValueOnce(selectChain(existingContent))
      .mockReturnValueOnce(selectChain(existingQuizzes));

    let insertedCourseValues: any = null;
    let insertedContentValues: any = null;
    let insertedQuizValues: any = null;

    mockDb.insert.mockImplementation((table: any) => {
      return {
        values: vi.fn().mockImplementation((val: any) => {
          if (!insertedCourseValues) {
            insertedCourseValues = val;
            return {
              returning: vi.fn().mockResolvedValue([{ ...val, createdAt: new Date() }]),
            };
          } else if (!insertedContentValues) {
            insertedContentValues = val;
            return {
              returning: vi.fn().mockResolvedValue(val),
            };
          } else {
            insertedQuizValues = val;
            return {
              returning: vi.fn().mockResolvedValue(val),
            };
          }
        }),
      } as any;
    });

    const cloned = await courseService.cloneCourse(originalCourseId, "Cloned Stellar Course");

    expect(cloned.title).toBe("Cloned Stellar Course");
    expect(cloned.isDraft).toBe(true);
    expect(cloned.isActive).toBe(false);
    expect(cloned.id).not.toBe(originalCourseId);

    // Verify modules got new IDs
    expect(cloned.modules.length).toBe(1);
    const newModuleId = cloned.modules[0].id;
    expect(newModuleId).not.toBe(originalModuleId);

    // Verify module content was copied with new moduleId and new courseId
    expect(insertedContentValues).toBeDefined();
    expect(insertedContentValues.length).toBe(1);
    expect(insertedContentValues[0].courseId).toBe(cloned.id);
    expect(insertedContentValues[0].moduleId).toBe(newModuleId);
    expect(insertedContentValues[0].title).toBe("Intro Text");

    // Verify quizzes were copied with new moduleId and new courseId
    expect(insertedQuizValues).toBeDefined();
    expect(insertedQuizValues.length).toBe(1);
    expect(insertedQuizValues[0].courseId).toBe(cloned.id);
    expect(insertedQuizValues[0].moduleId).toBe(newModuleId);

    // Verify audit log
    expect(auditLog).toHaveBeenCalledWith("course.cloned", {
      courseId: cloned.id,
      sourceCourseId: originalCourseId,
    });
  });

  it("throws NotFoundError when original course does not exist", async () => {
    mockDb.select.mockReturnValueOnce(selectChain([]));

    await expect(courseService.cloneCourse("non-existent-course")).rejects.toThrow("Course not found");
  });
});
