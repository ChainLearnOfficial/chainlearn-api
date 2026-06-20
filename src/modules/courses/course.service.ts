import { eq, and, count, desc } from "drizzle-orm";
import { db } from "../../config/database.js";
import { courses, enrollments } from "../../database/schema.js";
import { NotFoundError, ConflictError } from "../../utils/errors.js";
import { withLock } from "../../utils/lock.js";
import type {
  ListCoursesQuery,
  CourseSummary,
  CourseDetail,
} from "./course.types.js";

export class CourseService {
  async listCourses(
    userId: string | null,
    query: ListCoursesQuery
  ): Promise<{ courses: CourseSummary[]; total: number }> {
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
        .where(
          eq(enrollments.courseId, courseIds[0])
        )
        .groupBy(enrollments.courseId);

      for (const c of counts) {
        enrollmentCounts.set(c.courseId, c.value);
      }
    }

    // Check if current user is enrolled in each course
    const userEnrollments = new Set<string>();
    if (userId) {
      const userEnrs = await db
        .select({ courseId: enrollments.courseId })
        .from(enrollments)
        .where(eq(enrollments.userId, userId));
      for (const e of userEnrs) {
        userEnrollments.add(e.courseId);
      }
    }

    const courseList: CourseSummary[] = rows.map((row) => ({
      id: row.id,
      title: row.title,
      description: row.description,
      difficulty: row.difficulty,
      isActive: row.isActive,
      enrolledCount: enrollmentCounts.get(row.id) ?? 0,
      isEnrolled: userEnrollments.has(row.id),
    }));

    return { courses: courseList, total: totalResult.value };
  }

  async getCourseDetail(
    courseId: string,
    userId: string | null
  ): Promise<CourseDetail> {
    const course = await db.query.courses.findFirst({
      where: eq(courses.id, courseId),
    });

    if (!course || !course.isActive) {
      throw new NotFoundError("Course");
    }

    // Check enrollment
    let isEnrolled = false;
    if (userId) {
      const enr = await db.query.enrollments.findFirst({
        where: and(
          eq(enrollments.userId, userId),
          eq(enrollments.courseId, courseId)
        ),
      });
      isEnrolled = !!enr;
    }

    return {
      id: course.id,
      title: course.title,
      description: course.description,
      difficulty: course.difficulty,
      isActive: course.isActive,
      enrolledCount: 0, // TODO: aggregate
      isEnrolled,
      contentHash: course.contentHash,
      modules: [], // TODO: fetch from IPFS/content store
      createdAt: course.createdAt,
    };
  }

  async enroll(userId: string, courseId: string): Promise<void> {
    return withLock(`enroll:${userId}:${courseId}`, async () => {
      return db.transaction(async (tx) => {
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
              eq(enrollments.courseId, courseId)
            )
          )
          .for("update");

        if (existing) {
          throw new ConflictError("Already enrolled in this course");
        }

        await tx.insert(enrollments).values({ userId, courseId });
      });
    });
  }
}

export const courseService = new CourseService();
