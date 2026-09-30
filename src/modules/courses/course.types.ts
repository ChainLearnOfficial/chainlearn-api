import { z } from "zod";

// ─── Request Schemas ────────────────────────────────────────────────────────

export const listCoursesSchema = z.object({
  difficulty: z.enum(["beginner", "intermediate", "advanced"]).optional(),
  page: z.coerce.number().int().min(1).default(1),
  limit: z.coerce.number().int().min(1).max(50).default(20),
});

export const courseIdParamsSchema = z.object({
  id: z.string().uuid("Invalid course ID"),
});

export const recommendationsQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(20).default(10),
});

// ─── Types ──────────────────────────────────────────────────────────────────

export type ListCoursesQuery = z.infer<typeof listCoursesSchema>;
export type CourseIdParams = z.infer<typeof courseIdParamsSchema>;
export type RecommendationsQuery = z.infer<typeof recommendationsQuerySchema>;

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
}

export interface CourseModule {
  id: string;
  title: string;
  order: number;
}

// ─── Recommendations ─────────────────────────────────────────────────────────

/**
 * A single recommended course, extending CourseSummary with a score that
 * reflects how strongly the course is recommended for this user (higher = better).
 * The score is computed from collaborative peer signal and difficulty affinity,
 * and is exposed so clients can show relative relevance if desired.
 */
export interface RecommendedCourse extends Omit<CourseSummary, "isEnrolled"> {
  recommendationScore: number;
  /**
   * Why this course was recommended. Helps the client display a reason badge.
   * "peer"      — peers who share your courses also enrolled in this one
   * "difficulty" — matches your demonstrated difficulty level
   * "popular"   — highly enrolled course you haven't started yet
   */
  reason: "peer" | "difficulty" | "popular";
}

export interface GetRecommendationsResult {
  courses: RecommendedCourse[];
  /** Average difficulty level inferred from the user's completed courses. */
  inferredDifficulty: string | null;
}
