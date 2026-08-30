import { z } from "zod";

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

// ─── Admin Request Schemas ──────────────────────────────────────────────────

export const createCourseSchema = z.object({
  title: z.string().min(1).max(255),
  description: z.string().min(1),
  difficulty: z.enum(["beginner", "intermediate", "advanced"]).default("beginner"),
  tags: z.array(z.string().min(1).max(50)).max(20).default([]),
  contentHash: z.string().max(64).optional(),
});

export const updateCourseSchema = z
  .object({
    title: z.string().min(1).max(255).optional(),
    description: z.string().min(1).optional(),
    difficulty: z.enum(["beginner", "intermediate", "advanced"]).optional(),
    tags: z.array(z.string().min(1).max(50)).max(20).optional(),
    contentHash: z.string().max(64).optional(),
    isActive: z.boolean().optional(),
  })
  .refine((data) => Object.keys(data).length > 0, {
    message: "At least one field must be provided",
  });

// ─── Types ──────────────────────────────────────────────────────────────────

export type ListCoursesQuery = z.infer<typeof listCoursesSchema>;
export type CourseIdParams = z.infer<typeof courseIdParamsSchema>;
export type PopularCoursesQuery = z.infer<typeof popularCoursesQuerySchema>;
export type CreateCourseBody = z.infer<typeof createCourseSchema>;
export type UpdateCourseBody = z.infer<typeof updateCourseSchema>;

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
  contentHash: string | null;
  isActive: boolean;
  createdAt: Date;
}
