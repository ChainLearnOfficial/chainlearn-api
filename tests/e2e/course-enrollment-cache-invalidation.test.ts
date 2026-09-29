/**
 * Tests for course enrollment count caching + invalidation (#285).
 *
 * listCourses/getCourseDetail already cached `enrolledCount` (computed via
 * a GROUP BY once, then cached) and enroll() already invalidated both of
 * those caches plus courses:stats. The one real gap: getPopularCourses()
 * also caches enrolledCount (5 min TTL — the longest of any course cache)
 * but enroll() never invalidated it, so /courses/popular could show a
 * stale count for up to 5 minutes after a real enrollment even though
 * every other enrolledCount-bearing view already corrected itself.
 */
import { test, describe, expect, beforeEach, afterEach, vi } from "vitest";
import { db } from "../config/database.js";
import { redis } from "../config/redis.js";
import { courseService } from "../modules/courses/course.service.js";
import { cacheKey } from "../cache/index.js";
import { courses, enrollments, users } from "../database/schema.js";
import { eq } from "drizzle-orm";

describe("Course enrollment count caching & invalidation (#285)", () => {
  const userId = "f5555555-1111-4ef8-bb6d-6bb9bd380a11";
  const courseId = "f5555555-2222-4b92-b60d-8848db490a22";

  let infraAvailable = true;

  beforeEach(async () => {
    try {
      await redis.flushdb();
      vi.clearAllMocks();

      await db
        .insert(users)
        .values({
          id: userId,
          stellarAddress: "GENROLLCACHETEST000000000000000000000000000000000000A",
          displayName: "Enrollment Cache Test User",
        })
        .onConflictDoNothing();

      await db
        .insert(courses)
        .values({
          id: courseId,
          title: "Enrollment Cache Test Course",
          description: "For #285 tests",
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
    await db.delete(enrollments).where(eq(enrollments.userId, userId));
    await db.delete(courses).where(eq(courses.id, courseId));
    await db.delete(users).where(eq(users.id, userId));
  });

  test("listCourses already caches enrolledCount and enroll() already invalidates it", async () => {
    if (!infraAvailable) return;

    const before = await courseService.listCourses(null, { page: 1, limit: 20 });
    expect(before.courses.find((c) => c.id === courseId)?.enrolledCount).toBe(0);

    await courseService.enroll(userId, courseId);

    const after = await courseService.listCourses(null, { page: 1, limit: 20 });
    expect(after.courses.find((c) => c.id === courseId)?.enrolledCount).toBe(1);
  });

  test("getCourseDetail already caches enrolledCount and enroll() already invalidates it", async () => {
    if (!infraAvailable) return;

    const before = await courseService.getCourseDetail(courseId, null);
    expect(before.enrolledCount).toBe(0);

    await courseService.enroll(userId, courseId);

    const after = await courseService.getCourseDetail(courseId, null);
    expect(after.enrolledCount).toBe(1);
  });

  test("getPopularCourses's cached enrolledCount is invalidated by enroll() (the real #285 gap)", async () => {
    if (!infraAvailable) return;

    // Populate the popular-courses cache with the pre-enrollment count.
    const before = await courseService.getPopularCourses(20);
    expect(before.find((c) => c.id === courseId)?.enrolledCount).toBe(0);

    const popularKey = cacheKey("courses", "popular", 20);
    expect(await redis.get(popularKey)).not.toBeNull();

    await courseService.enroll(userId, courseId);

    // The cache entry must be gone, not just stale-but-present.
    expect(await redis.get(popularKey)).toBeNull();

    const after = await courseService.getPopularCourses(20);
    expect(after.find((c) => c.id === courseId)?.enrolledCount).toBe(1);
  });

  test("getPopularCourses invalidation covers every cached limit, not just one", async () => {
    if (!infraAvailable) return;

    await courseService.getPopularCourses(10);
    await courseService.getPopularCourses(50);
    expect(await redis.get(cacheKey("courses", "popular", 10))).not.toBeNull();
    expect(await redis.get(cacheKey("courses", "popular", 50))).not.toBeNull();

    await courseService.enroll(userId, courseId);

    expect(await redis.get(cacheKey("courses", "popular", 10))).toBeNull();
    expect(await redis.get(cacheKey("courses", "popular", 50))).toBeNull();
  });

  test("courses:stats cache is invalidated by enroll() (pre-existing behavior, still correct)", async () => {
    if (!infraAvailable) return;

    await courseService.getStats();
    expect(await redis.get(cacheKey("courses", "stats"))).not.toBeNull();

    await courseService.enroll(userId, courseId);

    expect(await redis.get(cacheKey("courses", "stats"))).toBeNull();
  });
});
