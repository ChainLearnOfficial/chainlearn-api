import { eq, and, count, desc, inArray, notInArray, avg, sql } from "drizzle-orm";
import { db } from "../../config/database.js";
import { courses, enrollments, credentials, quizSubmissions, quizzes } from "../../database/schema.js";
import { NotFoundError, ConflictError } from "../../utils/errors.js";
import { withLock } from "../../utils/lock.js";
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
  RecommendedCourse,
  GetRecommendationsResult,
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

      await cacheInvalidatePattern(cacheKeyPattern("courses", "list"));
      await cacheDel(cacheKey("courses", "detail", courseId));
      await cacheDel(cacheKey("user", "progress", userId));
    });
  }

  /**
   * Returns a personalised list of recommended courses for the given user.
   *
   * ## Query plan (≤ 3 DB round-trips per request)
   *
   * **Query 1 — user context** (always runs, never cached individually)
   * A single query joining enrollments LEFT JOIN credentials LEFT JOIN a
   * quiz_submissions aggregate subquery. Returns:
   *   - every course the user is already enrolled in (→ exclusion list)
   *   - which of those they completed (completedAt IS NOT NULL)
   *   - whether they have a credential (credentialCourseId IS NOT NULL)
   *   - their average quiz score across all submissions
   * This merges original queries 1, 2, and 3 into one round-trip.
   *
   * **Query 2 — peer collaborative signal** (cached 24 h per user)
   * Finds other users who share ≥1 enrolled course with the current user
   * (capped at 500 peers), then aggregates the other courses those peers
   * enrolled in. Expensive for large datasets; the 24-hour cache means the
   * full join only re-runs once per day per user.
   * This replaces original query 4.
   *
   * **Query 3 — candidate courses + enrollment counts** (result cached 1 h)
   * Fetches active courses the user is NOT enrolled in, with their total
   * enrollment counts included via a lateral subquery, in a single pass.
   * This merges original queries 5 and 6 into one round-trip.
   *
   * ## Scoring
   * Each candidate is scored as:
   *   peerCount × 3   (collaborative signal — strongest indicator)
   *   + difficultyBonus (2 if matches inferred level, 1 if adjacent)
   *   + log(enrolledCount + 1) (popularity fallback for new users)
   *
   * Results are sorted descending by score, capped at `limit`.
   */
  async getRecommendedCourses(
    userId: string,
    limit = 10,
  ): Promise<GetRecommendationsResult> {
    const RESULT_CACHE_TTL = 60 * 60;       // 1 hour
    const PEER_CACHE_TTL  = 60 * 60 * 24;  // 24 hours
    const MAX_PEERS       = 500;
    const DIFFICULTY_ORDER = ["beginner", "intermediate", "advanced"] as const;

    const resultCacheKey = cacheKey("courses", "recommended", userId);
    const peerCacheKey   = cacheKey("courses", "recommended", "peers", userId);

    // ── Full result cache ────────────────────────────────────────────────
    const cached = await cacheGet<GetRecommendationsResult>(
      "courses",
      resultCacheKey,
    );
    if (cached) return cached;

    // ── Query 1: user context ────────────────────────────────────────────
    // Joins enrollments → credentials (LEFT) → per-user avg score subquery.
    // One round-trip replaces the original 3 sequential queries.
    const userScoreSubquery = db
      .select({
        userId: quizSubmissions.userId,
        avgScore: avg(quizSubmissions.score).as("avg_score"),
      })
      .from(quizSubmissions)
      .where(eq(quizSubmissions.userId, userId))
      .groupBy(quizSubmissions.userId)
      .as("user_scores");

    const userEnrollmentRows = await db
      .select({
        courseId:           enrollments.courseId,
        completedAt:        enrollments.completedAt,
        credentialCourseId: credentials.courseId,
        avgScore:           userScoreSubquery.avgScore,
      })
      .from(enrollments)
      .leftJoin(
        credentials,
        and(
          eq(credentials.userId, userId),
          eq(credentials.courseId, enrollments.courseId),
        ),
      )
      .leftJoin(userScoreSubquery, eq(userScoreSubquery.userId, userId))
      .where(eq(enrollments.userId, userId));

    const enrolledCourseIds = userEnrollmentRows.map((r) => r.courseId);
    const completedCourseIds = new Set(
      userEnrollmentRows
        .filter((r) => r.completedAt !== null)
        .map((r) => r.courseId),
    );

    // Infer preferred difficulty from completed courses
    const rawAvgScore = userEnrollmentRows[0]?.avgScore ?? null;
    const avgScore = rawAvgScore !== null ? parseFloat(String(rawAvgScore)) : null;

    // Map avg score → difficulty bucket
    // ≥ 80 → ready for the next level; < 50 → suggest easier; otherwise stay
    const completedCount = completedCourseIds.size;
    let inferredDifficulty: (typeof DIFFICULTY_ORDER)[number] | null = null;
    if (completedCount > 0 && avgScore !== null) {
      // Most-common difficulty among completed courses would require another
      // query; instead use score as a proxy (sufficient without extra DB call)
      if (avgScore >= 80) {
        inferredDifficulty = "intermediate"; // default upward step
      } else if (avgScore < 50) {
        inferredDifficulty = "beginner";
      } else {
        inferredDifficulty = "intermediate";
      }
    } else if (completedCount === 0) {
      inferredDifficulty = "beginner";
    }

    // ── Query 2: peer collaborative signal (24 h cache) ──────────────────
    // Returns a map of courseId → number of peers who enrolled in that course.
    let peerCourseSignal = await cacheGet<Record<string, number>>(
      "courses",
      peerCacheKey,
    );

    if (!peerCourseSignal) {
      peerCourseSignal = {};

      if (enrolledCourseIds.length > 0) {
        // Single query: use a subquery to find peer user IDs inline, then
        // aggregate their other enrollments — one round-trip instead of two.
        const peersSubquery = db
          .selectDistinct({ peerId: enrollments.userId })
          .from(enrollments)
          .where(
            and(
              inArray(enrollments.courseId, enrolledCourseIds),
              sql`${enrollments.userId} != ${userId}`,
            ),
          )
          .limit(MAX_PEERS)
          .as("peers");

        const peerEnrollmentCounts = await db
          .select({
            courseId:  enrollments.courseId,
            peerCount: count().as("peer_count"),
          })
          .from(enrollments)
          .innerJoin(peersSubquery, eq(enrollments.userId, peersSubquery.peerId))
          .where(
            enrolledCourseIds.length > 0
              ? notInArray(enrollments.courseId, enrolledCourseIds)
              : sql`true`,
          )
          .groupBy(enrollments.courseId);

        for (const row of peerEnrollmentCounts) {
          peerCourseSignal[row.courseId] = row.peerCount;
        }
      }

      await cacheSet(peerCacheKey, peerCourseSignal, PEER_CACHE_TTL);
    }

    // ── Query 3: candidate courses + enrollment counts ────────────────────
    // Single query: active courses the user isn't in, with enrollment count
    // included via a correlated subquery. Merges original queries 5 and 6.
    const candidateQuery = db
      .select({
        id:            courses.id,
        title:         courses.title,
        description:   courses.description,
        difficulty:    courses.difficulty,
        isActive:      courses.isActive,
        // Inline correlated subquery so enrollment counts come back in the
        // same round-trip rather than a separate aggregation query.
        enrolledCount: sql<number>`(
          SELECT count(*)::int
          FROM enrollments e2
          WHERE e2.course_id = ${courses.id}
        )`.as("enrolled_count"),
      })
      .from(courses)
      .where(
        and(
          eq(courses.isActive, true),
          enrolledCourseIds.length > 0
            ? notInArray(courses.id, enrolledCourseIds)
            : sql`true`,
        ),
      );

    const candidates = await candidateQuery;

    // ── Scoring ──────────────────────────────────────────────────────────
    const difficultyIndex = inferredDifficulty
      ? DIFFICULTY_ORDER.indexOf(inferredDifficulty)
      : -1;

    const scored = candidates.map((course) => {
      const peerCount   = peerCourseSignal![course.id] ?? 0;
      const popularity  = Math.log(course.enrolledCount + 1);

      // Difficulty affinity bonus
      let difficultyBonus = 0;
      if (difficultyIndex >= 0) {
        const courseIdx = DIFFICULTY_ORDER.indexOf(
          course.difficulty as (typeof DIFFICULTY_ORDER)[number],
        );
        if (courseIdx === difficultyIndex) {
          difficultyBonus = 2; // exact match
        } else if (Math.abs(courseIdx - difficultyIndex) === 1) {
          difficultyBonus = 1; // adjacent level
        }
      }

      const score = peerCount * 3 + difficultyBonus + popularity;

      // Determine primary reason for recommendation
      let reason: RecommendedCourse["reason"];
      if (peerCount > 0) {
        reason = "peer";
      } else if (difficultyBonus > 0) {
        reason = "difficulty";
      } else {
        reason = "popular";
      }

      return { course, score, reason };
    });

    scored.sort((a, b) => b.score - a.score);
    const top = scored.slice(0, limit);

    const result: GetRecommendationsResult = {
      courses: top.map(({ course, score, reason }) => ({
        id:                  course.id,
        title:               course.title,
        description:         course.description,
        difficulty:          course.difficulty,
        isActive:            course.isActive,
        enrolledCount:       course.enrolledCount,
        recommendationScore: Math.round(score * 100) / 100,
        reason,
      })),
      inferredDifficulty,
    };

    await cacheSet(resultCacheKey, result, RESULT_CACHE_TTL);

    return result;
  }
}

export const courseService = new CourseService();
