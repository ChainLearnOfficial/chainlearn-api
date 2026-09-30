import { and, count, eq, gte, isNull, lt, sql } from "drizzle-orm";
import { db } from "../../config/database.js";
import {
  users,
  enrollments,
  quizSubmissions,
  credentials,
} from "../../database/schema.js";
import { cacheGet, cacheSet, cacheKey } from "../../cache/index.js";
import type { AdminDashboardStats, TrendMetric } from "./dashboard.types.js";

const DASHBOARD_CACHE_TTL_SECONDS = 300;
const DAY_MS = 24 * 60 * 60 * 1000;
const WEEK_MS = 7 * DAY_MS;

function startOfDay(now: Date): Date {
  return new Date(now.getFullYear(), now.getMonth(), now.getDate());
}

function startOfMonth(now: Date): Date {
  return new Date(now.getFullYear(), now.getMonth(), 1);
}

function trend(current: number, previous: number): TrendMetric {
  return {
    current,
    previous,
    changePercent:
      previous === 0 ? null : Number((((current - previous) / previous) * 100).toFixed(2)),
  };
}

export class DashboardService {
  /**
   * Platform-wide stats for the admin console (#367): totals, new-user
   * counts over rolling windows, quiz completion rate, total credentials
   * and rewards claimed, plus week-over-week trend comparisons. Cached for
   * 5 minutes since none of these need to be real-time and every query
   * here is a full-table aggregate.
   */
  async getStats(): Promise<AdminDashboardStats> {
    const namespace = "admin";
    const cacheKeyString = cacheKey(namespace, "dashboard-stats");

    const cached = await cacheGet<AdminDashboardStats>(namespace, cacheKeyString);
    if (cached) return cached;

    const now = new Date();
    const dayStart = startOfDay(now);
    const weekStart = new Date(now.getTime() - WEEK_MS);
    const prevWeekStart = new Date(now.getTime() - 2 * WEEK_MS);
    const monthStart = startOfMonth(now);

    const [
      [totalUsersResult],
      [newTodayResult],
      [newThisWeekResult],
      [newPrevWeekResult],
      [newThisMonthResult],
      [totalEnrollmentsResult],
      [enrollThisWeekResult],
      [enrollPrevWeekResult],
      [submissionStats],
      [totalCredentialsResult],
      [rewardsResult],
    ] = await Promise.all([
      db.select({ value: count() }).from(users).where(isNull(users.deletedAt)),
      db
        .select({ value: count() })
        .from(users)
        .where(and(isNull(users.deletedAt), gte(users.createdAt, dayStart))),
      db
        .select({ value: count() })
        .from(users)
        .where(and(isNull(users.deletedAt), gte(users.createdAt, weekStart))),
      db
        .select({ value: count() })
        .from(users)
        .where(
          and(
            isNull(users.deletedAt),
            gte(users.createdAt, prevWeekStart),
            lt(users.createdAt, weekStart),
          ),
        ),
      db
        .select({ value: count() })
        .from(users)
        .where(and(isNull(users.deletedAt), gte(users.createdAt, monthStart))),
      db.select({ value: count() }).from(enrollments),
      db
        .select({ value: count() })
        .from(enrollments)
        .where(gte(enrollments.enrolledAt, weekStart)),
      db
        .select({ value: count() })
        .from(enrollments)
        .where(
          and(
            gte(enrollments.enrolledAt, prevWeekStart),
            lt(enrollments.enrolledAt, weekStart),
          ),
        ),
      db
        .select({
          total: count(),
          graded: sql<number>`COUNT(${quizSubmissions.score})`,
        })
        .from(quizSubmissions),
      db
        .select({ value: count() })
        .from(credentials)
        .where(eq(credentials.revoked, false)),
      db
        .select({
          value: sql<number>`COALESCE(SUM(${quizSubmissions.rewardAmount}), 0)`,
        })
        .from(quizSubmissions)
        .where(eq(quizSubmissions.rewardClaimed, true)),
    ]);

    const totalSubmissions = submissionStats?.total ?? 0;
    const gradedSubmissions = Number(submissionStats?.graded ?? 0);

    const stats: AdminDashboardStats = {
      totalUsers: totalUsersResult?.value ?? 0,
      newUsersToday: newTodayResult?.value ?? 0,
      newUsersThisWeek: newThisWeekResult?.value ?? 0,
      newUsersThisMonth: newThisMonthResult?.value ?? 0,
      totalEnrollments: totalEnrollmentsResult?.value ?? 0,
      quizCompletionRate:
        totalSubmissions === 0
          ? 0
          : Number(((gradedSubmissions / totalSubmissions) * 100).toFixed(2)),
      totalCredentials: totalCredentialsResult?.value ?? 0,
      totalRewardsClaimed: Number(rewardsResult?.value ?? 0),
      trends: {
        newUsers: trend(newThisWeekResult?.value ?? 0, newPrevWeekResult?.value ?? 0),
        enrollments: trend(
          enrollThisWeekResult?.value ?? 0,
          enrollPrevWeekResult?.value ?? 0,
        ),
      },
      generatedAt: now.toISOString(),
    };

    await cacheSet(cacheKeyString, stats, DASHBOARD_CACHE_TTL_SECONDS);

    return stats;
  }
}

export const dashboardService = new DashboardService();
