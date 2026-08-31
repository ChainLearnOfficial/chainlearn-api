import { eq, and, count, desc, inArray, ilike, or, isNull } from "drizzle-orm";
import { eq, and, count, desc, inArray, ilike, or, sql } from "drizzle-orm";
import { db } from "../../config/database.js";
import {
  courses,
  enrollments,
  quizzes,
  type CourseModuleDefinition,
} from "../../database/schema.js";
import { config } from "../../config/index.js";
import { NotFoundError, ConflictError, ForbiddenError } from "../../utils/errors.js";
import { withLock } from "../../utils/lock.js";
import { logger } from "../../utils/logger.js";
import { getOnChainContentHash } from "../../stellar/progress-tracker.js";
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
  ListCoursesQuery,
  CourseSummary,
  CourseDetail,
  CourseStats,
  AdminCourse,
  CreateCourseBody,
  UpdateCourseBody,
  CreateModuleBody,
  UpdateModuleBody,
} from "./course.types.js";

const POPULAR_COURSES_TTL_SECONDS = 300;

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

      const moduleRows = await db
        .select({ moduleId: quizzes.moduleId })
        .from(quizzes)
        .where(eq(quizzes.courseId, courseId))
        .groupBy(quizzes.moduleId)
        .orderBy(quizzes.moduleId);

      cachedDetail = {
        id: course.id,
        title: course.title,
        description: course.description,
        difficulty: course.difficulty,
        isActive: course.isActive,
        enrolledCount: countResult?.value ?? 0,
        contentHash: course.contentHash,
        modules: moduleRows.map((row, i) => ({
          id: row.moduleId,
          title: row.moduleId,
          order: i + 1,
        })),
        createdAt: course.createdAt,
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

      // Cache invalidation necessarily happens outside the DB transaction —
      // Redis isn't part of the Postgres transaction, so there's no way to
      // make this atomic with the commit above (issue #152). cacheDel/
      // cacheInvalidatePattern already fail soft (log a warning, never
      // throw), and every cache touched here has a bounded TTL (<=30s), so
      // a transient invalidation failure produces bounded staleness rather
      // than a permanently stale cache. Run them concurrently — reduces the
      // real-world window between commit and invalidation rather than
      // running four sequential round-trips one after another — and log
      // once at this call site (distinct from cacheDel's generic per-key
      // warning) so a failure here is attributable specifically to an
      // enrollment, not just "some cache key somewhere".
      const invalidations = await Promise.allSettled([
        cacheInvalidatePattern("chainlearn:courses:list:*"),
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

  // ─── Admin ──────────────────────────────────────────────────────────────

  private async invalidateCourseCaches(courseId?: string): Promise<void> {
    const invalidations = await Promise.allSettled([
      cacheInvalidatePattern(cacheKeyPattern("courses", "list")),
      cacheInvalidatePattern(cacheKeyPattern("courses", "popular")),
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
      contentHash: row.contentHash,
      isActive: row.isActive,
      modules: (row.modules ?? []) as CourseModuleDefinition[],
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
}

export const courseService = new CourseService();
