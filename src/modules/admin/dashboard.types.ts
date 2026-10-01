// ─── Types ──────────────────────────────────────────────────────────────────

/** A metric alongside its comparison to the same-length prior period,
 *  e.g. "this week" vs "the week before". `changePercent` is null when the
 *  prior period's value was 0 (a percentage change is undefined). */
export interface TrendMetric {
  current: number;
  previous: number;
  changePercent: number | null;
}

export interface AdminDashboardStats {
  totalUsers: number;
  newUsersToday: number;
  newUsersThisWeek: number;
  newUsersThisMonth: number;
  totalEnrollments: number;
  /** Percentage (0–100) of quiz submissions that have been graded
   *  (score IS NOT NULL), rounded to 2dp. */
  quizCompletionRate: number;
  totalCredentials: number;
  /** Sum of `quizSubmissions.rewardAmount` across all claimed rewards. */
  totalRewardsClaimed: number;
  trends: {
    /** New user signups: this week vs. the week before. */
    newUsers: TrendMetric;
    /** New enrollments: this week vs. the week before. */
    enrollments: TrendMetric;
  };
  generatedAt: string;
}
