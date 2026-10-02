import { z } from "zod";
import { validateWebhookUrl } from "../../utils/ssrf-guard.js";

// ─── Webhook Event Types ────────────────────────────────────────────────────

export type WebhookEventType =
  | "enrollment.created"
  | "quiz.submitted"
  | "quiz.passed"
  | "quiz.failed"
  | "reward.claimed"
  | "reward.queued"
  | "credential.minted"
  | "course.created"
  | "course.updated"
  | "course.deleted";

export interface WebhookPayload {
  id: string; // Unique event ID for idempotency
  event: WebhookEventType;
  timestamp: Date;
  data: Record<string, unknown>;
}

export interface WebhookSignature {
  timestamp: string;
  signature: string; // HMAC-SHA256 hex
}

// ─── Request Schemas ────────────────────────────────────────────────────────

// Rejects loopback/private/link-local/cloud-metadata hosts so a webhook
// can't be used to make the server request its own internal network (#487).
// See src/utils/ssrf-guard.ts for exactly what's blocked and why.
const webhookUrlSchema = z
  .string()
  .url("Invalid URL")
  .superRefine((url, ctx) => {
    const result = validateWebhookUrl(url);
    if (!result.valid) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: `Webhook URL rejected: ${result.reason}`,
      });
    }
  });

export const createWebhookSchema = z.object({
  url: webhookUrlSchema,
  events: z.array(z.string()).min(1, "At least one event is required"),
});

export const updateWebhookSchema = z.object({
  url: webhookUrlSchema.optional(),
  events: z.array(z.string()).min(1).optional(),
  active: z.boolean().optional(),
});

export const listWebhooksSchema = z.object({
  page: z.coerce.number().int().min(1).default(1),
  limit: z.coerce.number().int().min(1).max(50).default(20),
});

// ─── Types ──────────────────────────────────────────────────────────────────

export type CreateWebhookBody = z.infer<typeof createWebhookSchema>;
export type UpdateWebhookBody = z.infer<typeof updateWebhookSchema>;
export type ListWebhooksQuery = z.infer<typeof listWebhooksSchema>;

export interface WebhookResponse {
  id: string;
  url: string;
  events: string[];
  active: boolean;
  createdAt: Date;
  updatedAt: Date;
}

export interface WebhookAttemptResponse {
  id: string;
  webhookId: string;
  event: string;
  statusCode: number | null;
  errorMessage: string | null;
  succeededAt: Date | null;
  failedAt: Date | null;
  retryCount: number;
  createdAt: Date;
}

export interface WebhookStats {
  webhookId: string;
  totalAttempts: number;
  succeeded: number;
  failed: number;
  pending: number;
  successRate: number;
}
