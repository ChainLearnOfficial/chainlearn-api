import { eq, and, count, desc, inArray } from "drizzle-orm";
import { db } from "../../config/database.js";
import { courses, enrollments, quizzes } from "../../database/schema.js";
import { NotFoundError, ConflictError } from "../../utils/errors.js";
import { withLock } from "../../utils/lock.js";
import { logger } from "../../utils/logger.js";
import {
  cacheGet,
  cacheSet,
  cacheDel,
  cacheInvalidatePattern,
  cacheKey,
} from "../../cache/index.js";
import type {
  ListCoursesQuery,
  CourseSummary,
  CourseDetail,
} from "./course.types.js";

export class CourseService {
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
    const cacheKeyString = cacheKey(
      namespace,
      "list",
      query.difficulty ?? "all",
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

  async enroll(userId: string, courseId: string): Promise<void> {
    return withLock(`enroll:${userId}:${courseId}`, async () => {
      await db.transaction(async (tx) => {
        const [course] = await tx
          .select()
          .from(courses)
          .where(eq(courses.id, courseId));

        if (!course || !course.isActive) {
          throw new NotFoundError("Course");
        }

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
        cacheDel(cacheKey("user", "progress", userId)),
        cacheDel(cacheKey("user", "enrollments", userId)),
      ]);
      const failed = invalidations.filter((r) => r.status === "rejected");
      if (failed.length > 0) {
        logger.warn(
          { userId, courseId, failedCount: failed.length },
          "Post-enroll cache invalidation had failures — affected views may serve stale data until their TTL expires",
        );
      }
    });
  }
}

export const courseService = new CourseService();
