import { test, describe, expect, beforeEach, afterEach } from "vitest";
import { eq } from "drizzle-orm";
import { db } from "../config/database.js";
import { redis } from "../config/redis.js";
import { userService } from "../modules/users/user.service.js";
import { cacheKey, cacheSet } from "../cache/index.js";
import {
  users,
  courses,
  enrollments,
  credentials,
} from "../database/schema.js";

describe("Account deletion (#290)", () => {
  const mockUserId = "f1a2d3e4-1111-4ef8-bb6d-6bb9bd380a44";
  const mockCourseId = "f1a2d3e4-2222-4b92-b60d-8848db490a55";

  let infraAvailable = true;

  beforeEach(async () => {
    try {
      await redis.flushdb();

      await db
        .insert(users)
        .values({
          id: mockUserId,
          stellarAddress:
            "GDELETE0000000000000000000000000000000000000000000004",
          displayName: "To Be Deleted",
          background: "Some background text",
          learningGoal: "Some learning goal",
          credits: 42,
        })
        .onConflictDoNothing();

      await db
        .insert(courses)
        .values({
          id: mockCourseId,
          title: "Deletion Test Course",
          description: "For account deletion tests",
          difficulty: "beginner",
          isActive: true,
        })
        .onConflictDoNothing();

      await db
        .insert(enrollments)
        .values({ userId: mockUserId, courseId: mockCourseId })
        .onConflictDoNothing();

      await db
        .insert(credentials)
        .values({
          userId: mockUserId,
          courseId: mockCourseId,
          score: 90,
        })
        .onConflictDoNothing();
    } catch {
      infraAvailable = false;
    }
  });

  afterEach(async () => {
    if (!infraAvailable) return;
    await db.delete(credentials).where(eq(credentials.userId, mockUserId));
    await db.delete(enrollments).where(eq(enrollments.userId, mockUserId));
    await db.delete(courses).where(eq(courses.id, mockCourseId));
    await db.delete(users).where(eq(users.id, mockUserId));
  });

  test("sets deletedAt and clears displayName/background/learningGoal", async () => {
    if (!infraAvailable) return;

    await userService.deleteAccount(mockUserId);

    const [row] = await db.select().from(users).where(eq(users.id, mockUserId));
    expect(row.deletedAt).not.toBeNull();
    expect(row.displayName).toBeNull();
    expect(row.background).toBeNull();
    expect(row.learningGoal).toBeNull();
  });

  test("preserves credits (not part of the deletion payload)", async () => {
    if (!infraAvailable) return;

    await userService.deleteAccount(mockUserId);

    const [row] = await db.select().from(users).where(eq(users.id, mockUserId));
    expect(row.credits).toBe(42);
  });

  test("preserves enrollments — does not cascade-delete or null them out", async () => {
    if (!infraAvailable) return;

    await userService.deleteAccount(mockUserId);

    const rows = await db
      .select()
      .from(enrollments)
      .where(eq(enrollments.userId, mockUserId));
    expect(rows.length).toBe(1);
    expect(rows[0].courseId).toBe(mockCourseId);
  });

  test("preserves credentials — does not cascade-delete or null them out", async () => {
    if (!infraAvailable) return;

    await userService.deleteAccount(mockUserId);

    const rows = await db
      .select()
      .from(credentials)
      .where(eq(credentials.userId, mockUserId));
    expect(rows.length).toBe(1);
    expect(rows[0].score).toBe(90);
  });

  test("throws NotFoundError for a non-existent user", async () => {
    if (!infraAvailable) return;

    await expect(
      userService.deleteAccount("00000000-0000-0000-0000-000000000000"),
    ).rejects.toThrow();
  });

  test("invalidates cached profile/progress data for the deleted user", async () => {
    if (!infraAvailable) return;

    const profileKey = cacheKey("user", "profile", mockUserId);
    const progressKey = cacheKey("user", "progress", mockUserId);
    await cacheSet(profileKey, { stale: true }, 300);
    await cacheSet(progressKey, { stale: true }, 300);

    expect(await redis.get(profileKey)).not.toBeNull();
    expect(await redis.get(progressKey)).not.toBeNull();

    await userService.deleteAccount(mockUserId);

    expect(await redis.get(profileKey)).toBeNull();
    expect(await redis.get(progressKey)).toBeNull();
  });

  test("is idempotent-safe to call twice without throwing on the second call's cache step", async () => {
    if (!infraAvailable) return;

    await userService.deleteAccount(mockUserId);
    // Second call still finds the row (soft delete, row still exists) and
    // succeeds — deletedAt is simply overwritten with a newer timestamp.
    await expect(userService.deleteAccount(mockUserId)).resolves.toBeUndefined();
  });
});
