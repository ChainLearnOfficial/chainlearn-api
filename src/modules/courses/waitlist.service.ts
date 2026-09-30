import { eq, and, desc, count, gt, sql } from "drizzle-orm";
import { db } from "../../config/database.js";
import { enrollmentWaitlist, enrollments, users, courses } from "../../database/schema.js";
import {
  NotFoundError,
  ConflictError,
  ForbiddenError,
} from "../../utils/errors.js";
import { logger } from "../../utils/logger.js";
import { auditLog } from "../../audit/index.js";
import type {
  WaitlistEntry,
  WaitlistStatus,
  JoinWaitlistResult,
  LeaveWaitlistResult,
} from "./waitlist.types.js";

export class WaitlistService {
  /**
   * Join a course waitlist.
   * User must not already be enrolled or on waitlist.
   * Returns position in waitlist.
   */
  async joinWaitlist(userId: string, courseId: string): Promise<JoinWaitlistResult> {
    // Verify course exists
    const [course] = await db.select().from(courses).where(eq(courses.id, courseId));
    if (!course) {
      throw new NotFoundError("Course");
    }

    // Check if user is already enrolled
    const existingEnrollment = await db.query.enrollments.findFirst({
      where: and(
        eq(enrollments.userId, userId),
        eq(enrollments.courseId, courseId)
      ),
    });

    if (existingEnrollment) {
      throw new ConflictError("User is already enrolled in this course");
    }

    // Check if user is already on waitlist
    const existingWaitlist = await db.query.enrollmentWaitlist.findFirst({
      where: and(
        eq(enrollmentWaitlist.userId, userId),
        eq(enrollmentWaitlist.courseId, courseId)
      ),
    });

    if (existingWaitlist) {
      throw new ConflictError(
        `User is already on the waitlist at position ${existingWaitlist.position}`
      );
    }

    // Get the current max position for this course
    const maxPosResult = await db
      .select({ maxPos: sql<number>`MAX(${enrollmentWaitlist.position})` })
      .from(enrollmentWaitlist)
      .where(eq(enrollmentWaitlist.courseId, courseId));

    const nextPosition = ((maxPosResult[0]?.maxPos as number) ?? 0) + 1;

    // Insert into waitlist
    const [entry] = await db
      .insert(enrollmentWaitlist)
      .values({
        userId,
        courseId,
        position: nextPosition,
      })
      .returning();

    auditLog("course.waitlist.joined", {
      userId,
      courseId,
      position: nextPosition,
    });

    logger.info(
      { userId, courseId, position: nextPosition },
      "User joined course waitlist"
    );

    return {
      success: true,
      position: nextPosition,
      message: `Joined waitlist at position ${nextPosition}`,
    };
  }

  /**
   * Leave a course waitlist.
   * Removes user from waitlist and reorders remaining positions.
   */
  async leaveWaitlist(userId: string, courseId: string): Promise<LeaveWaitlistResult> {
    const entry = await db.query.enrollmentWaitlist.findFirst({
      where: and(
        eq(enrollmentWaitlist.userId, userId),
        eq(enrollmentWaitlist.courseId, courseId)
      ),
    });

    if (!entry) {
      throw new NotFoundError("User is not on the waitlist for this course");
    }

    // Start transaction to ensure atomic removal and position reordering
    await db.transaction(async (tx) => {
      // Delete the entry
      await tx
        .delete(enrollmentWaitlist)
        .where(eq(enrollmentWaitlist.id, entry.id));

      // Reorder positions: decrement all positions after the removed one
      const remainingEntries = await tx
        .select()
        .from(enrollmentWaitlist)
        .where(
          and(
            eq(enrollmentWaitlist.courseId, courseId),
            // Only entries with position > removed position need reordering
            gt(enrollmentWaitlist.position, entry.position)
          )
        )
        .orderBy(enrollmentWaitlist.position);

      for (const remaining of remainingEntries) {
        await tx
          .update(enrollmentWaitlist)
          .set({ position: remaining.position - 1 })
          .where(eq(enrollmentWaitlist.id, remaining.id));
      }
    });

    auditLog("course.waitlist.left", {
      userId,
      courseId,
      previousPosition: entry.position,
    });

    logger.info(
      { userId, courseId, previousPosition: entry.position },
      "User left course waitlist"
    );

    return {
      success: true,
      message: "Left waitlist successfully",
    };
  }

  /**
   * Get the user's waitlist status for a course.
   */
  async getWaitlistStatus(
    userId: string,
    courseId: string
  ): Promise<WaitlistStatus> {
    const totalCountResult = await db
      .select({ count: count() })
      .from(enrollmentWaitlist)
      .where(eq(enrollmentWaitlist.courseId, courseId));

    const userEntry = await db.query.enrollmentWaitlist.findFirst({
      where: and(
        eq(enrollmentWaitlist.userId, userId),
        eq(enrollmentWaitlist.courseId, courseId)
      ),
    });

    return {
      isOnWaitlist: !!userEntry,
      position: userEntry?.position,
      totalOnWaitlist: totalCountResult[0]?.count ?? 0,
    };
  }

  /**
   * Get the full waitlist for a course (admin/system use).
   */
  async getWaitlist(courseId: string): Promise<WaitlistEntry[]> {
    const entries = await db
      .select({
        position: enrollmentWaitlist.position,
        userId: enrollmentWaitlist.userId,
        displayName: users.displayName,
      })
      .from(enrollmentWaitlist)
      .innerJoin(users, eq(enrollmentWaitlist.userId, users.id))
      .where(eq(enrollmentWaitlist.courseId, courseId))
      .orderBy(enrollmentWaitlist.position);

    return entries.map((entry) => ({
      position: entry.position,
      userId: entry.userId,
      displayName: entry.displayName ?? "Anonymous",
    }));
  }

  /**
   * Get the next person on the waitlist for a course (used when enrollment spot opens).
   */
  async getNextOnWaitlist(courseId: string): Promise<WaitlistEntry | null> {
    const [entry] = await db
      .select({
        position: enrollmentWaitlist.position,
        userId: enrollmentWaitlist.userId,
        displayName: users.displayName,
        id: enrollmentWaitlist.id,
      })
      .from(enrollmentWaitlist)
      .innerJoin(users, eq(enrollmentWaitlist.userId, users.id))
      .where(eq(enrollmentWaitlist.courseId, courseId))
      .orderBy(enrollmentWaitlist.position)
      .limit(1);

    if (!entry) return null;

    return {
      position: entry.position,
      userId: entry.userId,
      displayName: entry.displayName ?? "Anonymous",
    };
  }

  /**
   * Remove a user from the waitlist (typically called when they are notified and enroll).
   * Internal method called after successful enrollment.
   */
  async removeFromWaitlist(userId: string, courseId: string): Promise<void> {
    const entry = await db.query.enrollmentWaitlist.findFirst({
      where: and(
        eq(enrollmentWaitlist.userId, userId),
        eq(enrollmentWaitlist.courseId, courseId)
      ),
    });

    if (!entry) return; // Not on waitlist, nothing to do

    await db.transaction(async (tx) => {
      // Delete the entry
      await tx
        .delete(enrollmentWaitlist)
        .where(eq(enrollmentWaitlist.id, entry.id));

      // Reorder remaining positions
      const remainingEntries = await tx
        .select()
        .from(enrollmentWaitlist)
        .where(
          and(
            eq(enrollmentWaitlist.courseId, courseId),
            gt(enrollmentWaitlist.position, entry.position)
          )
        )
        .orderBy(enrollmentWaitlist.position);

      for (const remaining of remainingEntries) {
        await tx
          .update(enrollmentWaitlist)
          .set({ position: remaining.position - 1 })
          .where(eq(enrollmentWaitlist.id, remaining.id));
      }
    });
  }
}

export const waitlistService = new WaitlistService();
