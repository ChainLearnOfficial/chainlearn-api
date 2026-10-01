import { and, count, desc, gte, ilike, isNull, or, eq, sql } from "drizzle-orm";
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
   * #476: this used to be a SELECT-then-UPDATE — read `credits`, check
   * `credits >= amount` in application code, then a separate UPDATE wrote
   * `credits - amount`. Between the SELECT and the UPDATE, a concurrent
   * writer (another deduction, or a reward/grant credit) could change the
   * balance, so by the time the UPDATE ran the check was stale: the UPDATE's
   * WHERE clause didn't re-enforce sufficiency, so two concurrent deductions
   * could both pass their (now-stale) check and together drive credits
   * negative.
   *
   * Fixed the same way grantCredits already avoids the analogous race: one
   * atomic UPDATE. The WHERE clause enforces `credits >= amount` at the
   * database level (in addition to the id/not-deleted match), so Postgres's
   * row lock for the UPDATE is what actually serializes concurrent
   * deductions — there's no window between "check" and "act" because they're
   * the same statement. If two deductions race for a balance that can only
   * afford one of them, exactly one UPDATE matches the WHERE and returns a
   * row; the other matches nothing and `returning` comes back empty.
   *
   * An empty `returning` is then ambiguous between "user doesn't exist /
   * already soft-deleted" and "balance was insufficient" — the WHERE clause
   * can't distinguish them, since both make zero rows match. Existence
   * itself isn't racy the way the balance check was (nothing turns a valid
   * userId into an invalid one mid-request, short of an admin racing this
   * same call with a delete), so a preliminary `SELECT id` is safe and lets
   * the error message be precise without reintroducing the TOCTOU: it can
   * only ever make this method THROW SOONER on a case that would have
   * failed anyway, never allow an over-deduction to slip through.
   * The balance check and the deduction are a single atomic UPDATE (#476):
   * `WHERE credits >= amount` guards the row itself, so a concurrent grant or
   * deduction between "check" and "act" can no longer let credits go
   * negative — there is no window between the two, because there's no
   * "two" anymore. A `returning` miss means either the user doesn't exist
   * (or is soft-deleted) or the balance was insufficient; a follow-up read
   * distinguishes those two only to pick the right error, not to decide
   * whether to deduct.
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
    // Existence check only — not racy, see the note above. Deliberately
    // does NOT read `credits` here: any balance read here would be exactly
    // the stale value the atomic UPDATE below is written to not depend on.
    const [existing] = await db
      .select({ id: users.id })
      .from(users)
      .where(and(eq(users.id, userId), isNull(users.deletedAt)));

    if (!existing) {
      throw new NotFoundError("User");
    }

    // Single atomic UPDATE: the WHERE clause's `credits >= amount` guard is
    // enforced by Postgres under the row lock the UPDATE takes, so there is
    // no gap between checking the balance and acting on it.
    const [updated] = await db
      .update(users)
      .set({
        credits: sql`${users.credits} - ${amount}`,
        updatedAt: new Date(),
      })
      .where(
        and(
          eq(users.id, userId),
          isNull(users.deletedAt),
          sql`${users.credits} >= ${amount}`,
          gte(users.credits, amount),
        ),
      )
      .returning({
        id: users.id,
        credits: users.credits,
      });

    if (!updated) {
      // The preliminary existence check above passed, so getting here means
      // the WHERE guard's balance condition is what didn't match: the
      // balance dropped below `amount` sometime between the existence check
      // and this UPDATE (concurrent deduction) or was already insufficient.
      // Re-read the current balance only for the error message — this read
      // has no bearing on the deduction decision itself, which the atomic
      // UPDATE above already made.
      const [user] = await db
        .select({ credits: users.credits })
        .from(users)
        .where(and(eq(users.id, userId), isNull(users.deletedAt)));

      if (!user) {
        throw new NotFoundError("User");
      }

      throw new ValidationError({
        amount: [
          `Insufficient credits. User has ${user.credits} but deduction of ${amount} was requested`,
        ],
      });
    }

    const creditsBefore = updated.credits + amount;
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
