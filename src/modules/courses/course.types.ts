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

// ─── Types ──────────────────────────────────────────────────────────────────

export type ListCoursesQuery = z.infer<typeof listCoursesSchema>;
export type CourseIdParams = z.infer<typeof courseIdParamsSchema>;

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
