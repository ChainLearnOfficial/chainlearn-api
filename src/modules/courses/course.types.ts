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
  title: z.string().min(1).max(255).transform(sanitizeText),
  description: z.string().max(1000).transform(sanitizeText).optional(),
  estimatedDurationMinutes: z.coerce.number().int().positive().max(1440).optional(),
});

// Course IDs required before this one (#354) — admin-configurable via
// create/update, self-references filtered out in the service layer.
const prerequisitesSchema = z.array(z.string().uuid()).max(20).default([]);

export const createCourseSchema = z.object({
  title: z.string().min(1).max(255).transform(sanitizeText),
  description: z.string().min(1).transform(sanitizeText),
  difficulty: z.enum(["beginner", "intermediate", "advanced"]).default("beginner"),
  tags: z.array(z.string().min(1).max(50)).max(20).default([]),
  courseModules: z.array(courseModuleSchema).max(100).optional(),
  contentHash: z.string().max(64).optional(),
  prerequisites: prerequisitesSchema.optional(),
});

export const updateCourseSchema = z
  .object({
    title: z.string().min(1).max(255).transform(sanitizeText).optional(),
    description: z.string().min(1).transform(sanitizeText).optional(),
    difficulty: z.enum(["beginner", "intermediate", "advanced"]).optional(),
    tags: z.array(z.string().min(1).max(50)).max(20).optional(),
    courseModules: z.array(courseModuleSchema).max(100).optional(),
    contentHash: z.string().max(64).optional(),
    isActive: z.boolean().optional(),
    prerequisites: prerequisitesSchema.optional(),
  })
  .refine((data) => Object.keys(data).length > 0, {
    message: "At least one field must be provided",
  });

// ─── Admin Module Request Schemas (#304) ────────────────────────────────────

export const createModuleSchema = z.object({
  title: z.string().min(1).max(255).transform(sanitizeText),
  description: z.string().min(1).max(2000).transform(sanitizeText).default(""),
  order: z.coerce.number().int().min(0).optional(),
});

export const updateModuleSchema = z
  .object({
    title: z.string().min(1).max(255).transform(sanitizeText).optional(),
    description: z.string().min(1).max(2000).transform(sanitizeText).optional(),
    order: z.coerce.number().int().min(0).optional(),
  })
  .refine((data) => Object.keys(data).length > 0, {
    message: "At least one field must be provided",
  });

export const moduleParamsSchema = z.object({
  id: z.string().uuid("Invalid course ID"),
  moduleId: z.string().min(1).max(100),
});

// ─── Import Request Schema (#366) ───────────────────────────────────────────

// Bulk course creation from an uploaded JSON file — same core shape as
// createCourseSchema, plus an optional `modules` array (admin-defined
// module definitions, distinct from `courseModules`' quiz-linked metadata)
// created alongside the course in one call.
export const importCourseSchema = z.object({
  title: z.string().min(1).max(255).transform(sanitizeText),
  description: z.string().min(1).transform(sanitizeText),
  difficulty: z.enum(["beginner", "intermediate", "advanced"]).default("beginner"),
  tags: z.array(z.string().min(1).max(50)).max(20).default([]),
  courseModules: z.array(courseModuleSchema).max(100).optional(),
  contentHash: z.string().max(64).optional(),
  prerequisites: prerequisitesSchema.optional(),
  modules: z
    .array(
      z.object({
        title: z.string().min(1).max(255).transform(sanitizeText),
        description: z.string().max(2000).transform(sanitizeText).default(""),
        order: z.coerce.number().int().min(0).optional(),
      }),
    )
    .max(100)
    .default([]),
});

export type ImportCourseBody = z.infer<typeof importCourseSchema>;

export interface ImportCourseResult {
  courseId: string;
  modulesCreated: number;
}

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

// ─── Report Request Schema ───────────────────────────────────────────────────

export const reportCourseSchema = z.object({
  reason: z.enum(["inappropriate", "outdated", "error", "other"]),
  description: z
    .string()
    .max(2000)
    .optional()
    .transform((v) => (v ? sanitizeText(v) : v)),
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

/** One course's outcome in a POST /courses/enroll/batch response (#346).
 * Enrollments are attempted independently, so one failure (course archived,
 * waitlist full, already enrolled) doesn't roll back the rest. */
export interface BatchEnrollEntry {
  courseId: string;
  success: boolean;
  message?: string;
  /** True when the request was instead queued on the course's waitlist. */
  waitlisted?: boolean;
}
export type CreateCourseBody = z.infer<typeof createCourseSchema>;
/**
 * Body of POST /admin/courses/:id/draft (#376): the same editable fields as an
 * update, minus `isActive` — a draft is never published by saving it.
 */
export const draftCourseSchema = z
  .object({
    title: z.string().min(1).max(255).transform(sanitizeText).optional(),
    description: z.string().min(1).transform(sanitizeText).optional(),
    difficulty: z.enum(["beginner", "intermediate", "advanced"]).optional(),
    tags: z.array(z.string().min(1).max(50)).max(20).optional(),
    courseModules: z.array(courseModuleSchema).max(100).optional(),
    contentHash: z.string().max(64).optional(),
    prerequisites: prerequisitesSchema.optional(),
  })
  .refine((data) => Object.keys(data).length > 0, {
    message: "At least one field must be provided",
  });

export type DraftCourseBody = z.infer<typeof draftCourseSchema>;
export type UpdateCourseBody = z.infer<typeof updateCourseSchema>;
export type CreateModuleBody = z.infer<typeof createModuleSchema>;
export type UpdateModuleBody = z.infer<typeof updateModuleSchema>;
export type ModuleParams = z.infer<typeof moduleParamsSchema>;
export type ListReviewsQuery = z.infer<typeof listReviewsQuerySchema>;
export type ListEnrolledUsersQuery = z.infer<typeof listEnrolledUsersQuerySchema>;
export type CreateReviewBody = z.infer<typeof createReviewSchema>;
export type ReportCourseBody = z.infer<typeof reportCourseSchema>;

export const cloneCourseSchema = z.object({
  title: z.string().min(1).max(255).optional(),
});
export type CloneCourseBody = z.infer<typeof cloneCourseSchema>;

export const contentParamsSchema = z.object({
  id: z.string().uuid(),
  moduleId: z.string().min(1).max(100),
  contentId: z.string().uuid(),
});
export type ContentParams = z.infer<typeof contentParamsSchema>;

export const moduleContentParamsSchema = z.object({
  id: z.string().uuid(),
  moduleId: z.string().min(1).max(100),
});
export type ModuleContentParams = z.infer<typeof moduleContentParamsSchema>;

export const createContentSchema = z.discriminatedUnion("type", [
  z.object({
    title: z.string().min(1).max(255),
    type: z.literal("text"),
    content: z.object({
      body: z.string().min(1),
    }),
    orderIndex: z.number().int().min(0).optional(),
  }),
  z.object({
    title: z.string().min(1).max(255),
    type: z.literal("video"),
    content: z.object({
      videoUrl: z.string().url(),
      durationSeconds: z.number().int().min(1).optional(),
      transcript: z.string().optional(),
    }),
    orderIndex: z.number().int().min(0).optional(),
  }),
  z.object({
    title: z.string().min(1).max(255),
    type: z.literal("quiz"),
    content: z.object({
      quizId: z.string().uuid().optional(),
      questions: z.array(z.object({
        id: z.string().min(1),
        text: z.string().min(1),
        options: z.array(z.string().min(1)).min(2),
        correctIndex: z.number().int().min(0),
        explanation: z.string().optional(),
      })).optional(),
    }).refine((c) => Boolean(c.quizId || (c.questions && c.questions.length > 0)), {
      message: "Quiz content must provide quizId or questions",
    }),
    orderIndex: z.number().int().min(0).optional(),
  }),
  z.object({
    title: z.string().min(1).max(255),
    type: z.literal("exercise"),
    content: z.object({
      instructions: z.string().min(1),
      starterCode: z.string().optional(),
      solution: z.string().optional(),
      language: z.string().optional(),
    }),
    orderIndex: z.number().int().min(0).optional(),
  }),
]);
export type CreateContentBody = z.infer<typeof createContentSchema>;

export const updateContentSchema = z.object({
  title: z.string().min(1).max(255).optional(),
  type: z.enum(["text", "video", "quiz", "exercise"]).optional(),
  content: z.record(z.unknown()).optional(),
  orderIndex: z.number().int().min(0).optional(),
});
export type UpdateContentBody = z.infer<typeof updateContentSchema>;

export const reorderContentSchema = z.object({
  contentIds: z.array(z.string().uuid()).min(1).max(100),
});
export type ReorderContentBody = z.infer<typeof reorderContentSchema>;

export interface ModuleContentItem {
  id: string;
  courseId: string;
  moduleId: string;
  title: string;
  type: "text" | "video" | "quiz" | "exercise";
  content: Record<string, unknown>;
  orderIndex: number;
  createdAt: Date;
  updatedAt: Date;
}

export interface AdminCourseWithAccessibility extends AdminCourse {
  accessibilityWarnings?: import("./accessibility.js").AccessibilityWarning[];
}

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
  /** True while the course is a saved, unpublished draft (#376). */
  isDraft: boolean;
  modules: CourseModuleDefinition[];
  /** 0–100 accessibility score for the authored content (#326). */
  accessibilityScore: number | null;
  /** Course IDs that should be completed before this one (#354). */
  prerequisites: string[];
  createdAt: Date;
}

/** One row of GET /api/v1/courses/:id/prerequisites (#354). */
export interface CoursePrerequisiteEntry {
  id: string;
  title: string;
  difficulty: string;
  /** True once the requesting user has completed this prerequisite
   *  (a non-null `enrollments.completedAt`). Always false for an anonymous
   *  caller. */
  completed: boolean;
}

export interface CoursePrerequisitesResult {
  prerequisites: CoursePrerequisiteEntry[];
  /** True iff every prerequisite is completed (or there are none). */
  met: boolean;
}

/** createCourse / updateCourse responses carry the freshly computed
 * accessibility report (#326) alongside the course so the admin UI can
 * surface warnings without a second request. */
export interface AdminCourseWithAccessibility extends AdminCourse {
  accessibility: AccessibilityReport;
}

export type CourseModuleMetadata = z.infer<typeof courseModuleSchema>;

/** One bucket of GET /api/v1/admin/courses/:id/analytics's enrollment trend. */
export interface EnrollmentTrendPoint {
  /** ISO date (YYYY-MM-DD) — the start of the day/week bucket. */
  date: string;
  count: number;
}

/** Per-module quiz performance, used to flag modules learners struggle with
 * most (lowest average score) — GET /api/v1/admin/courses/:id/analytics. */
export interface ModuleDifficulty {
  moduleId: string;
  title: string | null;
  averageScore: number | null;
  submissionCount: number;
  /** True when averageScore is below the quiz passing threshold. */
  difficult: boolean;
}

/** Response of GET /api/v1/admin/courses/:id/analytics. */
export interface CourseAnalytics {
  courseId: string;
  totalEnrollments: number;
  /** Percentage (0-100) of enrollments with a non-null completedAt. */
  completionRate: number;
  /** Mean hours between enrolledAt and completedAt, null with no completions. */
  averageTimeToCompleteHours: number | null;
  /** Mean quiz score percentage across all non-superseded submissions for
   * the course's quizzes, null with no submissions. */
  averageQuizScore: number | null;
  enrollmentTrends: {
    daily: EnrollmentTrendPoint[];
    weekly: EnrollmentTrendPoint[];
  };
  /** Modules ordered by average score ascending — lowest first. */
  moduleDifficulty: ModuleDifficulty[];
  generatedAt: Date;
}

/** One module's row in the engagement report (#377). */
export interface ModuleEngagement {
  moduleId: string;
  title: string | null;
  /** Distinct users with a quiz submission for this module. */
  learnersReached: number;
  /** Percentage of the previous stage's learners who did not reach this module. */
  dropOffRate: number;
  averageScore: number | null;
  /** Percentage of this module's learners who retook its quiz. */
  quizRetakeRate: number;
}

export interface EngagementTrendPoint {
  /** Start of the week (YYYY-MM-DD). */
  week: string;
  enrollments: number;
  completions: number;
}

/** Response of GET /api/v1/admin/courses/:id/engagement (#377). */
export interface CourseEngagement {
  courseId: string;
  totalEnrollments: number;
  /** Percentage (0-100) of enrollments that completed. */
  completionRate: number;
  averageTimeToCompleteHours: number | null;
  /** Percentage of quiz-taking learners who retook at least one quiz. */
  quizRetakeRate: number;
  modules: ModuleEngagement[];
  /** The module where the largest share of learners dropped off, if any. */
  biggestDropOff: { moduleId: string; title: string | null; dropOffRate: number } | null;
  /** Enrollments and completions per week for the last 12 weeks. */
  trends: EngagementTrendPoint[];
  generatedAt: Date;
}

/** Response of POST /api/v1/courses/:id/report. */
export interface CourseReportResult {
  id: string;
  courseId: string;
  reason: string;
  status: string;
  createdAt: Date;
}

// ─── Enrollment Trends (#391) ───────────────────────────────────────────────

export const enrollmentTrendsQuerySchema = z.object({
  range: z.enum(["7d", "30d", "90d"]).default("30d"),
  granularity: z.enum(["daily", "weekly", "monthly"]).default("daily"),
});

export type EnrollmentTrendsQuery = z.infer<typeof enrollmentTrendsQuerySchema>;

export interface EnrollmentTrendDataPoint {
  date: string;
  count: number;
}

export interface EnrollmentTrendsResult {
  courseId: string;
  range: string;
  granularity: string;
  trends: EnrollmentTrendDataPoint[];
  totalEnrollments: number;
  generatedAt: Date;
}

/** One module entry in the syllabus response. */
export interface SyllabusModule {
  order: number;
  id: string;
  title: string;
  description: string | null;
  estimatedDurationMinutes: number | null;
  learningObjectives: string[];
}

/** Response of GET /api/v1/courses/:id/syllabus (#373). */
export interface CourseSyllabus {
  courseId: string;
  title: string;
  difficulty: string;
  modules: SyllabusModule[];
  totalEstimatedDurationMinutes: number | null;
  generatedAt: Date;
}

// ─── Publish Readiness Check (#384) ─────────────────────────────────────────

/**
 * Which part of the course a publish-readiness issue is about. Values are
 * stable strings so a client can group or localize the issues it renders.
 */
export type PublishCheckField =
  | "title"
  | "description"
  | "difficulty"
  | "modules"
  | "moduleContent"
  | "quizzes";

/**
 * `blocking` issues are exactly what publishCourse() refuses to publish
 * over — so `ready: true` on a publish-check guarantees the subsequent
 * publish succeeds. `advisory` issues are real quality gaps that don't stop
 * a course going live (currently only missing module content) and are
 * reported so creators can see them without being forced to fix them.
 */
export type PublishCheckSeverity = "blocking" | "advisory";

/** One unmet publish requirement (#384). */
export interface PublishCheckIssue {
  field: PublishCheckField;
  severity: PublishCheckSeverity;
  /** What is missing, phrased so a creator can act on it directly. */
  message: string;
  /** Set when the issue is about one specific module. */
  moduleId?: string;
  moduleTitle?: string;
}

/** One requirement the check evaluated, satisfied or not (#384). The
 * readiness score is computed from these, so the number is always
 * explainable from the response itself. */
export interface PublishCheckRequirement {
  /** Stable identifier, e.g. "title" or "module:<id>:quizzes". */
  key: string;
  label: string;
  satisfied: boolean;
  severity: PublishCheckSeverity;
}

/** Response of POST /api/v1/admin/courses/:id/publish-check (#384).
 * Non-destructive — nothing in the course is modified by the check. */
export interface PublishCheckResult {
  courseId: string;
  /** True when `issues` contains no blocking entry — i.e. publishing now
   * would succeed. */
  ready: boolean;
  /** 0–100, the share of requirements satisfied (blocking and advisory
   * combined). Rounded to the nearest whole percent. */
  readinessScore: number;
  requirements: PublishCheckRequirement[];
  issues: PublishCheckIssue[];
  checkedAt: Date;
}

// ─── Enrollment Status (#381) ───────────────────────────────────────────────

/** One module's progress entry in the enrollment-status response (#381). */
export interface EnrollmentModuleProgress {
  moduleId: string;
  title: string | null;
  completed: boolean;
}

/** Response of GET /api/v1/courses/:id/enrollment-status (#381). */
export interface EnrollmentStatus {
  courseId: string;
  isEnrolled: boolean;
  enrolledAt: Date | null;
  completedAt: Date | null;
  moduleProgress: EnrollmentModuleProgress[];
  quizCount: number;
  averageScore: number | null;
}

// ─── Course Progress (#385) ─────────────────────────────────────────────────

/** One module's progress in the course-progress response (#385). */
export interface CourseProgressModule {
  moduleId: string;
  title: string | null;
  order: number;
  completed: boolean;
}

/** Response of GET /api/v1/courses/:id/progress (#385). */
export interface CourseProgress {
  courseId: string;
  modules: CourseProgressModule[];
  quizzesTaken: number;
  averageScore: number | null;
  completedModules: number;
  totalModules: number;
  completionPercentage: number;
}

// ─── Quiz Attempts (#393) ───────────────────────────────────────────────────

/** One attempt entry in the quiz-attempts response (#393). */
export interface QuizAttempt {
  attemptNumber: number;
  submissionId: string;
  /** Raw correct-answer count. */
  score: number | null;
  /** Score normalized against the quiz's question count (0–100). */
  percentage: number | null;
  passed: boolean;
  /** True if this attempt was superseded by a retry (#295). */
  superseded: boolean;
  date: Date;
}

/** Response of GET /api/v1/courses/:id/modules/:moduleId/quiz-attempts (#393). */
export interface QuizAttemptsResult {
  courseId: string;
  moduleId: string;
  attempts: QuizAttempt[];
  totalAttempts: number;
}

// ─── Admin: Reorder Modules (#374) ──────────────────────────────────────────

export const reorderModulesSchema = z.object({
  moduleIds: z.array(z.string().min(1).max(100)).min(1).max(100),
});

export type ReorderModulesBody = z.infer<typeof reorderModulesSchema>;
