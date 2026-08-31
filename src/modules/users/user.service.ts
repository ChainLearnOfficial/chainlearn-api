import crypto from "node:crypto";
import { mkdir, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { eq, count, sql, desc, and, lt, type SQL } from "drizzle-orm";
import type { AnyPgColumn } from "drizzle-orm/pg-core";
import { db } from "../../config/database.js";
import {
  users,
  enrollments,
  quizSubmissions,
  credentials,
  courses,
  quizzes,
} from "../../database/schema.js";
import { config } from "../../config/index.js";
import { NotFoundError, ValidationError } from "../../utils/errors.js";
import { logger } from "../../utils/logger.js";
import { auditLog } from "../../audit/index.js";
import {
  cacheGet,
  cacheSet,
  cacheDel,
  cacheInvalidatePattern,
  cacheKey,
  cacheKeyPattern,
} from "../../cache/index.js";
import type {
  ActivityQuery,
  AvatarUpload,
  UpdateProfileBody,
  UserActivity,
  UserActivityPage,
  UserProfile,
  UserProgress,
} from "./user.types.js";

export class UserService {
  async getProfile(userId: string): Promise<UserProfile> {
    const namespace = "user";
    const cacheKeyString = cacheKey(namespace, "profile", userId);

    const cachedProfile = await cacheGet<UserProfile>(
      namespace,
      cacheKeyString,
    );
    if (cachedProfile) return cachedProfile;

    const user = await db.query.users.findFirst({
      where: eq(users.id, userId),
    });

    if (!user) {
      throw new NotFoundError("User");
    }

    const profile: UserProfile = {
      id: user.id,
      stellarAddress: user.stellarAddress,
      displayName: user.displayName,
      avatarUrl: user.avatarUrl,
      background: user.background,
      learningGoal: user.learningGoal,
      pace: user.pace ?? "medium",
      language: user.language ?? "en",
      credits: user.credits,
      createdAt: user.createdAt,
    };

    await cacheSet(cacheKeyString, profile, 300);

    return profile;
  }

  async updateProfile(
    userId: string,
    data: UpdateProfileBody,
  ): Promise<UserProfile> {
    const [updated] = await db
      .update(users)
      .set({ ...data, updatedAt: new Date() })
      .where(eq(users.id, userId))
      .returning();

    if (!updated) {
      throw new NotFoundError("User");
    }

    const profile: UserProfile = {
      id: updated.id,
      stellarAddress: updated.stellarAddress,
      displayName: updated.displayName,
      avatarUrl: updated.avatarUrl,
      background: updated.background,
      learningGoal: updated.learningGoal,
      pace: updated.pace ?? "medium",
      language: updated.language ?? "en",
      credits: updated.credits,
      createdAt: updated.createdAt,
    };

    await cacheDel(cacheKey("user", "profile", userId));

    return profile;
  }

  async getProgress(userId: string): Promise<UserProgress> {
    const namespace = "user";
    const cacheKeyString = cacheKey(namespace, "progress", userId);

    const cachedProgress = await cacheGet<UserProgress>(
      namespace,
      cacheKeyString,
    );
    if (cachedProgress) return cachedProgress;

    const user = await db.query.users.findFirst({
      where: eq(users.id, userId),
    });

    if (!user) {
      throw new NotFoundError("User");
    }

    const [
      [enrolledResult],
      [completedResult],
      [quizScoreResult],
      [credResult],
      [rewardsResult],
    ] = await Promise.all([
      db.select({ value: count() }).from(enrollments).where(eq(enrollments.userId, userId)),
      db.select({ value: count() }).from(enrollments).where(sql`${enrollments.userId} = ${userId} AND ${enrollments.completedAt} IS NOT NULL`),
      db.select({ total: sql<number>`COALESCE(SUM(${quizSubmissions.score}), 0)` }).from(quizSubmissions).where(eq(quizSubmissions.userId, userId)),
      db.select({ value: count() }).from(credentials).where(eq(credentials.userId, userId)),
      db.select({ value: count() }).from(quizSubmissions).where(sql`${quizSubmissions.userId} = ${userId} AND ${quizSubmissions.rewardClaimed} = true`)
    ]);

    const progress: UserProgress = {
      enrolledCourses: enrolledResult.value,
      completedCourses: completedResult.value,
      totalQuizScore: Number(quizScoreResult.total),
      credentialsEarned: credResult.value,
      rewardsClaimed: rewardsResult.value,
    };

    // #149: was 10s, which is shorter than most request intervals for this
    // endpoint in practice — the cache was rarely hit, making the Redis
    // round-trip pure overhead on top of the DB query it was meant to
    // avoid. Every mutation that actually changes a user's progress
    // (enroll, credential issuance, reward claim) already explicitly calls
    // cacheDel on this same key, so a longer TTL doesn't risk serving
    // stale data after those events — it only affects the fallback expiry
    // for the rare case nothing invalidated it. Matches DEFAULT_TTL in
    // cache/index.ts.
    await cacheSet(cacheKeyString, progress, 60);

    return progress;
  }

  async getActivity(
    userId: string,
    query: ActivityQuery,
  ): Promise<UserActivityPage> {
    const namespace = "user";
    const cursor = query.cursor ?? "latest";
    const cacheKeyString = cacheKey(namespace, "activity", userId, cursor, query.limit);

    const cachedActivity = await cacheGet<UserActivityPage>(
      namespace,
      cacheKeyString,
    );
    if (cachedActivity) return cachedActivity;

    const cursorDate = query.cursor ? new Date(query.cursor) : null;
    const limit = query.limit + 1;
    const beforeCursor = (
      userIdColumn: AnyPgColumn,
      timestampColumn:
        | typeof enrollments.enrolledAt
        | typeof quizSubmissions.submittedAt
        | typeof credentials.mintedAt,
    ): SQL =>
      cursorDate
        ? and(eq(userIdColumn, userId), lt(timestampColumn, cursorDate))!
        : eq(userIdColumn, userId);

    const [enrollmentRows, submissionRows, credentialRows, rewardRows] =
      await Promise.all([
        db
          .select({
            id: enrollments.id,
            courseId: enrollments.courseId,
            courseTitle: courses.title,
            timestamp: enrollments.enrolledAt,
          })
          .from(enrollments)
          .innerJoin(courses, eq(courses.id, enrollments.courseId))
          .where(beforeCursor(enrollments.userId, enrollments.enrolledAt))
          .orderBy(desc(enrollments.enrolledAt))
          .limit(limit),
        db
          .select({
            id: quizSubmissions.id,
            quizId: quizSubmissions.quizId,
            courseId: quizzes.courseId,
            courseTitle: courses.title,
            score: quizSubmissions.score,
            timestamp: quizSubmissions.submittedAt,
          })
          .from(quizSubmissions)
          .innerJoin(quizzes, eq(quizzes.id, quizSubmissions.quizId))
          .innerJoin(courses, eq(courses.id, quizzes.courseId))
          .where(beforeCursor(quizSubmissions.userId, quizSubmissions.submittedAt))
          .orderBy(desc(quizSubmissions.submittedAt))
          .limit(limit),
        db
          .select({
            id: credentials.id,
            courseId: credentials.courseId,
            courseTitle: courses.title,
            score: credentials.score,
            mintTxHash: credentials.mintTxHash,
            timestamp: credentials.mintedAt,
          })
          .from(credentials)
          .innerJoin(courses, eq(courses.id, credentials.courseId))
          .where(beforeCursor(credentials.userId, credentials.mintedAt))
          .orderBy(desc(credentials.mintedAt))
          .limit(limit),
        db
          .select({
            id: quizSubmissions.id,
            quizId: quizSubmissions.quizId,
            courseId: quizzes.courseId,
            courseTitle: courses.title,
            rewardAmount: quizSubmissions.rewardAmount,
            txHash: quizSubmissions.txHash,
            timestamp: quizSubmissions.submittedAt,
          })
          .from(quizSubmissions)
          .innerJoin(quizzes, eq(quizzes.id, quizSubmissions.quizId))
          .innerJoin(courses, eq(courses.id, quizzes.courseId))
          .where(
            cursorDate
              ? and(
                  eq(quizSubmissions.userId, userId),
                  eq(quizSubmissions.rewardClaimed, true),
                  lt(quizSubmissions.submittedAt, cursorDate),
                )
              : and(
                  eq(quizSubmissions.userId, userId),
                  eq(quizSubmissions.rewardClaimed, true),
                ),
          )
          .orderBy(desc(quizSubmissions.submittedAt))
          .limit(limit),
      ]);

    const activities: UserActivity[] = [
      ...enrollmentRows.map((row) => ({
        type: "enrollment" as const,
        title: `Enrolled in ${row.courseTitle}`,
        timestamp: row.timestamp,
        metadata: {
          enrollmentId: row.id,
          courseId: row.courseId,
        },
      })),
      ...submissionRows.map((row) => ({
        type: "quiz_submission" as const,
        title: `Submitted quiz for ${row.courseTitle}`,
        timestamp: row.timestamp,
        metadata: {
          submissionId: row.id,
          quizId: row.quizId,
          courseId: row.courseId,
          score: row.score,
        },
      })),
      ...credentialRows.map((row) => ({
        type: "credential_mint" as const,
        title: `Minted credential for ${row.courseTitle}`,
        timestamp: row.timestamp,
        metadata: {
          credentialId: row.id,
          courseId: row.courseId,
          score: row.score,
          mintTxHash: row.mintTxHash,
        },
      })),
      ...rewardRows.map((row) => ({
        type: "reward_claim" as const,
        title: `Claimed quiz reward for ${row.courseTitle}`,
        timestamp: row.timestamp,
        metadata: {
          submissionId: row.id,
          quizId: row.quizId,
          courseId: row.courseId,
          rewardAmount: row.rewardAmount,
          txHash: row.txHash,
        },
      })),
    ].sort((a, b) => b.timestamp.getTime() - a.timestamp.getTime());

    const pageItems = activities.slice(0, query.limit);
    const page: UserActivityPage = {
      activities: pageItems,
      nextCursor:
        activities.length > query.limit && pageItems.length > 0
          ? pageItems[pageItems.length - 1].timestamp.toISOString()
          : null,
    };

    await cacheSet(cacheKeyString, page, 30);

    return page;
  }

  async updateAvatar(userId: string, upload: AvatarUpload): Promise<UserProfile> {
    const allowedMimeTypes = new Map([
      ["image/jpeg", ".jpg"],
      ["image/png", ".png"],
      ["image/webp", ".webp"],
    ]);
    const extension = allowedMimeTypes.get(upload.mimetype);

    if (!extension) {
      throw new ValidationError({
        avatar: ["Avatar must be a JPEG, PNG, or WebP image"],
      });
    }

    if (upload.size > config.AVATAR_UPLOAD_MAX_BYTES) {
      throw new ValidationError({
        avatar: [
          `Avatar must be ${config.AVATAR_UPLOAD_MAX_BYTES} bytes or smaller`,
        ],
      });
    }

    const existing = await db.query.users.findFirst({
      where: eq(users.id, userId),
    });

    if (!existing) {
      throw new NotFoundError("User");
    }

    const uploadDir = path.resolve(config.AVATAR_UPLOAD_DIR);
    await mkdir(uploadDir, { recursive: true });

    const filename = `${userId}-${crypto.randomUUID()}${extension}`;
    const filePath = path.join(uploadDir, filename);
    await writeFile(filePath, upload.buffer);

    const avatarUrlPath = `/uploads/avatars/${filename}`;
    const avatarUrl = config.PUBLIC_BASE_URL
      ? new URL(avatarUrlPath, config.PUBLIC_BASE_URL).toString()
      : avatarUrlPath;

    const [updated] = await db
      .update(users)
      .set({ avatarUrl, updatedAt: new Date() })
      .where(eq(users.id, userId))
      .returning();

    if (!updated) {
      throw new NotFoundError("User");
    }

    await this.deleteLocalAvatar(existing.avatarUrl);
    await cacheDel(cacheKey("user", "profile", userId));

    return {
      id: updated.id,
      stellarAddress: updated.stellarAddress,
      displayName: updated.displayName,
      avatarUrl: updated.avatarUrl,
      background: updated.background,
      learningGoal: updated.learningGoal,
      pace: updated.pace ?? "medium",
      language: updated.language ?? "en",
      credits: updated.credits,
      createdAt: updated.createdAt,
    };
  }

  /**
   * Soft-deletes the authenticated user's account (#290). Sets deletedAt
   * (which authGuard checks so a JWT issued before deletion stops working
   * on the very next authenticated request — no blocklist entry needed)
   * and clears the free-text profile fields the user directly controls.
   *
   * Deliberately does NOT touch enrollments or credentials — those are
   * preserved for on-chain record consistency, per the issue's explicit
   * requirement, so a deleted account's learning history and minted
   * credentials remain intact and queryable.
   *
   * updatedAt is not set manually here — the update_users_updated_at
   * trigger (migration 0009) maintains it on every UPDATE regardless of
   * which columns changed.
   */
  async deleteAccount(userId: string): Promise<void> {
    const [deleted] = await db
      .update(users)
      .set({
        deletedAt: new Date(),
        displayName: null,
        background: null,
        learningGoal: null,
      })
      .where(eq(users.id, userId))
      .returning();

    if (!deleted) {
      throw new NotFoundError("User");
    }

    const invalidations = await Promise.allSettled([
      cacheDel(cacheKey("user", "profile", userId)),
      cacheDel(cacheKey("user", "progress", userId)),
      cacheDel(cacheKey("user", "enrollments", userId)),
      cacheInvalidatePattern(cacheKeyPattern("user", "activity", userId)),
    ]);
    const failed = invalidations.filter((r) => r.status === "rejected");
    if (failed.length > 0) {
      logger.warn(
        { userId, failedCount: failed.length },
        "Post-account-deletion cache invalidation had failures — affected views may serve stale data until their TTL expires",
      );
    }

    await auditLog("user.account_deleted", { userId });
    logger.info({ userId }, "Account deleted");
  }

  private async deleteLocalAvatar(avatarUrl: string | null): Promise<void> {
    if (!avatarUrl) return;

    let pathname = avatarUrl;
    try {
      pathname = new URL(avatarUrl).pathname;
    } catch {
      // Relative local URL.
    }

    if (!pathname.startsWith("/uploads/avatars/")) return;

    const filename = path.basename(pathname);
    await rm(path.join(path.resolve(config.AVATAR_UPLOAD_DIR), filename), {
      force: true,
    });
  }
}

export const userService = new UserService();
