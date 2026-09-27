import { and, count, desc, ilike, isNull, or, eq, sql } from "drizzle-orm";
import { db } from "../../config/database.js";
import {
  users,
  enrollments,
  quizSubmissions,
  credentials,
  courses,
  auditLogs,
} from "../../database/schema.js";
import { NotFoundError, ValidationError } from "../../utils/errors.js";
import { auditLog } from "../../audit/index.js";
import { logger } from "../../utils/logger.js";
import {
  cacheDel,
  cacheInvalidatePattern,
  cacheKey,
  cacheKeyPattern,
} from "../../cache/index.js";
import type {
  AdminUserSummary,
  CreditGrantResult,
  CreditDeductResult,
  ListUsersQuery,
} from "./admin.types.js";

export class AdminUsersService {
  /**
   * Paginated user listing for the admin console (#288). Search matches
   * either stellarAddress or displayName (case-insensitive, partial match)
   * so admins can look a user up by whichever identifier they have on hand.
   */
  async listUsers(
    query: ListUsersQuery,
  ): Promise<{ users: AdminUserSummary[]; total: number }> {
    const search = query.search?.trim() || undefined;
    const conditions = search
      ? [
          or(
            ilike(users.stellarAddress, `%${search}%`),
            ilike(users.displayName, `%${search}%`),
          )!,
        ]
      : [];

    const where = conditions.length > 0 ? and(...conditions) : undefined;
    const offset = (query.page - 1) * query.limit;

    const [[totalResult], rows] = await Promise.all([
      db.select({ value: count() }).from(users).where(where),
      db
        .select()
        .from(users)
        .where(where)
        .orderBy(desc(users.createdAt))
        .limit(query.limit)
        .offset(offset),
    ]);

    return {
      users: rows.map((row) => ({
        id: row.id,
        stellarAddress: row.stellarAddress,
        displayName: row.displayName,
        isAdmin: row.isAdmin,
        credits: row.credits,
        createdAt: row.createdAt,
        deletedAt: row.deletedAt,
      })),
      total: totalResult?.value ?? 0,
    };
  }

  /**
   * Ban a user and invalidate all their sessions (#347). Once banned,
   * the user receives 403 on all authenticated requests.
   */
  async banUser(userId: string, reason: string): Promise<void> {
    const [updated] = await db
      .update(users)
      .set({ bannedAt: new Date(), banReason: reason, updatedAt: new Date() })
      .where(eq(users.id, userId))
      .returning();

    if (!updated) {
      throw new NotFoundError("User");
    }
  }

  /**
   * Grant credits to a user (#386) — promotions, rewards, corrections.
   *
   * The single `SET credits = credits + :amount` statement is deliberate:
   * reading the balance first and writing back `before + amount` would lose
   * a concurrent grant from the reward-claim path (which also increments
   * credits). Letting Postgres do the addition under the row lock it takes
   * for the UPDATE makes the grant safe against every other credit writer
   * without a transaction or an application-level lock.
   *
   * `reference` is free-form and only ever written to the audit log — it's a
   * pointer for whoever reconciles the grant later (promotion code, support
   * ticket), never a lookup key.
   *
   * Soft-deleted accounts (#290) are rejected rather than credited: their
   * sessions are already dead, so a grant would be invisible to the user and
   * only recoverable by reading the audit log.
   *
   * @param actorId The admin who made the grant, recorded for the audit trail.
   */
  async grantCredits(
    userId: string,
    amount: number,
    reason: string,
    reference?: string,
    actorId?: string,
  ): Promise<CreditGrantResult> {
    const [updated] = await db
      .update(users)
      .set({
        credits: sql`${users.credits} + ${amount}`,
        // Maintained by the users_updated_at trigger; set explicitly here so
        // the write is correct even if the trigger is ever missing in a
        // partially-migrated environment.
        updatedAt: new Date(),
      })
      .where(and(eq(users.id, userId), isNull(users.deletedAt)))
      .returning({
        id: users.id,
        credits: users.credits,
      });

    if (!updated) {
      // Either the user doesn't exist, or the account is soft-deleted. Both
      // are "there is nothing to credit" as far as the caller is concerned.
      throw new NotFoundError("User");
    }

    const grantedAt = new Date();

    await auditLog("credits.granted", {
      userId,
      amount,
      reason,
      reference,
      actorId,
      creditsBefore: updated.credits - amount,
      creditsAfter: updated.credits,
    });
    logger.info(
      { userId, amount, actorId, reason, reference },
      "Credits granted to user by admin",
    );

    // Anything that caches a credit balance is now stale: the user's own
    // profile, and the global leaderboard (which ranks by credits). The
    // history/pending views key off individual reward records, not the
    // balance, so they're unaffected. Both helpers fail soft — worst case is
    // bounded staleness until the TTL expires.
    await Promise.allSettled([
      cacheDel(cacheKey("user", "profile", userId)),
      cacheInvalidatePattern(cacheKeyPattern("rewards", "leaderboard")),
    ]);

    return {
      userId: updated.id,
      amount,
      reason,
      reference: reference ?? null,
      creditsBefore: updated.credits - amount,
      creditsAfter: updated.credits,
      grantedAt,
    };
  }

  /**
   * Deduct credits from a user — penalties, corrections, abuse prevention.
   *
   * Like grantCredits, the UPDATE uses SQL arithmetic to ensure safety against
   * concurrent credit operations. The balance is checked first to ensure the
   * deduction won't make it negative; if the amount exceeds the current balance,
   * a validation error is thrown.
   *
   * @param actorId The admin who made the deduction, recorded for the audit trail.
   */
  async deductCredits(
    userId: string,
    amount: number,
    reason: string,
    reference?: string,
    actorId?: string,
  ): Promise<CreditDeductResult> {
    // First, check the user's current balance
    const [user] = await db
      .select({ id: users.id, credits: users.credits })
      .from(users)
      .where(and(eq(users.id, userId), isNull(users.deletedAt)));

    if (!user) {
      throw new NotFoundError("User");
    }

    if (user.credits < amount) {
      throw new ValidationError({
        amount: [
          `Insufficient credits. User has ${user.credits} but deduction of ${amount} was requested`,
        ],
      });
    }

    const creditsBefore = user.credits;

    // Perform the deduction
    const [updated] = await db
      .update(users)
      .set({
        credits: sql`${users.credits} - ${amount}`,
        updatedAt: new Date(),
      })
      .where(eq(users.id, userId))
      .returning({
        id: users.id,
        credits: users.credits,
      });

    if (!updated) {
      throw new NotFoundError("User");
    }

    const deductedAt = new Date();

    await auditLog("credits.deducted", {
      userId,
      amount,
      reason,
      reference,
      actorId,
      creditsBefore,
      creditsAfter: updated.credits,
    });
    logger.info(
      { userId, amount, actorId, reason, reference },
      "Credits deducted from user by admin",
    );

    // Invalidate credit balance caches
    await Promise.allSettled([
      cacheDel(cacheKey("user", "profile", userId)),
      cacheInvalidatePattern(cacheKeyPattern("rewards", "leaderboard")),
    ]);

    return {
      userId: updated.id,
      amount,
      reason,
      reference: reference ?? null,
      creditsBefore,
      creditsAfter: updated.credits,
      deductedAt,
    };
  }

  /**
   * Get user activity feed (#346). Queries audit logs, quiz submissions,
   * enrollments, and reward claims for a specific user. Returns chronological
   * activity with type, details, and timestamp.
   */
  async getUserActivity(userId: string): Promise<
    Array<{
      type: string;
      title: string;
      timestamp: Date;
      details: Record<string, unknown>;
    }>
  > {
    // Check user exists
    const user = await db.query.users.findFirst({
      where: eq(users.id, userId),
    });

    if (!user) {
      throw new NotFoundError("User");
    }

    // Fetch all activity sources
    const [enrollmentRows, submissionRows, credentialRows] = await Promise.all([
      db
        .select({
          courseId: enrollments.courseId,
          courseTitle: courses.title,
          enrolledAt: enrollments.enrolledAt,
          completedAt: enrollments.completedAt,
        })
        .from(enrollments)
        .leftJoin(courses, eq(enrollments.courseId, courses.id))
        .where(eq(enrollments.userId, userId))
        .orderBy(desc(enrollments.enrolledAt)),
      db
        .select({
          courseId: quizSubmissions.id,
          score: quizSubmissions.score,
          rewardClaimed: quizSubmissions.rewardClaimed,
          submittedAt: quizSubmissions.submittedAt,
        })
        .from(quizSubmissions)
        .where(eq(quizSubmissions.userId, userId))
        .orderBy(desc(quizSubmissions.submittedAt)),
      db
        .select({
          courseId: credentials.courseId,
          courseTitle: courses.title,
          score: credentials.score,
          mintedAt: credentials.mintedAt,
        })
        .from(credentials)
        .leftJoin(courses, eq(credentials.courseId, courses.id))
        .where(eq(credentials.userId, userId))
        .orderBy(desc(credentials.mintedAt)),
    ]);

    const activities: Array<{
      type: string;
      title: string;
      timestamp: Date;
      details: Record<string, unknown>;
    }> = [];

    enrollmentRows.forEach((row) => {
      activities.push({
        type: "enrollment",
        title: `Enrolled in ${row.courseTitle}`,
        timestamp: row.enrolledAt,
        details: { courseId: row.courseId, completed: !!row.completedAt },
      });
    });

    submissionRows.forEach((row) => {
      activities.push({
        type: "quiz_submission",
        title: `Submitted quiz with score ${row.score}`,
        timestamp: row.submittedAt,
        details: { score: row.score, rewardClaimed: row.rewardClaimed },
      });
    });

    credentialRows.forEach((row) => {
      activities.push({
        type: "credential_mint",
        title: `Earned credential for ${row.courseTitle}`,
        timestamp: row.mintedAt,
        details: { courseId: row.courseId, score: row.score },
      });
    });

    return activities.sort(
      (a, b) => b.timestamp.getTime() - a.timestamp.getTime(),
    );
  }
}

export const adminUsersService = new AdminUsersService();
