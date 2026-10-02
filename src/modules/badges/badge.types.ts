import { z } from "zod";
import type { BadgeCriteria } from "../../database/schema.js";
import { sanitizeText } from "../../utils/sanitize.js";

export const badgeTypeSchema = z.enum([
  "enrollment",
  "quiz_completion",
  "credential",
  "streak",
  "course_completion",
]);

export type BadgeType = z.infer<typeof badgeTypeSchema>;

export const badgeCriteriaSchema = z.object({
  type: z.string().optional(),
  count: z.number().int().min(1).optional().default(1),
  threshold: z.number().optional(),
  courseId: z.string().uuid().optional(),
  action: z.string().optional(),
  days: z.number().int().min(1).optional(),
  minScore: z.number().min(0).max(100).optional(),
}).passthrough();

export const createBadgeSchema = z.object({
  name: z.string().min(1).max(255).transform(sanitizeText),
  description: z.string().min(1).transform(sanitizeText),
  iconUrl: z.string().min(1),
  type: badgeTypeSchema,
  criteria: badgeCriteriaSchema,
});

export type CreateBadgeBody = z.infer<typeof createBadgeSchema>;

export const updateBadgeSchema = z.object({
  name: z.string().min(1).max(255).transform(sanitizeText).optional(),
  description: z.string().min(1).transform(sanitizeText).optional(),
  iconUrl: z.string().min(1).optional(),
  type: badgeTypeSchema.optional(),
  criteria: badgeCriteriaSchema.optional(),
});

export type UpdateBadgeBody = z.infer<typeof updateBadgeSchema>;

export const badgeIdParamsSchema = z.object({
  id: z.string().uuid(),
});

export type BadgeIdParams = z.infer<typeof badgeIdParamsSchema>;

export interface BadgeDefinition {
  id: string;
  name: string;
  description: string;
  iconUrl: string;
  type: string;
  criteria: BadgeCriteria;
  createdAt: Date;
  updatedAt: Date;
}

export interface BadgeProgress {
  current: number;
  target: number;
  percentage: number;
}

export interface EarnedBadge {
  id: string;
  name: string;
  description: string;
  iconUrl: string;
  type: string;
  earnedAt: Date;
  progress?: BadgeProgress;
}

export interface UnearnedBadge {
  id: string;
  name: string;
  description: string;
  iconUrl: string;
  type: string;
  criteria: BadgeCriteria;
  progress: BadgeProgress;
}

export interface UserBadgesResponse {
  earned: EarnedBadge[];
  unearned: UnearnedBadge[];
  totalEarned: number;
  totalAvailable: number;
}
