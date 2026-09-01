import { eq, and, count, desc, inArray, ilike, or, isNull, sql } from "drizzle-orm";
import crypto from "node:crypto";
import { db } from "../../config/database.js";
import {
  courses,
  enrollments,
  quizzes,
  quizSubmissions,
  users,
  courseReports,
  notifications,
  type CourseModuleDefinition,
} from "../../database/schema.js";
import { config } from "../../config/index.js";
import { NotFoundError, ConflictError, ForbiddenError } from "../../utils/errors.js";
import { withLock } from "../../utils/lock.js";
import { logger } from "../../utils/logger.js";
import { getOnChainContentHash } from "../../stellar/progress-tracker.js";
import { auditLog } from "../../audit/index.js";
import { dispatchWebhook } from "../../services/webhook-dispatcher.js";
import { waitlistService } from "./waitlist.service.js";
import {
  cacheGet,
  cacheSet,
  cacheDel,
  cacheInvalidatePattern,
  cacheKey,
  cacheKeyPattern,
} from "../../cache/index.js";
import type {
  ListCoursesQuery,
  CourseSummary,
  CourseDetail,
  CourseStats,
  AdminCourse,
  CreateCourseBody,
  CourseModule,
  CourseModuleMetadata,
  UpdateCourseBody,
  CourseModuleWithProgress,
  CourseLeaderboardEntry,
  CreateModuleBody,
  UpdateModuleBody,
  ListReviewsQuery,
  CreateReviewBody,
  CourseReview,
  CourseReviewsResult,
  ListEnrolledUsersQuery,
  EnrolledUsersResult,
  ReportCourseBody,
  CourseReportResult,
} from "./course.types.js";

const POPULAR_COURSES_TTL_SECONDS = 300;
const LEADERBOARD_TTL_SECONDS = 300;
const LEADERBOARD_SIZE = 20;

export class CourseService {
  async getStats(): Promise<CourseStats> {
    const namespace = "courses";
    const cacheKeyString = cacheKey(namespace, "stats");

    const cachedStats = await cacheGet<CourseStats>(namespace, cacheKeyString);
    if (cachedStats) return cachedStats;

    const [[totalResult], enrollmentRows] = await Promise.all([
      db
        .select({ value: count() })
        .from(courses)
        .where(eq(courses.isActive, true)),
      db
        .select({
          difficulty: courses.difficulty,
          value: sql<number>`COUNT(${enrollments.id})`,
        })
        .from(courses)
        .leftJoin(enrollments, eq(enrollments.courseId, courses.id))
        .where(eq(courses.isActive, true))
        .groupBy(courses.difficulty),
    ]);

    const totalCourses = totalResult?.value ?? 0;
    const enrollmentsByDifficulty: CourseStats["enrollmentsByDifficulty"] = {
      beginner: 0,
      intermediate: 0,
      advanced: 0,
    };

    let totalEnrollments = 0;
    for (const row of enrollmentRows) {
      if (
        row.difficulty === "beginner" ||
        row.difficulty === "intermediate" ||
        row.difficulty === "advanced"
      ) {
        const value = Number(row.value);
        enrollmentsByDifficulty[row.difficulty] = value;
        totalEnrollments += value;
      }
    }

    const stats: CourseStats = {
      totalCourses,
      enrollmentsByDifficulty,
      averageEnrollmentsPerCourse:
        totalCourses === 0 ? 0 : Number((totalEnrollments / totalCourses).toFixed(2)),
    };

    await cacheSet(cacheKeyString, stats, 300);

    return stats;
  }

  /**
   * The full set of course IDs a user is enrolled in, cached briefly
   * (issue #151 — listCourses/getCourseDetail previously re-queried the
   * enrollments table on every authenticated request regardless of whether
   * the course list/detail cache itself was a hit). A user's enrollment set
   * is small and changes rarely, so caching the whole set per user is
   * cheaper than a per-course cache and trivially invalidated by `enroll()`.
   */
  private async getEnrolledCourseIds(userId: string): Promise<Set<string>> {
    const namespace = "user";
    const cacheKeyString = cacheKey(namespace, "enrollments", userId);

    const cached = await cacheGet<string[]>(namespace, cacheKeyString);
    if (cached) return new Set(cached);

    const rows = await db
      .select({ courseId: enrollments.courseId })
      .from(enrollments)
      .where(eq(enrollments.userId, userId));

    const courseIds = rows.map((r) => r.courseId);
    await cacheSet(cacheKeyString, courseIds, 30);

    return new Set(courseIds);
  }

  async listCourses(
    userId: string | null,
    query: ListCoursesQuery,
  ): Promise<{ courses: CourseSummary[]; total: number }> {
    const namespace = "courses";
    const search = query.search?.trim() || undefined;
    const cacheKeyString = cacheKey(
      namespace,
      "list",
      query.difficulty ?? "all",
      search ? encodeURIComponent(search.toLowerCase()) : "all",
      query.page,
      query.limit,
    );

    let cachedData = await cacheGet<{
      courses: Omit<CourseSummary, "isEnrolled">[];
      total: number;
    }>(namespace, cacheKeyString);

    if (!cachedData) {
      const conditions = [eq(courses.isActive, true)];
      if (query.difficulty) {
        conditions.push(eq(courses.difficulty, query.difficulty));
      }
      if (search) {
        conditions.push(
          or(
            ilike(courses.title, `%${search}%`),
            ilike(courses.description, `%${search}%`),
          )!,
        );
      }

      const where = and(...conditions);
      const offset = (query.page - 1) * query.limit;

      const [totalResult] = await db
        .select({ value: count() })
        .from(courses)
        .where(where);

      const rows = await db
        .select()
        .from(courses)
        .where(where)
        .orderBy(desc(courses.createdAt))
        .limit(query.limit)
        .offset(offset);

      // Fetch enrollment counts
      const courseIds = rows.map((r) => r.id);
      const enrollmentCounts = new Map<string, number>();

      if (courseIds.length > 0) {
        const counts = await db
          .select({
            courseId: enrollments.courseId,
            value: count(),
          })
          .from(enrollments)
          .where(inArray(enrollments.courseId, courseIds))
          .groupBy(enrollments.courseId);

        for (const c of counts) {
          enrollmentCounts.set(c.courseId, c.value);
        }
      }

      const mappedCourses = rows.map((row) => ({
        id: row.id,
        title: row.title,
        description: row.description,
        difficulty: row.difficulty,
        isActive: row.isActive,
        enrolledCount: enrollmentCounts.get(row.id) ?? 0,
      }));

      cachedData = { courses: mappedCourses, total: totalResult.value };

      await cacheSet(cacheKeyString, cachedData, 30);
    }

    const finalCourses: CourseSummary[] = cachedData.courses.map((course) => ({
      ...course,
      isEnrolled: false,
    }));

    if (userId && finalCourses.length > 0) {
      const userEnrollments = await this.getEnrolledCourseIds(userId);
      for (const course of finalCourses) {
        course.isEnrolled = userEnrollments.has(course.id);
      }
    }

    return { courses: finalCourses, total: cachedData.total };
  }

  async getCourseDetail(
    courseId: string,
    userId: string | null,
  ): Promise<CourseDetail> {
    const namespace = "courses";
    const cacheKeyString = cacheKey(namespace, "detail", courseId);

    let cachedDetail = await cacheGet<Omit<CourseDetail, "isEnrolled">>(
      namespace,
      cacheKeyString,
    );

    if (!cachedDetail) {
      const course = await db.query.courses.findFirst({
        where: eq(courses.id, courseId),
      });

      if (!course || !course.isActive) {
        throw new NotFoundError("Course");
      }

      const [countResult] = await db
        .select({ value: count() })
        .from(enrollments)
        .where(eq(enrollments.courseId, courseId));

      const moduleMetadata = this.normalizeCourseModules(course.courseModules);
      let modules: CourseModule[];

      if (moduleMetadata.length > 0) {
        modules = moduleMetadata.map((module, i) => ({
          id: module.id,
          title: module.title,
          description: module.description ?? null,
          estimatedDurationMinutes: module.estimatedDurationMinutes ?? null,
          order: i + 1,
        }));
      } else {
        const moduleRows = await db
          .select({ moduleId: quizzes.moduleId })
          .from(quizzes)
          .where(eq(quizzes.courseId, courseId))
          .groupBy(quizzes.moduleId)
          .orderBy(quizzes.moduleId);

        modules = moduleRows.map((row, i) => ({
          id: row.moduleId,
          title: row.moduleId,
          description: null,
          estimatedDurationMinutes: null,
          order: i + 1,
        }));
      }

      cachedDetail = {
        id: course.id,
        title: course.title,
        description: course.description,
        difficulty: course.difficulty,
        isActive: course.isActive,
        enrolledCount: countResult?.value ?? 0,
        contentHash: course.contentHash ?? null,
        modules,
        createdAt: course.createdAt,
        averageRating: null,
        reviewCount: 0,
      };

      await cacheSet(cacheKeyString, cachedDetail, 120);
    }

    // Check enrollment (cached — see getEnrolledCourseIds, issue #151)
    let isEnrolled = false;
    if (userId) {
      const userEnrollments = await this.getEnrolledCourseIds(userId);
      isEnrolled = userEnrollments.has(courseId);
    }

    return {
      ...cachedDetail,
      isEnrolled,
    };
  }

  /**
   * List a course's modules in their original order, annotated with
   * whether the requesting user has completed each one (#286). Restricted
   * to users enrolled in the course. "Completed" means the user has a
   * non-superseded quiz submission for that module — a retry (#295)
   * supersedes the old submission and un-completes the module until the
   * new quiz is submitted.
   *
   * Cached per user+course (60s, matching getProgress's TTL) and
   * invalidated whenever a submission is recorded for this course
   * (quiz.service.ts submitQuiz/retryQuiz).
   */
  async getCourseModules(
    userId: string,
    courseId: string,
  ): Promise<CourseModuleWithProgress[]> {
    // Course existence is checked before enrollment — same order as
    // enroll() and getCourseDetail() — so a bad/non-existent course ID
    // reliably 404s rather than 403ing (which would otherwise happen for
    // a non-enrolled caller regardless of whether the course exists).
    const course = await db.query.courses.findFirst({
      where: eq(courses.id, courseId),
    });

    if (!course || !course.isActive) {
      throw new NotFoundError("Course");
    }

    const enrollment = await db.query.enrollments.findFirst({
      where: and(
        eq(enrollments.userId, userId),
        eq(enrollments.courseId, courseId),
      ),
    });

    if (!enrollment) {
      throw new ForbiddenError("Must be enrolled in the course to view its modules");
    }

    const namespace = "user";
    const cacheKeyString = cacheKey(namespace, "modules", userId, courseId);

    const cached = await cacheGet<CourseModuleWithProgress[]>(
      namespace,
      cacheKeyString,
    );
    if (cached) return cached;

    const moduleRows = await db
      .select({ moduleId: quizzes.moduleId })
      .from(quizzes)
      .where(eq(quizzes.courseId, courseId))
      .groupBy(quizzes.moduleId)
      .orderBy(quizzes.moduleId);

    const completedModuleIds = new Set(
      (
        await db
          .select({ moduleId: quizzes.moduleId })
          .from(quizSubmissions)
          .innerJoin(quizzes, eq(quizSubmissions.quizId, quizzes.id))
          .where(
            and(
              eq(quizzes.courseId, courseId),
              eq(quizSubmissions.userId, userId),
              eq(quizSubmissions.superseded, false),
            ),
          )
          .groupBy(quizzes.moduleId)
      ).map((r) => r.moduleId),
    );

    const result: CourseModuleWithProgress[] = moduleRows.map((row, i) => ({
      id: row.moduleId,
      title: row.moduleId,
      description: null,
      estimatedDurationMinutes: null,
      order: i + 1,
      completed: completedModuleIds.has(row.moduleId),
    }));

    await cacheSet(cacheKeyString, result, 60);

    return result;
  }

  /**
   * Compares the course's stored contentHash against the progress-tracker
   * contract's on-chain value (#294). Deliberately non-blocking: any
   * mismatch, or failure to read the on-chain hash at all, is logged for
   * audit but never prevents enrollment — the caller decides whether to
   * surface a warning to the client.
   */
  private async checkContentHash(
    courseId: string,
    storedContentHash: string | null,
  ): Promise<boolean> {
    if (!storedContentHash) return false;

    const onChainContentHash = await getOnChainContentHash(courseId);
    if (!onChainContentHash) return false;

    const mismatch = onChainContentHash !== storedContentHash;
    logger.info(
      { courseId, storedContentHash, onChainContentHash, mismatch },
      "Enrollment contentHash comparison",
    );
    await auditLog("course.enrolled", {
      courseId,
      contentHashMatch: !mismatch,
      onChainContentHash,
      storedContentHash,
    });

    return mismatch;
  }

  async enroll(
    userId: string,
    courseId: string,
  ): Promise<{ contentHashMismatch: boolean }> {
    let storedContentHash: string | null = null;

    await withLock(`enroll:${userId}:${courseId}`, async () => {
      await db.transaction(async (tx) => {
        const [course] = await tx
          .select()
          .from(courses)
          .where(eq(courses.id, courseId));

        if (!course || !course.isActive) {
          throw new NotFoundError("Course");
        }
        storedContentHash = course.contentHash;

        const [existing] = await tx
          .select()
          .from(enrollments)
          .where(
            and(
              eq(enrollments.userId, userId),
              eq(enrollments.courseId, courseId),
            ),
          )
          .for("update");

        if (existing) {
          throw new ConflictError("Already enrolled in this course");
        }

        // Enrollment cap (#306) — only active (not yet completed)
        // enrollments count toward the limit, so finishing a course frees
        // up a slot for a new one.
        const [activeCountResult] = await tx
          .select({ value: count() })
          .from(enrollments)
          .where(
            and(eq(enrollments.userId, userId), isNull(enrollments.completedAt)),
          );
        const activeCount = activeCountResult?.value ?? 0;

        if (activeCount >= config.MAX_ENROLLMENTS) {
          throw new ForbiddenError(
            `Enrollment limit reached: ${activeCount}/${config.MAX_ENROLLMENTS} active enrollments. Complete or drop a course before enrolling in a new one.`,
          );
        }

        await tx.insert(enrollments).values({ userId, courseId });
      });

      // Remove from waitlist if enrolled successfully
      await waitlistService.removeFromWaitlist(userId, courseId);

      // Dispatch webhook event for enrollment
      try {
        await dispatchWebhook({
          id: crypto.randomUUID(),
          event: "enrollment.created",
          timestamp: new Date(),
          data: {
            userId,
            courseId,
          },
        });
      } catch (err) {
        logger.error({ err, userId, courseId }, "Failed to dispatch enrollment webhook");
        // Don't fail the enrollment if webhook dispatch fails
      }

      // Cache invalidation necessarily happens outside the DB transaction —
      // Redis isn't part of the Postgres transaction, so there's no way to
      // make this atomic with the commit above (issue #152). cacheDel/
      // cacheInvalidatePattern already fail soft (log a warning, never
      // throw), and every cache touched here has a bounded TTL (<=5min —
      // courses:popular is the longest at 300s, everything else is <=120s),
      // so a transient invalidation failure produces bounded staleness
      // rather than a permanently stale cache. Run them concurrently —
      // reduces the real-world window between commit and invalidation
      // rather than running four sequential round-trips one after another —
      // and log once at this call site (distinct from cacheDel's generic
      // per-key warning) so a failure here is attributable specifically to
      // an enrollment, not just "some cache key somewhere".
      const invalidations = await Promise.allSettled([
        cacheInvalidatePattern("chainlearn:courses:list:*"),
        cacheDel(cacheKey("courses", "detail", courseId)),
        cacheDel(cacheKey("courses", "stats")),
        // #285: getPopularCourses() also caches enrolledCount per course
        // (up to POPULAR_COURSES_TTL_SECONDS = 5min), but was never
        // invalidated here — an enrollment could leave /courses/popular
        // showing a stale count for up to 5 minutes even though the list/
        // detail/stats views above already correct immediately.
        cacheInvalidatePattern(cacheKeyPattern("courses", "popular")),
        cacheDel(cacheKey("user", "progress", userId)),
        cacheDel(cacheKey("user", "enrollments", userId)),
        cacheInvalidatePattern(cacheKeyPattern("user", "activity", userId)),
      ]);
      const failed = invalidations.filter((r) => r.status === "rejected");
      if (failed.length > 0) {
        logger.warn(
          { userId, courseId, failedCount: failed.length },
          "Post-enroll cache invalidation had failures — affected views may serve stale data until their TTL expires",
        );
      }
    });

    // Run after the lock releases — a slow/unreachable contract read must
    // never extend how long the enrollment lock is held.
    const contentHashMismatch = await this.checkContentHash(
      courseId,
      storedContentHash,
    );

    return { contentHashMismatch };
  }

  /**
   * Drop the caller's enrollment in a course (#310) — the companion action
   * to enroll() that this codebase didn't previously have, needed to give
   * "a spot opens up" any concrete meaning. The row is hard-deleted
   * (matching the "drop a course" language already used in enroll()'s cap
   * error) rather than soft-cancelled, since nothing in this codebase reads
   * a cancelled-but-not-deleted enrollment.
   */
  async dropEnrollment(userId: string, courseId: string): Promise<void> {
    await withLock(`enroll:${userId}:${courseId}`, async () => {
      const [deleted] = await db
        .delete(enrollments)
        .where(
          and(eq(enrollments.userId, userId), eq(enrollments.courseId, courseId)),
        )
        .returning();

      if (!deleted) {
        throw new NotFoundError("Enrollment");
      }

      const invalidations = await Promise.allSettled([
        cacheDel(cacheKey("courses", "detail", courseId)),
        cacheDel(cacheKey("courses", "stats")),
        cacheDel(cacheKey("user", "progress", userId)),
        cacheDel(cacheKey("user", "enrollments", userId)),
        cacheInvalidatePattern(cacheKeyPattern("user", "activity", userId)),
      ]);
      const failed = invalidations.filter((r) => r.status === "rejected");
      if (failed.length > 0) {
        logger.warn(
          { userId, courseId, failedCount: failed.length },
          "Post-drop cache invalidation had failures — affected views may serve stale data until their TTL expires",
        );
      }
    });

    await auditLog("course.enrollment_dropped", { userId, courseId });
    logger.info({ userId, courseId }, "Enrollment dropped");

    // Runs after the enroll lock releases — notifying a waitlisted user
    // should never extend how long the enrollment lock for this drop is
    // held.
    await this.notifyNextWaitlisted(courseId);
  }

  /**
   * Identify the user at the head of a course's waitlist so they can be
   * told a spot opened up (#310) — called after dropEnrollment(). Uses the
   * existing waitlistService (added for #320/#323) rather than reading the
   * table directly; that service already owns join/leave/position
   * bookkeeping. The identified user stays on the waitlist (not removed)
   * until they actually enroll, at which point enroll()'s existing call to
   * waitlistService.removeFromWaitlist takes them off.
   *
   * There's currently no user-facing notifications table to write to (it
   * was dropped from schema.ts by an unrelated upstream change) — this
   * records the event via the audit log instead, so the signal isn't lost
   * and can be wired into a real notification channel once one exists
   * again. Best-effort: a failure here never fails the caller's drop.
   */
  private async notifyNextWaitlisted(courseId: string): Promise<void> {
    try {
      const next = await waitlistService.getNextOnWaitlist(courseId);
      if (!next) return;

      await auditLog("course.waitlist.notified", {
        userId: next.userId,
        courseId,
      });
      logger.info(
        { userId: next.userId, courseId },
        "Identified next waitlisted user for an open spot",
      );
    } catch (err) {
      logger.warn(
        { err, courseId },
        "Failed to identify next waitlisted user — the enrollment drop itself still succeeded",
      );
    }
  }

  /**
   * Active courses ordered by enrollment count descending, for discovery
   * (#293). Cached separately from listCourses() since the sort/shape
   * differs and a 5 min TTL is appropriate here (trending courses don't
   * need to be as fresh as a course-detail page).
   */
  async getPopularCourses(limit: number): Promise<CourseSummary[]> {
    const namespace = "courses";
    const cacheKeyString = cacheKey(namespace, "popular", limit);

    const cached = await cacheGet<Omit<CourseSummary, "isEnrolled">[]>(
      namespace,
      cacheKeyString,
    );
    if (cached) {
      return cached.map((course) => ({ ...course, isEnrolled: false }));
    }

    const rows = await db
      .select({
        id: courses.id,
        title: courses.title,
        description: courses.description,
        difficulty: courses.difficulty,
        isActive: courses.isActive,
        enrolledCount: count(enrollments.courseId),
      })
      .from(courses)
      .leftJoin(enrollments, eq(enrollments.courseId, courses.id))
      .where(eq(courses.isActive, true))
      .groupBy(courses.id)
      .orderBy(desc(count(enrollments.courseId)))
      .limit(limit);

    await cacheSet(cacheKeyString, rows, POPULAR_COURSES_TTL_SECONDS);

    return rows.map((course) => ({ ...course, isEnrolled: false }));
  }

  /**
   * Per-course leaderboard (#324): the top {@link LEADERBOARD_SIZE} learners
   * for a course ranked by their average quiz score. Each submission's raw
   * correct-answer count is normalized against its own quiz's question count
   * before averaging (quizzes vary from 1–20 questions), matching
   * getQuizStats. Superseded submissions (#295) and ungraded ones don't
   * count. Cached for 5 minutes — course-level competition doesn't need to
   * be real-time, and this aggregates every submission for the course.
   */
  async getLeaderboard(courseId: string): Promise<CourseLeaderboardEntry[]> {
    const namespace = "courses";
    const cacheKeyString = cacheKey(namespace, "leaderboard", courseId);

    const cached = await cacheGet<CourseLeaderboardEntry[]>(
      namespace,
      cacheKeyString,
    );
    if (cached) return cached;

    const course = await db.query.courses.findFirst({
      where: eq(courses.id, courseId),
    });
    if (!course || !course.isActive) {
      throw new NotFoundError("Course");
    }

    const rows = await db
      .select({
        userId: quizSubmissions.userId,
        displayName: users.displayName,
        score: quizSubmissions.score,
        questions: quizzes.questions,
      })
      .from(quizSubmissions)
      .innerJoin(quizzes, eq(quizSubmissions.quizId, quizzes.id))
      .innerJoin(users, eq(quizSubmissions.userId, users.id))
      .where(
        and(
          eq(quizzes.courseId, courseId),
          eq(quizSubmissions.superseded, false),
          isNull(users.deletedAt),
        ),
      );

    const perUser = new Map<
      string,
      { displayName: string | null; percentageSum: number; quizzesTaken: number }
    >();

    for (const row of rows) {
      const totalQuestions = Array.isArray(row.questions)
        ? row.questions.length
        : 0;
      if (totalQuestions === 0 || row.score == null) continue;

      const percentage = Math.round((row.score / totalQuestions) * 100);
      const entry = perUser.get(row.userId) ?? {
        displayName: row.displayName,
        percentageSum: 0,
        quizzesTaken: 0,
      };
      entry.percentageSum += percentage;
      entry.quizzesTaken += 1;
      perUser.set(row.userId, entry);
    }

    const leaderboard: CourseLeaderboardEntry[] = [...perUser.entries()]
      .map(([userId, e]) => ({
        userId,
        displayName: e.displayName,
        averageScore: Math.round(e.percentageSum / e.quizzesTaken),
        quizzesTaken: e.quizzesTaken,
      }))
      .sort(
        (a, b) =>
          b.averageScore - a.averageScore ||
          b.quizzesTaken - a.quizzesTaken,
      )
      .slice(0, LEADERBOARD_SIZE)
      .map((e, i) => ({ rank: i + 1, ...e }));

    await cacheSet(cacheKeyString, leaderboard, LEADERBOARD_TTL_SECONDS);

    return leaderboard;
  }

  // ─── Course Sharing / Referrals (#325) ─────────────────────────────────

  /** 10-char base62 referral token from 8 random bytes. */
  private generateReferralCode(): string {
    const alphabet =
      "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz";
    const bytes = crypto.randomBytes(10);
    let code = "";
    for (const b of bytes) code += alphabet[b % alphabet.length];
    return code;
  }

  private buildShareUrl(courseId: string, referralCode: string): string {
    const base = config.PUBLIC_BASE_URL?.replace(/\/$/, "") ?? "";
    return `${base}/api/v1/courses/${courseId}?ref=${referralCode}`;
  }

  private async toShareLink(
    row: typeof courseShares.$inferSelect,
  ): Promise<CourseShareLink> {
    const url = this.buildShareUrl(row.courseId, row.referralCode);
    return {
      courseId: row.courseId,
      referralCode: row.referralCode,
      url,
      qrCode: await QRCode.toDataURL(url, { margin: 1, width: 240 }),
      clickCount: row.clickCount,
      enrollmentCount: row.enrollmentCount,
    };
  }

  /**
   * Get (or lazily create) the caller's referral link for a course (#325).
   * The link is stable — calling this repeatedly returns the same code and
   * its accumulated click / enrollment counts. Scoped by a per-user,
   * per-course lock so two concurrent first-time calls can't both insert.
   */
  async createShareLink(
    userId: string,
    courseId: string,
  ): Promise<CourseShareLink> {
    const course = await db.query.courses.findFirst({
      where: eq(courses.id, courseId),
    });
    if (!course || !course.isActive) {
      throw new NotFoundError("Course");
    }

    return withLock(`course-share:${userId}:${courseId}`, async () => {
      const existing = await db.query.courseShares.findFirst({
        where: and(
          eq(courseShares.userId, userId),
          eq(courseShares.courseId, courseId),
        ),
      });
      if (existing) return this.toShareLink(existing);

      // Retry on the (astronomically unlikely) referral_code collision.
      for (let attempt = 0; attempt < 5; attempt++) {
        try {
          const [row] = await db
            .insert(courseShares)
            .values({
              userId,
              courseId,
              referralCode: this.generateReferralCode(),
            })
            .returning();
          await auditLog("course.shared", { userId, courseId });
          return this.toShareLink(row);
        } catch (err) {
          const code = (err as { code?: string }).code;
          // 23505 = unique_violation. A concurrent insert of the same
          // (user, course) pair means we should return their row.
          if (code === "23505") {
            const row = await db.query.courseShares.findFirst({
              where: and(
                eq(courseShares.userId, userId),
                eq(courseShares.courseId, courseId),
              ),
            });
            if (row) return this.toShareLink(row);
            continue; // else it was a code collision — regenerate
          }
          throw err;
        }
      }
      throw new Error("Could not allocate a unique referral code");
    });
  }

  /**
   * Resolve a referral code to its course, counting the click (#325). Used
   * by the public share link so opening it is tracked. A missing/stale code
   * 404s rather than silently redirecting.
   */
  async resolveShareLink(
    referralCode: string,
    viewerId: string | null,
  ): Promise<ResolvedShareLink> {
    const share = await db.query.courseShares.findFirst({
      where: eq(courseShares.referralCode, referralCode),
    });
    if (!share) {
      throw new NotFoundError("Share link");
    }

    // Don't inflate the metric when the sharer opens their own link.
    if (viewerId !== share.userId) {
      await db
        .update(courseShares)
        .set({ clickCount: sql`${courseShares.clickCount} + 1` })
        .where(eq(courseShares.id, share.id));
    }

    return {
      referralCode: share.referralCode,
      sharedByUserId: share.userId,
      course: await this.getCourseDetail(share.courseId, viewerId),
    };
  }

  /**
   * Credit a referral with an enrollment (#325). Best-effort — called after
   * a successful enroll(); a bad or self-referral code is ignored rather
   * than failing the enrollment.
   */
  private async trackReferralEnrollment(
    referralCode: string,
    courseId: string,
    enrolleeId: string,
  ): Promise<void> {
    try {
      const result = await db
        .update(courseShares)
        .set({ enrollmentCount: sql`${courseShares.enrollmentCount} + 1` })
        .where(
          and(
            eq(courseShares.referralCode, referralCode),
            eq(courseShares.courseId, courseId),
            ne(courseShares.userId, enrolleeId),
          ),
        )
        .returning({ userId: courseShares.userId });

      if (result.length > 0) {
        await auditLog("course.referral_enrolled", {
          userId: enrolleeId,
          courseId,
        });
      }
    } catch (err) {
      logger.warn(
        { err, courseId, referralCode },
        "Failed to record referral enrollment — enrollment itself succeeded",
      );
    }
  }

  /**
   * Generate personalized course recommendations for a user (#328).
   * Heuristic: recommend courses one difficulty level above completed courses,
   * filtered by similar tags. Falls back to popular courses for new users.
   * Cached per user for 1 hour — recommendation quality doesn't need to be
   * real-time, and the query aggregates enrollment/completion data.
   */
  async getRecommendedCourses(
    userId: string,
    limit: number = 10,
  ): Promise<CourseSummary[]> {
    const namespace = "courses";
    const cacheKeyString = cacheKey(namespace, "recommended", userId, limit);

    const cached = await cacheGet<Omit<CourseSummary, "isEnrolled">[]>(
      namespace,
      cacheKeyString,
    );
    if (cached) {
      return cached.map((course) => ({ ...course, isEnrolled: false }));
    }

    // Get user's enrolled courses with their completions
    const enrolledRows = await db
      .select({
        courseId: enrollments.courseId,
        difficulty: courses.difficulty,
        tags: courses.tags,
        completed: enrollments.completedAt,
      })
      .from(enrollments)
      .innerJoin(courses, eq(enrollments.courseId, courses.id))
      .where(eq(enrollments.userId, userId));

    // If user is new (no enrollments), return popular courses
    if (enrolledRows.length === 0) {
      const popular = await this.getPopularCourses(limit);
      await cacheSet(cacheKeyString, popular, 3600);
      return popular;
    }

    // Analyze completed courses to determine recommendation criteria
    const completedCourses = enrolledRows.filter((r) => r.completed !== null);
    const enrolledCourseIds = new Set(enrolledRows.map((r) => r.courseId));

    // Collect tags from enrolled courses
    const userTags = new Set<string>();
    for (const row of enrolledRows) {
      const tags = row.tags as string[] | null;
      if (tags) {
        for (const tag of tags) userTags.add(tag);
      }
    }

    // Determine target difficulty: one level above highest completed
    let targetDifficulty: string | null = null;
    if (completedCourses.length > 0) {
      const difficulties = completedCourses.map((c) => c.difficulty);
      if (difficulties.includes("beginner")) {
        targetDifficulty = "intermediate";
      } else if (difficulties.includes("intermediate")) {
        targetDifficulty = "advanced";
      }
      // If all completed are advanced, keep targetDifficulty null (will show all difficulties)
    }

    // Build recommendation query
    const conditions = [
      eq(courses.isActive, true),
      sql`${courses.id} NOT IN ${enrolledCourseIds.size > 0 ? sql`(${sql.join(Array.from(enrolledCourseIds).map((id) => sql`${id}`), sql`, `)})` : sql`('')`}`,
    ];

    if (targetDifficulty) {
      conditions.push(eq(courses.difficulty, targetDifficulty));
    }

    const candidateRows = await db
      .select({
        id: courses.id,
        title: courses.title,
        description: courses.description,
        difficulty: courses.difficulty,
        tags: courses.tags,
        isActive: courses.isActive,
      })
      .from(courses)
      .where(and(...conditions))
      .limit(limit * 3); // Get more candidates to allow tag-based sorting

    // Score courses by tag overlap
    const scored = candidateRows.map((course) => {
      const courseTags = (course.tags as string[] | null) ?? [];
      const tagOverlap = courseTags.filter((tag) => userTags.has(tag)).length;
      return { course, tagOverlap };
    });

    // Sort by tag overlap (descending), then take the limit
    scored.sort((a, b) => b.tagOverlap - a.tagOverlap);
    const topCourses = scored.slice(0, limit).map((s) => s.course);

    // Get enrollment counts for the recommended courses
    const courseIds = topCourses.map((c) => c.id);
    const enrollmentCounts = new Map<string, number>();

    if (courseIds.length > 0) {
      const counts = await db
        .select({
          courseId: enrollments.courseId,
          value: count(),
        })
        .from(enrollments)
        .where(inArray(enrollments.courseId, courseIds))
        .groupBy(enrollments.courseId);

      for (const c of counts) {
        enrollmentCounts.set(c.courseId, c.value);
      }
    }

    const recommendations = topCourses.map((course) => ({
      id: course.id,
      title: course.title,
      description: course.description,
      difficulty: course.difficulty,
      isActive: course.isActive,
      enrolledCount: enrollmentCounts.get(course.id) ?? 0,
    }));

    // If we got fewer than requested, pad with popular courses
    if (recommendations.length < limit) {
      const popular = await this.getPopularCourses(limit - recommendations.length);
      const popularFiltered = popular.filter(
        (p) => !enrolledCourseIds.has(p.id) && !recommendations.find((r) => r.id === p.id),
      );
      recommendations.push(...popularFiltered);
    }

    await cacheSet(cacheKeyString, recommendations, 3600);

    return recommendations.map((course) => ({ ...course, isEnrolled: false }));
  }

  // ─── Course Reviews ─────────────────────────────────────────────────────

  /**
   * Average rating + review count for a course, cached separately from the
   * paginated review list itself so getCourseDetail (which only needs the
   * summary, not every review) can reuse it cheaply. Invalidated together
   * with the course detail cache whenever a review is created/updated.
   */
  private async getReviewStats(
    courseId: string,
  ): Promise<{ averageRating: number | null; reviewCount: number }> {
    const namespace = "courses";
    const cacheKeyString = cacheKey(namespace, "review-stats", courseId);

    const cached = await cacheGet<{
      averageRating: number | null;
      reviewCount: number;
    }>(namespace, cacheKeyString);
    if (cached) return cached;

    const [row] = await db
      .select({
        average: sql<string | null>`AVG(${courseReviews.rating})`,
        total: count(),
      })
      .from(courseReviews)
      .where(eq(courseReviews.courseId, courseId));

    const stats = {
      averageRating:
        row?.average != null ? Number(Number(row.average).toFixed(2)) : null,
      reviewCount: row?.total ?? 0,
    };

    await cacheSet(cacheKeyString, stats, 300);

    return stats;
  }

  private async invalidateReviewCaches(courseId: string): Promise<void> {
    const invalidations = await Promise.allSettled([
      cacheDel(cacheKey("courses", "review-stats", courseId)),
      cacheDel(cacheKey("courses", "detail", courseId)),
      cacheInvalidatePattern(cacheKeyPattern("courses", "reviews", courseId)),
    ]);
    const failed = invalidations.filter((r) => r.status === "rejected");
    if (failed.length > 0) {
      logger.warn(
        { courseId, failedCount: failed.length },
        "Post-review cache invalidation had failures — affected views may serve stale data until their TTL expires",
      );
    }
  }

  /** Paginated review list for a course, alongside its average rating. */
  async getCourseReviews(
    courseId: string,
    query: ListReviewsQuery,
  ): Promise<CourseReviewsResult> {
    const course = await db.query.courses.findFirst({
      where: eq(courses.id, courseId),
    });
    if (!course || !course.isActive) {
      throw new NotFoundError("Course");
    }

    const namespace = "courses";
    const cacheKeyString = cacheKey(
      namespace,
      "reviews",
      courseId,
      query.page,
      query.limit,
    );

    let listData = await cacheGet<{ reviews: CourseReview[]; total: number }>(
      namespace,
      cacheKeyString,
    );

    if (!listData) {
      const offset = (query.page - 1) * query.limit;

      const [[totalResult], rows] = await Promise.all([
        db
          .select({ value: count() })
          .from(courseReviews)
          .where(eq(courseReviews.courseId, courseId)),
        db
          .select({
            id: courseReviews.id,
            userId: courseReviews.userId,
            displayName: users.displayName,
            rating: courseReviews.rating,
            reviewText: courseReviews.reviewText,
            createdAt: courseReviews.createdAt,
            updatedAt: courseReviews.updatedAt,
          })
          .from(courseReviews)
          .innerJoin(users, eq(courseReviews.userId, users.id))
          .where(eq(courseReviews.courseId, courseId))
          .orderBy(desc(courseReviews.createdAt))
          .limit(query.limit)
          .offset(offset),
      ]);

      listData = { reviews: rows, total: totalResult?.value ?? 0 };
      await cacheSet(cacheKeyString, listData, 60);
    }

    const stats = await this.getReviewStats(courseId);

    return {
      reviews: listData.reviews,
      total: listData.total,
      averageRating: stats.averageRating,
      totalReviews: stats.reviewCount,
    };
  }

  /**
   * Admin: paginated list of a course's enrolled users with their
   * quiz-progress summary (#340). quizCount/averageScore are computed from
   * quiz_submissions joined to quizzes scoped to this course, excluding
   * superseded submissions (a retried quiz's earlier submission is kept
   * for history but no longer counts as "the" submission — same rule
   * reward logic elsewhere in this service follows).
   */
  async getEnrolledUsers(
    courseId: string,
    query: ListEnrolledUsersQuery,
  ): Promise<EnrolledUsersResult> {
    const course = await db.query.courses.findFirst({
      where: eq(courses.id, courseId),
    });
    if (!course) {
      throw new NotFoundError("Course");
    }

    const namespace = "courses";
    const cacheKeyString = cacheKey(
      namespace,
      "enrolled-users",
      courseId,
      query.page,
      query.limit,
    );

    const cached = await cacheGet<EnrolledUsersResult>(
      namespace,
      cacheKeyString,
    );
    if (cached) return cached;

    const offset = (query.page - 1) * query.limit;

    const [[totalResult], enrolledRows] = await Promise.all([
      db
        .select({ value: count() })
        .from(enrollments)
        .where(eq(enrollments.courseId, courseId)),
      db
        .select({
          userId: users.id,
          displayName: users.displayName,
          stellarAddress: users.stellarAddress,
          enrolledAt: enrollments.enrolledAt,
          completedAt: enrollments.completedAt,
        })
        .from(enrollments)
        .innerJoin(users, eq(enrollments.userId, users.id))
        .where(eq(enrollments.courseId, courseId))
        .orderBy(desc(enrollments.enrolledAt))
        .limit(query.limit)
        .offset(offset),
    ]);

    const userIds = enrolledRows.map((row) => row.userId);

    const progressRows = userIds.length
      ? await db
          .select({
            userId: quizSubmissions.userId,
            quizCount: count(),
            averageScore: sql<string | null>`AVG(${quizSubmissions.score})`,
          })
          .from(quizSubmissions)
          .innerJoin(quizzes, eq(quizSubmissions.quizId, quizzes.id))
          .where(
            and(
              eq(quizzes.courseId, courseId),
              eq(quizSubmissions.superseded, false),
              inArray(quizSubmissions.userId, userIds),
            ),
          )
          .groupBy(quizSubmissions.userId)
      : [];

    const progressByUser = new Map(
      progressRows.map((row) => [
        row.userId,
        {
          quizCount: row.quizCount,
          averageScore:
            row.averageScore != null
              ? Number(Number(row.averageScore).toFixed(2))
              : null,
        },
      ]),
    );

    const result: EnrolledUsersResult = {
      users: enrolledRows.map((row) => ({
        userId: row.userId,
        displayName: row.displayName,
        stellarAddress: row.stellarAddress,
        enrolledAt: row.enrolledAt,
        completedAt: row.completedAt,
        quizCount: progressByUser.get(row.userId)?.quizCount ?? 0,
        averageScore: progressByUser.get(row.userId)?.averageScore ?? null,
      })),
      total: totalResult?.value ?? 0,
    };

    await cacheSet(cacheKeyString, result, 30);

    return result;
  }

  /**
   * Create or update the caller's review for a course (one review per user
   * per course — a repeat submission overwrites the previous rating/text).
   * Restricted to users who hold a completion credential for the course,
   * since minting one already requires a passing quiz submission.
   */
  async upsertReview(
    userId: string,
    courseId: string,
    data: CreateReviewBody,
  ): Promise<CourseReview> {
    const course = await db.query.courses.findFirst({
      where: eq(courses.id, courseId),
    });
    if (!course || !course.isActive) {
      throw new NotFoundError("Course");
    }

    const credential = await db.query.credentials.findFirst({
      where: and(
        eq(credentials.userId, userId),
        eq(credentials.courseId, courseId),
      ),
    });
    if (!credential) {
      throw new ForbiddenError(
        "Must complete the course before reviewing it",
      );
    }

    const reviewText = data.reviewText ?? null;
    const [row] = await db
      .insert(courseReviews)
      .values({ userId, courseId, rating: data.rating, reviewText })
      .onConflictDoUpdate({
        target: [courseReviews.userId, courseReviews.courseId],
        set: { rating: data.rating, reviewText, updatedAt: new Date() },
      })
      .returning();

    await this.invalidateReviewCaches(courseId);
    await auditLog("course.reviewed", { userId, courseId, rating: data.rating });
    logger.info({ userId, courseId, rating: data.rating }, "Course review saved");

    const user = await db.query.users.findFirst({
      where: eq(users.id, userId),
    });

    return {
      id: row.id,
      userId: row.userId,
      displayName: user?.displayName ?? null,
      rating: row.rating,
      reviewText: row.reviewText,
      createdAt: row.createdAt,
      updatedAt: row.updatedAt,
    };
  }

  // ─── Admin ──────────────────────────────────────────────────────────────

  private async invalidateCourseCaches(courseId?: string): Promise<void> {
    const invalidations = await Promise.allSettled([
      cacheInvalidatePattern(cacheKeyPattern("courses", "list")),
      cacheInvalidatePattern(cacheKeyPattern("courses", "popular")),
      cacheDel(cacheKey("courses", "stats")),
      ...(courseId ? [cacheDel(cacheKey("courses", "detail", courseId))] : []),
    ]);
    const failed = invalidations.filter((r) => r.status === "rejected");
    if (failed.length > 0) {
      logger.warn(
        { courseId, failedCount: failed.length },
        "Post-admin-write course cache invalidation had failures — affected views may serve stale data until their TTL expires",
      );
    }
  }

  private toAdminCourse(row: typeof courses.$inferSelect): AdminCourse {
    return {
      id: row.id,
      title: row.title,
      description: row.description,
      difficulty: row.difficulty,
      tags: row.tags ?? [],
      courseModules: this.normalizeCourseModules(row.courseModules),
      contentHash: row.contentHash,
      isActive: row.isActive,
      modules: (row.modules ?? []) as CourseModuleDefinition[],
      accessibilityScore: null,
      createdAt: row.createdAt,
    };
  }

  async createCourse(data: CreateCourseBody): Promise<AdminCourse> {
    const [course] = await db
      .insert(courses)
      .values({
        title: data.title,
        description: data.description,
        difficulty: data.difficulty,
        tags: data.tags,
        courseModules: data.courseModules,
        contentHash: data.contentHash,
      })
      .returning();

    await this.invalidateCourseCaches();
    await auditLog("course.created", { courseId: course.id });
    logger.info({ courseId: course.id }, "Course created");

    return this.toAdminCourse(course);
  }

  async updateCourse(
    courseId: string,
    data: UpdateCourseBody,
  ): Promise<AdminCourse> {
    const [course] = await db
      .update(courses)
      .set(data)
      .where(eq(courses.id, courseId))
      .returning();

    if (!course) {
      throw new NotFoundError("Course");
    }

    await this.invalidateCourseCaches(courseId);
    await auditLog("course.updated", { courseId });
    logger.info({ courseId }, "Course updated");

    return this.toAdminCourse(course);
  }

  /** Soft-deletes a course by setting isActive = false (#292). */
  async deleteCourse(courseId: string): Promise<void> {
    const [course] = await db
      .update(courses)
      .set({ isActive: false })
      .where(eq(courses.id, courseId))
      .returning();

    if (!course) {
      throw new NotFoundError("Course");
    }

    await this.invalidateCourseCaches(courseId);
    await auditLog("course.deleted", { courseId });
    logger.info({ courseId }, "Course soft-deleted");
  }

  private normalizeCourseModules(
    modules: CourseModuleMetadata[] | null,
  ): CourseModuleMetadata[] {
    if (!Array.isArray(modules)) return [];

    return modules
      .filter((module) => module.id && module.title)
      .map((module) => ({
        id: module.id,
        title: module.title,
        description: module.description,
        estimatedDurationMinutes: module.estimatedDurationMinutes,
      }));
  }

  // ─── Admin: Module Management (#304) ───────────────────────────────────

  /**
   * Modules are stored as an ordered array in courses.modules (jsonb) — the
   * lock scopes read-modify-write of that array so two concurrent module
   * writes on the same course can't clobber each other.
   */
  async createModule(
    courseId: string,
    data: CreateModuleBody,
  ): Promise<CourseModuleDefinition> {
    return withLock(`course-modules:${courseId}`, async () => {
      const [course] = await db
        .select()
        .from(courses)
        .where(eq(courses.id, courseId));

      if (!course) {
        throw new NotFoundError("Course");
      }

      const existingModules = (course.modules ??
        []) as CourseModuleDefinition[];
      const newModule: CourseModuleDefinition = {
        id: crypto.randomUUID(),
        title: data.title,
        description: data.description,
        order: data.order ?? existingModules.length,
      };
      const updatedModules = [...existingModules, newModule].sort(
        (a, b) => a.order - b.order,
      );

      await db
        .update(courses)
        .set({ modules: updatedModules })
        .where(eq(courses.id, courseId));

      await this.invalidateCourseCaches(courseId);
      await auditLog("course.module.created", {
        courseId,
        moduleId: newModule.id,
      });
      logger.info({ courseId, moduleId: newModule.id }, "Course module created");

      return newModule;
    });
  }

  async updateModule(
    courseId: string,
    moduleId: string,
    data: UpdateModuleBody,
  ): Promise<CourseModuleDefinition> {
    return withLock(`course-modules:${courseId}`, async () => {
      const [course] = await db
        .select()
        .from(courses)
        .where(eq(courses.id, courseId));

      if (!course) {
        throw new NotFoundError("Course");
      }

      const existingModules = (course.modules ??
        []) as CourseModuleDefinition[];
      const index = existingModules.findIndex((m) => m.id === moduleId);
      if (index === -1) {
        throw new NotFoundError("Module");
      }

      const updated: CourseModuleDefinition = {
        ...existingModules[index],
        ...data,
      };
      const updatedModules = [...existingModules];
      updatedModules[index] = updated;
      updatedModules.sort((a, b) => a.order - b.order);

      await db
        .update(courses)
        .set({ modules: updatedModules })
        .where(eq(courses.id, courseId));

      await this.invalidateCourseCaches(courseId);
      await auditLog("course.module.updated", { courseId, moduleId });
      logger.info({ courseId, moduleId }, "Course module updated");

      return updated;
    });
  }

  /**
   * Deleting a module also removes its associated quizzes (and, via the FK
   * cascade on quiz_submissions, their submissions) — a module with no
   * content definition shouldn't leave orphaned quiz data behind.
   */
  async deleteModule(courseId: string, moduleId: string): Promise<void> {
    await withLock(`course-modules:${courseId}`, async () => {
      await db.transaction(async (tx) => {
        const [course] = await tx
          .select()
          .from(courses)
          .where(eq(courses.id, courseId));

        if (!course) {
          throw new NotFoundError("Course");
        }

        const existingModules = (course.modules ??
          []) as CourseModuleDefinition[];
        const index = existingModules.findIndex((m) => m.id === moduleId);
        if (index === -1) {
          throw new NotFoundError("Module");
        }

        const updatedModules = existingModules.filter(
          (m) => m.id !== moduleId,
        );

        await tx
          .update(courses)
          .set({ modules: updatedModules })
          .where(eq(courses.id, courseId));

        await tx
          .delete(quizzes)
          .where(
            and(eq(quizzes.courseId, courseId), eq(quizzes.moduleId, moduleId)),
          );
      });
    });

    await this.invalidateCourseCaches(courseId);
    await auditLog("course.module.deleted", { courseId, moduleId });
    logger.info({ courseId, moduleId }, "Course module deleted");
  }

  /**
   * Report a course for inappropriate content, errors, or other issues.
   * One report per user per course — a repeat report from the same user
   * for the same course is rejected rather than silently upserted, so the
   * report count admins see stays a genuine distinct-reporter count.
   */
  async reportCourse(
    userId: string,
    courseId: string,
    body: ReportCourseBody,
  ): Promise<CourseReportResult> {
    const course = await db.query.courses.findFirst({
      where: eq(courses.id, courseId),
    });
    if (!course) {
      throw new NotFoundError("Course");
    }

    const existing = await db.query.courseReports.findFirst({
      where: and(
        eq(courseReports.courseId, courseId),
        eq(courseReports.userId, userId),
      ),
    });
    if (existing) {
      throw new ConflictError("You have already reported this course");
    }

    const [report] = await db
      .insert(courseReports)
      .values({
        courseId,
        userId,
        reason: body.reason,
        description: body.description,
      })
      .returning();

    await this.notifyAdminsOfReport(course.title, courseId, report.id, body.reason);

    await auditLog("course.reported", {
      courseId,
      userId,
      reportId: report.id,
      reason: body.reason,
    });
    logger.info({ courseId, userId, reportId: report.id }, "Course reported");

    return {
      id: report.id,
      courseId: report.courseId,
      reason: report.reason,
      status: report.status,
      createdAt: report.createdAt,
    };
  }

  /**
   * Notifies every admin (in-app, via the notifications table) that a new
   * course report came in. Best-effort — a notification-insert failure
   * must not fail the report submission itself.
   */
  private async notifyAdminsOfReport(
    courseTitle: string,
    courseId: string,
    reportId: string,
    reason: string,
  ): Promise<void> {
    try {
      const admins = await db.query.users.findMany({
        where: eq(users.isAdmin, true),
      });
      if (admins.length === 0) return;

      await db.insert(notifications).values(
        admins.map((admin) => ({
          userId: admin.id,
          type: "course_report",
          title: "New course report",
          message: `"${courseTitle}" was reported for ${reason} (report ${reportId}).`,
        })),
      );
    } catch (err) {
      logger.warn({ err, courseId, reportId }, "Failed to notify admins of course report");
    }
  }
}

export const courseService = new CourseService();
