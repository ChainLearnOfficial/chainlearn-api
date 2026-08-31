/**
 * Tests for dropEnrollment and the waitlist-notification gap-fill (#310).
 *
 * Join/leave/status for the waitlist itself (POST/DELETE/GET
 * /api/v1/courses/:id/waitlist) are already covered by
 * tests/e2e/course-waitlist.test.ts against WaitlistService (added
 * alongside #320/#323). This file covers the piece that was still
 * missing: CourseService.dropEnrollment — the companion action to
 * enroll() needed to give "a spot opens up" concrete meaning — and that
 * it identifies the head of the waitlist via WaitlistService and records
 * it (there's currently no notifications table to write a user-facing
 * notification to, so this asserts the audit-log record instead).
 */
import { test, describe, expect, beforeEach, afterEach } from "vitest";
import { courseService } from "../modules/courses/course.service.js";
import { waitlistService } from "../modules/courses/waitlist.service.js";
import { NotFoundError } from "../utils/errors.js";
import { db } from "../config/database.js";
import { redis } from "../config/redis.js";
import {
  courses,
  enrollments,
  users,
  enrollmentWaitlist,
  auditLogs,
} from "../database/schema.js";
import { eq, inArray, and, desc } from "drizzle-orm";

describe("CourseService.dropEnrollment + waitlist notification gap-fill (#310)", () => {
  const courseId = "d9999999-2222-4b92-b60d-8848db490a22";

  const userAId = "d9999999-1111-4ef8-bb6d-6bb9bd380a01";
  const userBId = "d9999999-1111-4ef8-bb6d-6bb9bd380a02";
  const userIds = [userAId, userBId];

  let infraAvailable = true;

  beforeEach(async () => {
    try {
      await redis.flushdb();

      await db
        .insert(users)
        .values([
          { id: userAId, stellarAddress: "GWAITLIST0000000000000000000000000000000000000000000A", displayName: "Waitlist A" },
          { id: userBId, stellarAddress: "GWAITLIST0000000000000000000000000000000000000000000B", displayName: "Waitlist B" },
        ])
        .onConflictDoNothing();

      await db
        .insert(courses)
        .values({
          id: courseId,
          title: "Waitlist Test Course",
          description: "For #310 tests",
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
    await db.delete(auditLogs).where(eq(auditLogs.event, "course.waitlist.notified"));
    await db.delete(auditLogs).where(eq(auditLogs.event, "course.enrollment_dropped"));
    await db.delete(enrollmentWaitlist).where(eq(enrollmentWaitlist.courseId, courseId));
    await db.delete(enrollments).where(eq(enrollments.courseId, courseId));
    await db.delete(courses).where(eq(courses.id, courseId));
    await db.delete(users).where(inArray(users.id, userIds));
  });

  test("throws NotFoundError dropping an enrollment that doesn't exist", async () => {
    if (!infraAvailable) return;
    await expect(courseService.dropEnrollment(userAId, courseId)).rejects.toThrow(
      NotFoundError,
    );
  });

  test("deletes the enrollment row", async () => {
    if (!infraAvailable) return;
    await db.insert(enrollments).values({ userId: userAId, courseId }).onConflictDoNothing();

    await courseService.dropEnrollment(userAId, courseId);

    const [enrollment] = await db
      .select()
      .from(enrollments)
      .where(eq(enrollments.userId, userAId));
    expect(enrollment).toBeUndefined();
  });

  test("identifies the waitlist head via WaitlistService and records it in the audit log", async () => {
    if (!infraAvailable) return;
    await db.insert(enrollments).values({ userId: userAId, courseId }).onConflictDoNothing();
    await waitlistService.joinWaitlist(userBId, courseId);

    await courseService.dropEnrollment(userAId, courseId);

    const [entry] = await db
      .select()
      .from(auditLogs)
      .where(and(eq(auditLogs.event, "course.waitlist.notified")))
      .orderBy(desc(auditLogs.createdAt))
      .limit(1);

    expect(entry).toBeDefined();
    expect(entry.fields).toMatchObject({ userId: userBId, courseId });

    // userB stays queued — they're only removed once they actually enroll.
    const stillWaiting = await db
      .select()
      .from(enrollmentWaitlist)
      .where(eq(enrollmentWaitlist.userId, userBId));
    expect(stillWaiting).toHaveLength(1);
  });

  test("does not throw and records nothing when the waitlist is empty", async () => {
    if (!infraAvailable) return;
    await db.insert(enrollments).values({ userId: userAId, courseId }).onConflictDoNothing();

    await expect(courseService.dropEnrollment(userAId, courseId)).resolves.toBeUndefined();

    const notified = await db
      .select()
      .from(auditLogs)
      .where(eq(auditLogs.event, "course.waitlist.notified"));
    expect(notified).toHaveLength(0);
  });

  test("enrolling removes the user from the waitlist (WaitlistService.removeFromWaitlist, called by enroll())", async () => {
    if (!infraAvailable) return;
    await waitlistService.joinWaitlist(userAId, courseId);

    await courseService.enroll(userAId, courseId);

    const remaining = await db
      .select()
      .from(enrollmentWaitlist)
      .where(eq(enrollmentWaitlist.userId, userAId));
    expect(remaining).toHaveLength(0);
  });
});
