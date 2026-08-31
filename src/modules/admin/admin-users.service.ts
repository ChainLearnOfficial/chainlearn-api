import { and, count, desc, ilike, or, eq } from "drizzle-orm";
import { db } from "../../config/database.js";
import {
  users,
  enrollments,
  quizSubmissions,
  credentials,
  courses,
  auditLogs,
} from "../../database/schema.js";
import { NotFoundError } from "../../utils/errors.js";
import type { AdminUserSummary, ListUsersQuery } from "./admin.types.js";

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
}

  /**
   * Ban a user and invalidate all their sessions (#347). Once banned,
   * the user receives 403 on all authenticated requests.
   */
  async banUser(
    userId: string,
    reason: string,
  ): Promise<void> {
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
   * Get user activity feed (#346). Queries audit logs, quiz submissions,
   * enrollments, and reward claims for a specific user. Returns chronological
   * activity with type, details, and timestamp.
   */
  async getUserActivity(userId: string): Promise<Array<{
    type: string;
    title: string;
    timestamp: Date;
    details: Record<string, unknown>;
  }>> {
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
      (a, b) => b.timestamp.getTime() - a.timestamp.getTime()
    );
  }
}

export const adminUsersService = new AdminUsersService();
