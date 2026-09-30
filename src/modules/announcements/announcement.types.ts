import { z } from "zod";

// ─── Request Schemas ────────────────────────────────────────────────────────

export const announcementPrioritySchema = z.enum(["normal", "high", "urgent"]);

export const createAnnouncementSchema = z.object({
  title: z.string().min(1).max(255),
  message: z.string().min(1),
  priority: announcementPrioritySchema.default("normal"),
  active: z.boolean().default(true),
  expiresAt: z.coerce.date().optional(),
});

export const updateAnnouncementSchema = z
  .object({
    title: z.string().min(1).max(255).optional(),
    message: z.string().min(1).optional(),
    priority: announcementPrioritySchema.optional(),
    active: z.boolean().optional(),
    // Explicit null clears an existing expiry; omitted leaves it unchanged.
    expiresAt: z.coerce.date().nullable().optional(),
  })
  .refine((data) => Object.keys(data).length > 0, {
    message: "At least one field must be provided",
  });

export const announcementIdParamsSchema = z.object({
  id: z.string().uuid("Invalid announcement ID"),
});

export const listAnnouncementsAdminQuerySchema = z.object({
  page: z.coerce.number().int().min(1).default(1),
  limit: z.coerce.number().int().min(1).max(50).default(20),
});

// ─── Types ──────────────────────────────────────────────────────────────────

export type AnnouncementPriority = z.infer<typeof announcementPrioritySchema>;
export type CreateAnnouncementBody = z.infer<typeof createAnnouncementSchema>;
export type UpdateAnnouncementBody = z.infer<typeof updateAnnouncementSchema>;
export type AnnouncementIdParams = z.infer<typeof announcementIdParamsSchema>;
export type ListAnnouncementsAdminQuery = z.infer<
  typeof listAnnouncementsAdminQuerySchema
>;

export interface Announcement {
  id: string;
  title: string;
  message: string;
  priority: AnnouncementPriority;
  active: boolean;
  createdAt: Date;
  expiresAt: Date | null;
}

export interface AnnouncementsAdminPage {
  announcements: Announcement[];
  total: number;
}
