import { eq, and, count, desc, inArray } from "drizzle-orm";
import { db } from "../../config/database.js";
import { courses, enrollments } from "../../database/schema.js";
import { NotFoundError, ConflictError } from "../../utils/errors.js";
import { withLock } from "../../utils/lock.js";
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
      const userEnrs = await db
        .select({ courseId: enrollments.courseId })
        .from(enrollments)
        .where(
          and(
            eq(enrollments.userId, userId),
            inArray(
              enrollments.courseId,
              finalCourses.map((c) => c.id),
            ),
          ),
        );

      // Check if current user is enrolled in each course
      const userEnrollments = new Set(userEnrs.map((e) => e.courseId));
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

      cachedDetail = {
        id: course.id,
        title: course.title,
        description: course.description,
        difficulty: course.difficulty,
        isActive: course.isActive,
        enrolledCount: countResult?.value ?? 0,
        contentHash: course.contentHash,
        modules: [], // TODO: fetch from IPFS/content store
        createdAt: course.createdAt,
      };

      await cacheSet(cacheKeyString, cachedDetail, 120);
    }

    // Check enrollment
    let isEnrolled = false;
    if (userId) {
      const enr = await db.query.enrollments.findFirst({
        where: and(
          eq(enrollments.userId, userId),
          eq(enrollments.courseId, courseId),
        ),
      });
      isEnrolled = !!enr;
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

      await cacheInvalidatePattern("chainlearn:courses:list:*");
      await cacheDel(cacheKey("courses", "detail", courseId));
      await cacheDel(cacheKey("user", "progress", userId));
    });
  }
}

export const courseService = new CourseService();
