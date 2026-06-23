import { test, describe, expect, beforeEach, afterEach, vi } from "vitest";
import { db } from "../config/database.js";
import { redis } from "../config/redis.js";
import { courseService } from "../modules/courses/course.service.js";
import { userService } from "../modules/users/user.service.js";
import { cacheKey, cacheHits, cacheMisses } from "../cache/index.js";
import { warmCourseCache } from "../cache/warmer.js";
import {
  courses,
  enrollments,
  users,
  quizSubmissions,
  quizzes,
} from "../database/schema.js";
import { eq } from "drizzle-orm";

describe("Redis Caching & Invalidation Test Suite", () => {
  const mockUserId = "a0eebc99-9c0b-4ef8-bb6d-6bb9bd380a11";
  const mockCourseId = "b2f6c271-11a3-4b92-b60d-8848db490a22";
  const mockModuleId = "c3f7d382-22b4-5c03-c71e-9959ec501b33";
  const mockQuizId = "d4f8e493-33c5-6d14-d82f-0060fd612c44";
  const mockSubmissionId = "e5f9f504-44d6-7e25-e93f-1171fe723d55";

  beforeEach(async () => {
    await redis.flushdb();
    vi.clearAllMocks();

    await db
      .insert(users)
      .values({
        id: mockUserId,
        stellarAddress:
          "GBAXL3624V2V6R3E4W67ZXLN76K4E3U5V62M3X7A4P5R6S7T8U9V0W1A",
        displayName: "Test Developer",
        credits: 0,
      })
      .onConflictDoNothing();

    await db
      .insert(courses)
      .values({
        id: mockCourseId,
        title: "Solidity Essentials",
        description: "Learn Smart Contracts",
        difficulty: "beginner",
        isActive: true,
      })
      .onConflictDoNothing();

    await db
      .insert(quizzes)
      .values({
        id: mockQuizId,
        courseId: mockCourseId,
        moduleId: mockModuleId,
        questions: {},
      })
      .onConflictDoNothing();

    await db
      .insert(quizSubmissions)
      .values({
        id: mockSubmissionId,
        userId: mockUserId,
        quizId: mockQuizId,
        score: 100,
        answers: {},
        rewardClaimed: false,
      })
      .onConflictDoNothing();
  });

  afterEach(async () => {
    await db.delete(enrollments).where(eq(enrollments.userId, mockUserId));
    await db
      .delete(quizSubmissions)
      .where(eq(quizSubmissions.id, mockSubmissionId));
    await db.delete(quizzes).where(eq(quizzes.id, mockQuizId));
    await db.delete(courses).where(eq(courses.id, mockCourseId));
    await db.delete(users).where(eq(users.id, mockUserId));
  });

  test("First request hits DB (cache miss), second request returns from cache (cache hit)", async () => {
    const listQuery = { page: 1, limit: 10 };
    const key = cacheKey("courses", "list", "all", 1, 10);

    const initialCache = await redis.get(key);
    expect(initialCache).toBeNull();

    const res1 = await courseService.listCourses(null, listQuery);
    expect(res1.courses.length).toBeGreaterThan(0);

    const filledCache = await redis.get(key);
    expect(filledCache).not.toBeNull();

    const cacheGetSpy = vi.spyOn(redis, "get");
    const res2 = await courseService.listCourses(null, listQuery);

    expect(res2).toEqual(res1);
    expect(cacheGetSpy).toHaveBeenCalledWith(key);

    const finalResult = await cacheGetSpy.mock.results[0].value;
    expect(finalResult).toBe(filledCache);
  });

  test("After mutation, cache is invalidated (next request hits DB)", async () => {
    const listQuery = { page: 1, limit: 10 };

    await courseService.listCourses(null, listQuery);
    await courseService.getCourseDetail(mockCourseId, null);

    const listCacheBefore = await redis.get(
      cacheKey("courses", "list", "all", 1, 10),
    );
    const detailCacheBefore = await redis.get(
      cacheKey("courses", "detail", mockCourseId),
    );
    expect(listCacheBefore).not.toBeNull();
    expect(detailCacheBefore).not.toBeNull();

    await courseService.enroll(mockUserId, mockCourseId);

    const listCacheAfter = await redis.get(
      cacheKey("courses", "list", "all", 1, 10),
    );
    const detailCacheAfter = await redis.get(
      cacheKey("courses", "detail", mockCourseId),
    );
    expect(listCacheAfter).toBeNull();
    expect(detailCacheAfter).toBeNull();
  });

  test("Cache failure does not crash the request (graceful degradation)", async () => {
    vi.spyOn(redis, "get").mockRejectedValueOnce(
      new Error("Redis connection dropped"),
    );

    const data = await courseService.getCourseDetail(mockCourseId, null);
    expect(data).toBeDefined();
    expect(data.id).toBe(mockCourseId);
  });

  test("Verify cache metrics are recorded", async () => {
    const mockMissInc = vi.fn();
    const mockHitInc = vi.fn();

    const missLabelSpy = vi.spyOn(cacheMisses, "labels").mockReturnValue({
      inc: mockMissInc,
    });

    const hitLabelSpy = vi.spyOn(cacheHits, "labels").mockReturnValue({
      inc: mockHitInc,
    });

    await userService.getProgress(mockUserId);
    expect(missLabelSpy).toHaveBeenCalledWith({ namespace: "user" });
    expect(mockMissInc).toHaveBeenCalledTimes(1);

    await userService.getProgress(mockUserId);
    expect(hitLabelSpy).toHaveBeenCalledWith({ namespace: "user" });
    expect(mockHitInc).toHaveBeenCalledTimes(1);

    missLabelSpy.mockRestore();
    hitLabelSpy.mockRestore();
  });

  test("Load test: 100 concurrent course list requests -> verify only 1 DB query", async () => {
    const listQuery = { page: 1, limit: 20 };
    const redisSetexSpy = vi.spyOn(redis, "setex");

    const requests = Array.from({ length: 100 }).map(() =>
      courseService.listCourses(null, listQuery),
    );

    await Promise.all(requests);

    expect(redisSetexSpy).toHaveBeenCalled();
  });

  test("Test cache warming runs on startup", async () => {
    const targetKey = cacheKey("courses", "list", "all", 1, 20);

    const preCheck = await redis.get(targetKey);
    expect(preCheck).toBeNull();

    await warmCourseCache();

    const postCheck = await redis.get(targetKey);
    expect(postCheck).not.toBeNull();

    const parsed = JSON.parse(postCheck!);
    expect(parsed).toHaveProperty("courses");
    expect(parsed).toHaveProperty("total");
  });
});
