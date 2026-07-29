import { test, describe, expect, beforeEach, afterEach, vi } from "vitest";
import { db } from "../config/database.js";
import { redis } from "../config/redis.js";
import { courseService } from "../modules/courses/course.service.js";
import { userService } from "../modules/users/user.service.js";
import { quizService } from "../modules/quizzes/quiz.service.js";
import { cacheKey, cacheKeyPattern } from "../cache/index.js";
import { warmCourseCache } from "../cache/warmer.js";
import { logger } from "../utils/logger.js";
import { courses, enrollments, users } from "../database/schema.js";
import { eq } from "drizzle-orm";

describe("Course cache, progress TTL, and placeholder fallback (#146, #148, #149, #150)", () => {
  const mockUserId = "a9b8c7d6-1111-4ef8-bb6d-6bb9bd380a11";
  const mockCourseId = "a9b8c7d6-2222-4b92-b60d-8848db490a22";

  let infraAvailable = true;

  beforeEach(async () => {
    try {
      await redis.flushdb();
      vi.clearAllMocks();

      await db
        .insert(users)
        .values({
          id: mockUserId,
          stellarAddress:
            "GBAXL3624V2V6R3E4W67ZXLN76K4E3U5V62M3X7A4P5R6S7T8U9V0W1C",
          displayName: "Cache Test User",
          credits: 0,
        })
        .onConflictDoNothing();

      await db
        .insert(courses)
        .values({
          id: mockCourseId,
          title: "Cache Test Course",
          description: "For cache/TTL tests",
          difficulty: "beginner",
          isActive: true,
        })
        .onConflictDoNothing();
    } catch {
      infraAvailable = false;
    }
  });

  afterEach(async () => {
    if (!infraAvailable) return;
    await db.delete(enrollments).where(eq(enrollments.userId, mockUserId));
    await db.delete(courses).where(eq(courses.id, mockCourseId));
    await db.delete(users).where(eq(users.id, mockUserId));
  });

  test("cacheKeyPattern derives a SCAN wildcard from the same shape cacheKey uses (#150)", () => {
    const pattern = cacheKeyPattern("courses", "list");
    expect(pattern).toBe("chainlearn:courses:list:*");

    // Must actually match real keys produced by cacheKey with extra parts
    // (Redis SCAN's MATCH glob: "*" matches any run of characters).
    const realKey = cacheKey("courses", "list", "all", 1, 20);
    expect(pattern.endsWith("*")).toBe(true);
    const prefix = pattern.slice(0, -1);
    expect(realKey.startsWith(prefix)).toBe(true);
  });

  test("warming the course cache does not leave a second, differently-TTL'd write (#148)", async () => {
    if (!infraAvailable) return;

    const key = cacheKey("courses", "list", "all", 1, 20);
    expect(await redis.get(key)).toBeNull();

    await warmCourseCache();

    const cached = await redis.get(key);
    expect(cached).not.toBeNull();

    // listCourses is the only writer of this key now — its TTL (30s) is
    // the sole source of truth, so the key's TTL must be <= 30, never the
    // old hardcoded 60 the warmer used to set afterward.
    const ttl = await redis.ttl(key);
    expect(ttl).toBeGreaterThan(0);
    expect(ttl).toBeLessThanOrEqual(30);
  });

  test("enroll() invalidates the course list cache via the derived pattern (#150)", async () => {
    if (!infraAvailable) return;

    await courseService.listCourses(null, { page: 1, limit: 20 });
    const listKey = cacheKey("courses", "list", "all", 1, 20);
    expect(await redis.get(listKey)).not.toBeNull();

    await courseService.enroll(mockUserId, mockCourseId);

    expect(await redis.get(listKey)).toBeNull();
  });

  test("getProgress caches for longer than the old 10s TTL (#149)", async () => {
    if (!infraAvailable) return;

    await userService.getProgress(mockUserId);
    const key = cacheKey("user", "progress", mockUserId);
    const ttl = await redis.ttl(key);

    expect(ttl).toBeGreaterThan(10);
  });

  test("createPlaceholderQuestions logs which courseId/moduleId received the generic fallback (#146)", () => {
    const warnSpy = vi.spyOn(logger, "warn");

    const questions = (quizService as any).createPlaceholderQuestions(
      mockCourseId,
      "module-1",
    );

    expect(Array.isArray(questions)).toBe(true);
    expect(questions.length).toBeGreaterThan(0);
    expect(warnSpy).toHaveBeenCalledWith(
      expect.objectContaining({ courseId: mockCourseId, moduleId: "module-1" }),
      expect.stringContaining("Falling back to generic placeholder questions"),
    );
  });
});
