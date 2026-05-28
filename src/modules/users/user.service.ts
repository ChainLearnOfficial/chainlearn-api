import { eq, count, sql } from "drizzle-orm";
import { db } from "../../config/database.js";
import {
  users,
  enrollments,
  quizSubmissions,
  credentials,
} from "../../database/schema.js";
import { NotFoundError } from "../../utils/errors.js";
import type { UpdateProfileBody, UserProfile, UserProgress } from "./user.types.js";

export class UserService {
  async getProfile(userId: string): Promise<UserProfile> {
    const user = await db.query.users.findFirst({
      where: eq(users.id, userId),
    });

    if (!user) {
      throw new NotFoundError("User");
    }

    return {
      id: user.id,
      stellarAddress: user.stellarAddress,
      displayName: user.displayName,
      background: user.background,
      learningGoal: user.learningGoal,
      pace: user.pace ?? "medium",
      language: user.language ?? "en",
      credits: user.credits,
      createdAt: user.createdAt,
    };
  }

  async updateProfile(
    userId: string,
    data: UpdateProfileBody
  ): Promise<UserProfile> {
    const [updated] = await db
      .update(users)
      .set({ ...data, updatedAt: new Date() })
      .where(eq(users.id, userId))
      .returning();

    if (!updated) {
      throw new NotFoundError("User");
    }

    return {
      id: updated.id,
      stellarAddress: updated.stellarAddress,
      displayName: updated.displayName,
      background: updated.background,
      learningGoal: updated.learningGoal,
      pace: updated.pace ?? "medium",
      language: updated.language ?? "en",
      credits: updated.credits,
      createdAt: updated.createdAt,
    };
  }

  async getProgress(userId: string): Promise<UserProgress> {
    const user = await db.query.users.findFirst({
      where: eq(users.id, userId),
    });

    if (!user) {
      throw new NotFoundError("User");
    }

    const [enrolledResult] = await db
      .select({ value: count() })
      .from(enrollments)
      .where(eq(enrollments.userId, userId));

    const [completedResult] = await db
      .select({ value: count() })
      .from(enrollments)
      .where(
        sql`${enrollments.userId} = ${userId} AND ${enrollments.completedAt} IS NOT NULL`
      );

    const [quizScoreResult] = await db
      .select({
        total: sql<number>`COALESCE(SUM(${quizSubmissions.score}), 0)`,
      })
      .from(quizSubmissions)
      .where(eq(quizSubmissions.userId, userId));

    const [credResult] = await db
      .select({ value: count() })
      .from(credentials)
      .where(eq(credentials.userId, userId));

    const [rewardsResult] = await db
      .select({ value: count() })
      .from(quizSubmissions)
      .where(
        sql`${quizSubmissions.userId} = ${userId} AND ${quizSubmissions.rewardClaimed} = true`
      );

    return {
      enrolledCourses: enrolledResult.value,
      completedCourses: completedResult.value,
      totalQuizScore: Number(quizScoreResult.total),
      credentialsEarned: credResult.value,
      rewardsClaimed: rewardsResult.value,
    };
  }
}

export const userService = new UserService();
