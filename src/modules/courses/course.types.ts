import { z } from "zod";
import type { CourseModuleDefinition } from "../../database/schema.js";
import type { AccessibilityReport } from "./accessibility.js";
import { sanitizeText } from "../../utils/sanitize.js";

// ─── Request Schemas ────────────────────────────────────────────────────────

export const listCoursesSchema = z.object({
  difficulty: z.enum(["beginner", "intermediate", "advanced"]).optional(),
  search: z.string().optional(),
  page: z.coerce.number().int().min(1).default(1),
  limit: z.coerce.number().int().min(1).max(50).default(20),
});

export const courseIdParamsSchema = z.object({
  id: z.string().uuid("Invalid course ID"),
});

export const popularCoursesQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(50).default(10),
});

// Referral codes are 10-char base62 tokens; accept a small range so a
// hand-edited link still validates before we look it up.
const referralCodeSchema = z
  .string()
  .regex(/^[0-9A-Za-z]{6,16}$/, "Invalid referral code");

export const enrollCourseQuerySchema = z.object({
  ref: referralCodeSchema.optional(),
});

export const batchEnrollSchema = z.object({
  courseIds: z.array(z.string().uuid()).min(1).max(100),
});

export const shareCodeParamsSchema = z.object({
  code: referralCodeSchema,
});

// ─── Admin Request Schemas ──────────────────────────────────────────────────

export const courseModuleSchema = z.object({
  id: z.string().min(1).max(100),
  title: z.string().min(1).max(255),
  description: z.string().max(1000).optional(),
  estimatedDurationMinutes: z.coerce.number().int().positive().max(1440).optional(),
});

export const createCourseSchema = z.object({
  title: z.string().min(1).max(255),
  description: z.string().min(1),
  difficulty: z.enum(["beginner", "intermediate", "advanced"]).default("beginner"),
  tags: z.array(z.string().min(1).max(50)).max(20).default([]),
  courseModules: z.array(courseModuleSchema).max(100).optional(),
  contentHash: z.string().max(64).optional(),
});

export const updateCourseSchema = z
  .object({
    title: z.string().min(1).max(255).optional(),
    description: z.string().min(1).optional(),
    difficulty: z.enum(["beginner", "intermediate", "advanced"]).optional(),
    tags: z.array(z.string().min(1).max(50)).max(20).optional(),
    courseModules: z.array(courseModuleSchema).max(100).optional(),
    contentHash: z.string().max(64).optional(),
    isActive: z.boolean().optional(),
  })
  .refine((data) => Object.keys(data).length > 0, {
    message: "At least one field must be provided",
  });

// ─── Admin Module Request Schemas (#304) ────────────────────────────────────

export const createModuleSchema = z.object({
  title: z.string().min(1).max(255),
  description: z.string().min(1).max(2000).default(""),
  order: z.coerce.number().int().min(0).optional(),
});

export const updateModuleSchema = z
  .object({
    title: z.string().min(1).max(255).optional(),
    description: z.string().min(1).max(2000).optional(),
    order: z.coerce.number().int().min(0).optional(),
  })
  .refine((data) => Object.keys(data).length > 0, {
    message: "At least one field must be provided",
  });

export const moduleParamsSchema = z.object({
  id: z.string().uuid("Invalid course ID"),
  moduleId: z.string().min(1).max(100),
});

// ─── Review Request Schemas ─────────────────────────────────────────────────

export const listReviewsQuerySchema = z.object({
  page: z.coerce.number().int().min(1).default(1),
  limit: z.coerce.number().int().min(1).max(50).default(20),
});

// ─── Enrolled Users (admin, #355) ───────────────────────────────────────────
// ─── Admin: Enrolled Users Request Schema (#340) ────────────────────────────

export const listEnrolledUsersQuerySchema = z.object({
  page: z.coerce.number().int().min(1).default(1),
  limit: z.coerce.number().int().min(1).max(50).default(20),
});

export const createReviewSchema = z.object({
  rating: z.coerce.number().int().min(1).max(5),
  reviewText: z
    .string()
    .max(2000)
    .optional()
    .transform((v) => (v ? sanitizeText(v) : v)),
});

// ─── Types ──────────────────────────────────────────────────────────────────

export type ListCoursesQuery = z.infer<typeof listCoursesSchema>;
export type CourseIdParams = z.infer<typeof courseIdParamsSchema>;
export type PopularCoursesQuery = z.infer<typeof popularCoursesQuerySchema>;
export type EnrollCourseQuery = z.infer<typeof enrollCourseQuerySchema>;
export type BatchEnrollBody = z.infer<typeof batchEnrollSchema>;
export type ShareCodeParams = z.infer<typeof shareCodeParamsSchema>;
export type CreateCourseBody = z.infer<typeof createCourseSchema>;
export type UpdateCourseBody = z.infer<typeof updateCourseSchema>;
export type CreateModuleBody = z.infer<typeof createModuleSchema>;
export type UpdateModuleBody = z.infer<typeof updateModuleSchema>;
export type ModuleParams = z.infer<typeof moduleParamsSchema>;
export type ListReviewsQuery = z.infer<typeof listReviewsQuerySchema>;
export type ListEnrolledUsersQuery = z.infer<typeof listEnrolledUsersQuerySchema>;
export type CreateReviewBody = z.infer<typeof createReviewSchema>;
export type ListEnrolledUsersQuery = z.infer<typeof listEnrolledUsersQuerySchema>;

export interface CourseSummary {
  id: string;
  title: string;
  description: string;
  difficulty: string;
  isActive: boolean;
  enrolledCount: number;
  isEnrolled: boolean;
}

export interface CourseDetail extends CourseSummary {
  contentHash: string | null;
  modules: CourseModule[];
  createdAt: Date;
  /** Mean of all review ratings (1–5), rounded to 2dp. Null with no reviews. */
  averageRating: number | null;
  reviewCount: number;
}

export interface CourseModule {
  id: string;
  title: string;
  description: string | null;
  estimatedDurationMinutes: number | null;
  order: number;
}

/** A course module annotated with the requesting user's completion status
 * (#286) — GET /api/v1/courses/:id/modules. "Completed" means the user has
 * a non-superseded quiz submission for that module; superseded submissions
 * (left behind by a retry, #295) don't count until the new quiz is
 * resubmitted. */
export interface CourseModuleWithProgress extends CourseModule {
  completed: boolean;
}

/** One row of GET /api/v1/courses/:id/prerequisites (#369). `completed` is
 * null for an anonymous caller (no user to check completion against) and a
 * boolean — enrolled + completedAt set — for an authenticated one. */
export interface PrerequisiteCourse {
  id: string;
  title: string;
  difficulty: string;
  completed: boolean | null;
}

/** One row of GET /api/v1/courses/:id/leaderboard (#324). `averageScore` is
 * the mean of the user's per-quiz percentages (each submission's raw
 * correct-answer count normalized against its own quiz's question count, the
 * same normalization getQuizStats uses), rounded to a whole percent.
 * Superseded submissions (#295) and ungraded ones are excluded. */
export interface CourseLeaderboardEntry {
  rank: number;
  userId: string;
  displayName: string | null;
  averageScore: number;
  quizzesTaken: number;
}

/** Response of POST /api/v1/courses/:id/share (#325). */
export interface CourseShareLink {
  courseId: string;
  referralCode: string;
  /** Absolute share URL when PUBLIC_BASE_URL is configured, otherwise a
   * root-relative path. Carries the referral code as `?ref=`. */
  url: string;
  /** PNG data URI (`data:image/png;base64,...`) encoding `url`. */
  qrCode: string;
  clickCount: number;
  enrollmentCount: number;
}

/** Response of GET /api/v1/courses/shared/:code (#325) — resolves a referral
 * link, counting the click. */
export interface ResolvedShareLink {
  referralCode: string;
  sharedByUserId: string;
  course: CourseDetail;
}

/** One row of GET /api/v1/courses/:id/reviews. */
export interface CourseReview {
  id: string;
  userId: string;
  displayName: string | null;
  rating: number;
  reviewText: string | null;
  createdAt: Date;
  updatedAt: Date;
}

export interface CourseReviewsResult {
  reviews: CourseReview[];
  total: number;
  averageRating: number | null;
  totalReviews: number;
}

export interface EnrolledUserEntry {
// #340: one row per user enrolled in a course, with their quiz-progress
// summary for that course. quizCount/averageScore are scoped to quizzes
// belonging to this course (via quizzes.courseId), non-superseded
// submissions only — mirrors how reward logic elsewhere treats a
// superseded submission as no longer "the" submission for its quiz.
export interface EnrolledUserSummary {
  userId: string;
  displayName: string | null;
  stellarAddress: string;
  enrolledAt: Date;
  completedAt: Date | null;
  quizCount: number;
  /**
   * Average of quiz_submissions.score across this user's non-superseded
   * submissions for this course. score is the raw correct-answer count
   * for that submission's quiz (see QuizService.submitQuiz), NOT a
   * percentage — quizzes in this codebase aren't a fixed length, so this
   * is not comparable across quizzes with different question counts.
   * null when the user has no submissions for this course yet.
   */
  averageScore: number | null;
}

export interface EnrolledUsersResult {
  users: EnrolledUserEntry[];
  users: EnrolledUserSummary[];
  total: number;
}

export interface CourseStats {
  totalCourses: number;
  enrollmentsByDifficulty: Record<"beginner" | "intermediate" | "advanced", number>;
  averageEnrollmentsPerCourse: number;
}

export interface AdminCourse {
  id: string;
  title: string;
  description: string;
  difficulty: string;
  tags: string[];
  courseModules: CourseModuleMetadata[];
  contentHash: string | null;
  isActive: boolean;
  modules: CourseModuleDefinition[];
  /** 0–100 accessibility score for the authored content (#326). */
  accessibilityScore: number | null;
  createdAt: Date;
}

/** createCourse / updateCourse responses carry the freshly computed
 * accessibility report (#326) alongside the course so the admin UI can
 * surface warnings without a second request. */
export interface AdminCourseWithAccessibility extends AdminCourse {
  accessibility: AccessibilityReport;
}

export type CourseModuleMetadata = z.infer<typeof courseModuleSchema>;
