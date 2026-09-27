import { eq, and, count, asc, desc, isNotNull, sql } from "drizzle-orm";
import { db } from "../../config/database.js";
import {
  badges,
  userBadges,
  enrollments,
  quizzes,
  quizSubmissions,
  credentials,
  users,
} from "../../database/schema.js";
import { NotFoundError } from "../../utils/errors.js";
import { logger } from "../../utils/logger.js";
import { auditLog } from "../../audit/index.js";
import { notificationService } from "../notifications/notification.service.js";
import type {
  CreateBadgeBody,
  UpdateBadgeBody,
  BadgeDefinition,
  EarnedBadge,
  UnearnedBadge,
  UserBadgesResponse,
  BadgeProgress,
} from "./badge.types.js";

export class BadgeService {
  private toBadgeDefinition(row: typeof badges.$inferSelect): BadgeDefinition {
    return {
      id: row.id,
      name: row.name,
      description: row.description,
      iconUrl: row.iconUrl,
      type: row.type,
      criteria: row.criteria,
      createdAt: row.createdAt,
      updatedAt: row.updatedAt,
    };
  }

  // ─── Admin Operations (#380) ──────────────────────────────────────────────

  /**
   * Create a new badge definition (admin only, #380).
   */
  async createBadge(data: CreateBadgeBody): Promise<BadgeDefinition> {
    const [badge] = await db
      .insert(badges)
      .values({
        name: data.name,
        description: data.description,
        iconUrl: data.iconUrl,
        type: data.type,
        criteria: data.criteria,
      })
      .returning();

    await auditLog("badge.created", {
      badgeId: badge.id,
      badgeType: badge.type,
      badgeName: badge.name,
    });
    logger.info(
      { badgeId: badge.id, name: badge.name, type: badge.type },
      "Badge definition created",
    );

    return this.toBadgeDefinition(badge);
  }

  /**
   * List all badge definitions (admin, #380).
   */
  async listBadges(): Promise<BadgeDefinition[]> {
    const rows = await db
      .select()
      .from(badges)
      .orderBy(asc(badges.createdAt));

    return rows.map((r) => this.toBadgeDefinition(r));
  }

  /**
   * Get a badge definition by ID.
   */
  async getBadge(id: string): Promise<BadgeDefinition> {
    const [badge] = await db
      .select()
      .from(badges)
      .where(eq(badges.id, id));

    if (!badge) {
      throw new NotFoundError("Badge");
    }

    return this.toBadgeDefinition(badge);
  }

  /**
   * Update a badge definition (admin only, #380).
   */
  async updateBadge(
    id: string,
    data: UpdateBadgeBody,
  ): Promise<BadgeDefinition> {
    const updateValues: Partial<typeof badges.$inferInsert> = {
      updatedAt: new Date(),
    };
    if (data.name !== undefined) updateValues.name = data.name;
    if (data.description !== undefined) updateValues.description = data.description;
    if (data.iconUrl !== undefined) updateValues.iconUrl = data.iconUrl;
    if (data.type !== undefined) updateValues.type = data.type;
    if (data.criteria !== undefined) updateValues.criteria = data.criteria;

    const [updated] = await db
      .update(badges)
      .set(updateValues)
      .where(eq(badges.id, id))
      .returning();

    if (!updated) {
      throw new NotFoundError("Badge");
    }

    await auditLog("badge.updated", {
      badgeId: id,
      badgeType: updated.type,
      badgeName: updated.name,
    });
    logger.info({ badgeId: id, name: updated.name }, "Badge definition updated");

    return this.toBadgeDefinition(updated);
  }

  /**
   * Delete a badge definition (admin only, #380).
   */
  async deleteBadge(id: string): Promise<void> {
    const [deleted] = await db
      .delete(badges)
      .where(eq(badges.id, id))
      .returning();

    if (!deleted) {
      throw new NotFoundError("Badge");
    }

    await auditLog("badge.deleted", {
      badgeId: id,
      badgeName: deleted.name,
    });
    logger.info({ badgeId: id }, "Badge definition deleted");
  }

  // ─── User Badge Progress & Evaluation (#379) ─────────────────────────────

  /**
   * Automatically evaluates criteria for all unearned badges for a user and
   * awards newly unlocked ones, triggering a notification for each (#379).
   */
  async evaluateUserBadges(userId: string): Promise<void> {
    // 1. Check if user exists
    const [user] = await db
      .select({ id: users.id })
      .from(users)
      .where(eq(users.id, userId));

    if (!user) return;

    // 2. Fetch user activity metrics
    const [
      [enrollmentRow],
      [completedCourseRow],
      [quizRow],
      [credentialRow],
    ] = await Promise.all([
      db
        .select({ value: count() })
        .from(enrollments)
        .where(eq(enrollments.userId, userId)),
      db
        .select({ value: count() })
        .from(enrollments)
        .where(
          and(
            eq(enrollments.userId, userId),
            isNotNull(enrollments.completedAt),
          ),
        ),
      db
        .select({ value: count() })
        .from(quizSubmissions)
        .where(
          and(
            eq(quizSubmissions.userId, userId),
            eq(quizSubmissions.superseded, false),
          ),
        ),
      db
        .select({ value: count() })
        .from(credentials)
        .where(
          and(
            eq(credentials.userId, userId),
            eq(credentials.revoked, false),
          ),
        ),
    ]);

    const enrollmentCount = enrollmentRow?.value ?? 0;
    const completedCourseCount = completedCourseRow?.value ?? 0;
    const quizCompletionCount = quizRow?.value ?? 0;
    const credentialCount = credentialRow?.value ?? 0;
    const streakCount = Math.max(
      completedCourseCount > 0 || quizCompletionCount > 0 ? 1 : 0,
      1,
    );

    // 3. Fetch all badge definitions
    const allBadges = await db.select().from(badges);
    if (allBadges.length === 0) return;

    // 4. Fetch already earned badges
    const earnedRows = await db
      .select()
      .from(userBadges)
      .where(eq(userBadges.userId, userId));
    const earnedBadgeIds = new Set(earnedRows.map((r) => r.badgeId));

    // 5. Evaluate unearned badges
    for (const badge of allBadges) {
      if (earnedBadgeIds.has(badge.id)) continue;

      const progress = this.calculateProgress(
        badge,
        enrollmentCount,
        completedCourseCount,
        quizCompletionCount,
        credentialCount,
        streakCount,
      );

      if (progress.current >= progress.target) {
        try {
          await db
            .insert(userBadges)
            .values({
              userId,
              badgeId: badge.id,
              earnedAt: new Date(),
              progress: {
                current: progress.current,
                target: progress.target,
                percentage: 100,
              },
            })
            .onConflictDoNothing();

          // Trigger in-app notification (#379)
          await notificationService.create({
            userId,
            type: "badge_earned",
            title: `Badge Unlocked: ${badge.name}`,
            message: `Congratulations! You've unlocked the "${badge.name}" badge: ${badge.description}`,
          });

          await auditLog("badge.awarded", {
            userId,
            badgeId: badge.id,
            badgeName: badge.name,
          });

          logger.info(
            { userId, badgeId: badge.id, badgeName: badge.name },
            "Badge awarded to user",
          );
        } catch (err) {
          logger.warn(
            { err, userId, badgeId: badge.id },
            "Failed to award badge or dispatch notification",
          );
        }
      }
    }
  }

  /**
   * Returns a user's earned badges with earned dates and progress towards unearned badges (#379).
   */
  async getUserBadges(userId: string): Promise<UserBadgesResponse> {
    // Run automated evaluation first
    await this.evaluateUserBadges(userId);

    // Fetch user activity metrics
    const [
      [enrollmentRow],
      [completedCourseRow],
      [quizRow],
      [credentialRow],
    ] = await Promise.all([
      db
        .select({ value: count() })
        .from(enrollments)
        .where(eq(enrollments.userId, userId)),
      db
        .select({ value: count() })
        .from(enrollments)
        .where(
          and(
            eq(enrollments.userId, userId),
            isNotNull(enrollments.completedAt),
          ),
        ),
      db
        .select({ value: count() })
        .from(quizSubmissions)
        .where(
          and(
            eq(quizSubmissions.userId, userId),
            eq(quizSubmissions.superseded, false),
          ),
        ),
      db
        .select({ value: count() })
        .from(credentials)
        .where(
          and(
            eq(credentials.userId, userId),
            eq(credentials.revoked, false),
          ),
        ),
    ]);

    const enrollmentCount = enrollmentRow?.value ?? 0;
    const completedCourseCount = completedCourseRow?.value ?? 0;
    const quizCompletionCount = quizRow?.value ?? 0;
    const credentialCount = credentialRow?.value ?? 0;
    const streakCount = Math.max(
      completedCourseCount > 0 || quizCompletionCount > 0 ? 1 : 0,
      1,
    );

    const [allBadges, earnedRecords] = await Promise.all([
      db.select().from(badges).orderBy(asc(badges.createdAt)),
      db
        .select({
          badgeId: userBadges.badgeId,
          earnedAt: userBadges.earnedAt,
          progress: userBadges.progress,
        })
        .from(userBadges)
        .where(eq(userBadges.userId, userId)),
    ]);

    const earnedMap = new Map(earnedRecords.map((r) => [r.badgeId, r]));

    const earned: EarnedBadge[] = [];
    const unearned: UnearnedBadge[] = [];

    for (const badge of allBadges) {
      const earnedRecord = earnedMap.get(badge.id);
      if (earnedRecord) {
        earned.push({
          id: badge.id,
          name: badge.name,
          description: badge.description,
          iconUrl: badge.iconUrl,
          type: badge.type,
          earnedAt: earnedRecord.earnedAt,
          progress: {
            current: 1,
            target: 1,
            percentage: 100,
          },
        });
      } else {
        const progress = this.calculateProgress(
          badge,
          enrollmentCount,
          completedCourseCount,
          quizCompletionCount,
          credentialCount,
          streakCount,
        );

        unearned.push({
          id: badge.id,
          name: badge.name,
          description: badge.description,
          iconUrl: badge.iconUrl,
          type: badge.type,
          criteria: badge.criteria,
          progress,
        });
      }
    }

    return {
      earned,
      unearned,
      totalEarned: earned.length,
      totalAvailable: allBadges.length,
    };
  }

  private calculateProgress(
    badge: typeof badges.$inferSelect,
    enrollmentCount: number,
    completedCourseCount: number,
    quizCompletionCount: number,
    credentialCount: number,
    streakCount: number,
  ): BadgeProgress {
    let current = 0;
    let target = Number(badge.criteria.count ?? 1);
    if (isNaN(target) || target < 1) target = 1;

    switch (badge.type) {
      case "enrollment":
        current = enrollmentCount;
        break;
      case "course_completion":
        current = completedCourseCount;
        break;
      case "quiz_completion":
        current = quizCompletionCount;
        break;
      case "credential":
        current = credentialCount;
        break;
      case "streak":
        current = streakCount;
        target = Number(badge.criteria.count ?? badge.criteria.days ?? 1);
        if (isNaN(target) || target < 1) target = 1;
        break;
      default:
        current = 0;
        break;
    }

    const percentage = Math.min(100, Math.round((current / target) * 100));

    return {
      current,
      target,
      percentage,
    };
  }
}

export const badgeService = new BadgeService();
