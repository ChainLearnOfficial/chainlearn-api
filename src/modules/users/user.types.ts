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
