import { z } from "zod";

// ─── Request Schemas ────────────────────────────────────────────────────────

export const joinWaitlistSchema = z.object({
  courseId: z.string().uuid("Invalid course ID"),
});

export const leaveWaitlistSchema = z.object({
  courseId: z.string().uuid("Invalid course ID"),
});

// ─── Types ──────────────────────────────────────────────────────────────────

export type JoinWaitlistBody = z.infer<typeof joinWaitlistSchema>;
export type LeaveWaitlistBody = z.infer<typeof leaveWaitlistSchema>;

export interface WaitlistEntry {
  position: number;
  userId: string;
  displayName: string;
}

export interface WaitlistStatus {
  isOnWaitlist: boolean;
  position?: number;
  totalOnWaitlist: number;
}

export interface JoinWaitlistResult {
  success: boolean;
  position: number;
  message: string;
}

export interface LeaveWaitlistResult {
  success: boolean;
  message: string;
}
