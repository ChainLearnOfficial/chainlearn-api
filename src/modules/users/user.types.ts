import { z } from "zod";
import { sanitizeText } from "../../utils/sanitize.js";

// ─── Request Schemas ────────────────────────────────────────────────────────

// Sanitize free-text fields after length validation so stored content can
// never contain HTML/script payloads. Length is checked first (on raw input),
// then HTML is stripped.
export const updateProfileSchema = z.object({
  displayName: z
    .string()
    .min(1)
    .max(100)
    .optional()
    .transform((v) => (v ? sanitizeText(v) : v)),
  background: z
    .string()
    .max(1000)
    .optional()
    .transform((v) => (v ? sanitizeText(v) : v)),
  learningGoal: z
    .string()
    .max(500)
    .optional()
    .transform((v) => (v ? sanitizeText(v) : v)),
  pace: z.enum(["slow", "medium", "fast"]).optional(),
  language: z.string().max(10).optional(),
});

export const activityQuerySchema = z.object({
  cursor: z.string().datetime().optional(),
  limit: z.coerce.number().int().min(1).max(50).default(20),
});

// ─── Types ──────────────────────────────────────────────────────────────────

export type UpdateProfileBody = z.infer<typeof updateProfileSchema>;
export type ActivityQuery = z.infer<typeof activityQuerySchema>;

export interface UserProfile {
  id: string;
  stellarAddress: string;
  displayName: string | null;
  avatarUrl: string | null;
  background: string | null;
  learningGoal: string | null;
  pace: string;
  language: string;
  credits: number;
  createdAt: Date;
}

export interface UserProgress {
  enrolledCourses: number;
  completedCourses: number;
  totalQuizScore: number;
  credentialsEarned: number;
  rewardsClaimed: number;
}

export type UserActivityType =
  | "enrollment"
  | "quiz_submission"
  | "credential_mint"
  | "reward_claim";

export interface UserActivity {
  type: UserActivityType;
  title: string;
  timestamp: Date;
  metadata: Record<string, unknown>;
}

export interface UserActivityPage {
  activities: UserActivity[];
  nextCursor: string | null;
}

export interface AvatarUpload {
  buffer: Buffer;
  filename: string;
  mimetype: string;
  size: number;
}

// ─── GDPR Data Export (#350) ────────────────────────────────────────────────

export interface UserDataExport {
  exportVersion: 1;
  exportedAt: string;
  profile: UserProfile;
  enrollments: {
    courseId: string;
    courseTitle: string;
    enrolledAt: Date;
    completedAt: Date | null;
  }[];
  quizSubmissions: {
    id: string;
    quizId: string;
    score: number | null;
    submittedAt: Date;
  }[];
  credentials: {
    id: string;
    courseId: string;
    courseTitle: string;
    score: number;
    nftAssetCode: string | null;
    nftIssuer: string | null;
    mintTxHash: string | null;
    revoked: boolean;
    mintedAt: Date;
  }[];
  rewardClaims: {
    submissionId: string;
    amount: number | null;
    txHash: string | null;
    claimedAt: Date;
  }[];
}

// ─── Learning Stats (#383) ──────────────────────────────────────────────────

/** Comprehensive learning statistics for the authenticated user (#383). */
export interface LearningStats {
  coursesCompleted: number;
  quizzesTaken: number;
  averageScore: number | null;
  creditsEarned: number;
  credentialsEarned: number;
  /** Current consecutive-day learning streak (1 = active today). */
  learningStreak: number;
  /** Estimated total study time in minutes, derived from quiz submissions. */
  estimatedTotalStudyTimeMinutes: number;
  /** Quizzes taken in the last 7 days — a simple learning-velocity metric. */
  learningVelocity: number;
}
