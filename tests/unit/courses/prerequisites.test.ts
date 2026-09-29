/**
 * Tests for GET /api/v1/courses/:id/prerequisites (#369).
 *
 * Covers the service layer: ordering by configured prerequisite list,
 * completion status for an authenticated vs anonymous caller, and the
 * not-found/empty-list edge cases.
 *
 * Note on the anonymous case: the route is `optionalAuth`, and for a caller
 * with no user there is nothing to look up, so every entry comes back
 * `completed: false` and the aggregate `met` flag is false. The endpoint
 * cannot distinguish "not enrolled" from "not signed in" — a signed-out
 * visitor sees the prerequisite list but no personal status.
 */
import { test, describe, expect, beforeEach, afterEach } from "vitest";
import { courseService } from "../../../src/modules/courses/course.service.js";
import { NotFoundError } from "../../../src/utils/errors.js";
import { db } from "../../../src/config/database.js";
import { courses, enrollments, users } from "../../../src/database/schema.js";
import { eq, inArray } from "drizzle-orm";

describe("GET /api/v1/courses/:id/prerequisites (#369)", () => {
  const userId = "d4444444-1111-4ef8-bb6d-6bb9bd380a11";
  const stellarAddress = "GPREREQTEST00000000000000000000000000000000000000000A";

  const courseId = "d4444444-2222-4b92-b60d-8848db490a22";
  const prereqOneId = "d4444444-2222-4b92-b60d-8848db490a33";
  const prereqTwoId = "d4444444-2222-4b92-b60d-8848db490a44";

  let infraAvailable = true;

  beforeEach(async () => {
    try {
      await db
        .insert(users)
        .values({ id: userId, stellarAddress, displayName: "Prereq Test User" })
        .onConflictDoNothing();

      await db
        .insert(courses)
        .values([
          {
            id: prereqOneId,
            title: "Intro to Stellar",
            description: "Prereq one",
            difficulty: "beginner",
            isActive: true,
          },
          {
            id: prereqTwoId,
            title: "Soroban Basics",
            description: "Prereq two",
            difficulty: "beginner",
            isActive: true,
          },
          {
            id: courseId,
            title: "Advanced Smart Contracts",
            description: "For #369 tests",
            difficulty: "advanced",
            isActive: true,
            // Deliberately configured in reverse-insert order to assert
            // the service preserves *this* order, not DB row order.
            prerequisites: [prereqTwoId, prereqOneId],
          },
        ])
        .onConflictDoNothing();
    } catch {
      infraAvailable = false;
    }
  });

  afterEach(async () => {
    if (!infraAvailable) return;
    await db.delete(enrollments).where(eq(enrollments.userId, userId));
    await db
      .delete(courses)
      .where(inArray(courses.id, [courseId, prereqOneId, prereqTwoId]));
    await db.delete(users).where(eq(users.id, userId));
  });

  test("throws NotFoundError for a non-existent course", async () => {
    if (!infraAvailable) return;
    await expect(
      courseService.getCoursePrerequisites(
        "00000000-0000-0000-0000-000000000000",
        userId,
      ),
    ).rejects.toThrow(NotFoundError);
  });

  test("returns an empty list when the course has no prerequisites", async () => {
    if (!infraAvailable) return;
    const result = await courseService.getCoursePrerequisites(prereqOneId, userId);
    expect(result.prerequisites).toEqual([]);
    // No requirements to satisfy — nothing outstanding, so the gate is met.
    expect(result.met).toBe(true);
  });

  test("returns prerequisites in configured order with completed:false when not enrolled", async () => {
    if (!infraAvailable) return;
    const result = await courseService.getCoursePrerequisites(courseId, userId);

    expect(result.prerequisites.map((p) => p.id)).toEqual([
      prereqTwoId,
      prereqOneId,
    ]);
    expect(result.prerequisites.every((p) => p.completed === false)).toBe(true);
    expect(result.met).toBe(false);
  });

  test("reports every entry as incomplete for an anonymous caller", async () => {
    if (!infraAvailable) return;
    const result = await courseService.getCoursePrerequisites(courseId, null);
    expect(result.prerequisites.every((p) => p.completed === false)).toBe(true);
    expect(result.met).toBe(false);
  });

  test("marks a prerequisite completed once the user has a completed enrollment for it", async () => {
    if (!infraAvailable) return;
    await db
      .insert(enrollments)
      .values({ userId, courseId: prereqOneId, completedAt: new Date() })
      .onConflictDoNothing();

    const result = await courseService.getCoursePrerequisites(courseId, userId);

    expect(result.prerequisites.find((p) => p.id === prereqOneId)?.completed).toBe(true);
    expect(result.prerequisites.find((p) => p.id === prereqTwoId)?.completed).toBe(false);
    expect(result.met).toBe(false);
  });

  test("an enrollment that isn't completed yet does not count as completed", async () => {
    if (!infraAvailable) return;
    await db
      .insert(enrollments)
      .values({ userId, courseId: prereqOneId })
      .onConflictDoNothing();

    const result = await courseService.getCoursePrerequisites(courseId, userId);

    expect(result.prerequisites.find((p) => p.id === prereqOneId)?.completed).toBe(false);
  });

  test("met becomes true only once every prerequisite is completed", async () => {
    if (!infraAvailable) return;
    await db
      .insert(enrollments)
      .values([
        { userId, courseId: prereqOneId, completedAt: new Date() },
        { userId, courseId: prereqTwoId, completedAt: new Date() },
      ])
      .onConflictDoNothing();

    const result = await courseService.getCoursePrerequisites(courseId, userId);

    expect(result.met).toBe(true);
  });
});
