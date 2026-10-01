import crypto from "node:crypto";
import { eq, and, desc, count, lt, or, sql } from "drizzle-orm";
import { db } from "../../config/database.js";
import { webhooks, webhookAttempts } from "../../database/schema.js";
import { NotFoundError } from "../../utils/errors.js";
import { logger } from "../../utils/logger.js";
import { auditLog } from "../../audit/index.js";
import { decodeCursor, encodeCursor } from "../../utils/cursor-pagination.js";
import type {
  CreateWebhookBody,
  UpdateWebhookBody,
  WebhookResponse,
  WebhookAttemptResponse,
  WebhookStats,
} from "./webhook.types.js";
import type { Webhook, WebhookAttempt } from "../../database/schema.js";

export class WebhookService {
  /**
   * Create a new webhook.
   * Generates a random secret for HMAC signing.
   */
  async createWebhook(body: CreateWebhookBody): Promise<WebhookResponse> {
    // Generate a random 32-byte secret (256-bit)
    const secret = crypto.randomBytes(32).toString("hex");

    const [webhook] = await db
      .insert(webhooks)
      .values({
        url: body.url,
        events: body.events,
        secret,
        active: true,
      })
      .returning();

    auditLog("webhook.created", {
      webhookId: webhook.id,
      url: webhook.url,
      events: webhook.events as unknown as string[],
    });

    logger.info(
      { webhookId: webhook.id, url: webhook.url },
      "Webhook created"
    );

    return this.toResponse(webhook);
  }

  /**
   * Update an existing webhook.
   */
  async updateWebhook(webhookId: string, body: UpdateWebhookBody): Promise<WebhookResponse> {
    const [existing] = await db
      .select()
      .from(webhooks)
      .where(eq(webhooks.id, webhookId));

    if (!existing) {
      throw new NotFoundError("Webhook");
    }

    const updates: Partial<Webhook> = {
      updatedAt: new Date(),
    };

    if (body.url !== undefined) updates.url = body.url;
    if (body.events !== undefined) updates.events = body.events;
    if (body.active !== undefined) updates.active = body.active;

    const [updated] = await db
      .update(webhooks)
      .set(updates)
      .where(eq(webhooks.id, webhookId))
      .returning();

    auditLog("webhook.updated", {
      webhookId: updated.id,
      changes: Object.keys(body),
    });

    logger.info(
      { webhookId: updated.id, changes: Object.keys(body) },
      "Webhook updated"
    );

    return this.toResponse(updated);
  }

  /**
   * Delete a webhook.
   */
  async deleteWebhook(webhookId: string): Promise<void> {
    const [existing] = await db
      .select()
      .from(webhooks)
      .where(eq(webhooks.id, webhookId));

    if (!existing) {
      throw new NotFoundError("Webhook");
    }

    await db.delete(webhooks).where(eq(webhooks.id, webhookId));

    auditLog("webhook.deleted", {
      webhookId,
      url: existing.url,
    });

    logger.info({ webhookId }, "Webhook deleted");
  }

  /**
   * Get a single webhook by ID.
   */
  async getWebhook(webhookId: string): Promise<WebhookResponse> {
    const [webhook] = await db
      .select()
      .from(webhooks)
      .where(eq(webhooks.id, webhookId));

    if (!webhook) {
      throw new NotFoundError("Webhook");
    }

    return this.toResponse(webhook);
  }

  /**
   * List all webhooks (paginated).
   */
  async listWebhooks(
    page: number,
    limit: number
  ): Promise<{ webhooks: WebhookResponse[]; total: number }> {
    const offset = (page - 1) * limit;

    const totalResult = await db
      .select({ count: count() })
      .from(webhooks);

    const rows = await db
      .select()
      .from(webhooks)
      .orderBy(desc(webhooks.createdAt))
      .limit(limit)
      .offset(offset);

    return {
      webhooks: rows.map((w) => this.toResponse(w)),
      total: totalResult[0]?.count ?? 0,
    };
  }

  /**
   * Get attempts for a webhook (paginated).
   */
  /**
   * Accepts either `page` (backward-compatible, O(offset)) or `cursor`
   * (#482, O(1) regardless of how deep the client has paged) — `cursor`
   * wins if both are present. See cursor-pagination.ts for why the cursor
   * encodes (createdAt, id) rather than id alone.
   */
  async getWebhookAttempts(
    webhookId: string,
    page: number,
    limit: number,
    cursorParam?: string,
  ): Promise<{ attempts: WebhookAttemptResponse[]; total: number; nextCursor: string | null }> {
    // Verify webhook exists
    const [webhook] = await db
      .select()
      .from(webhooks)
      .where(eq(webhooks.id, webhookId));

    if (!webhook) {
      throw new NotFoundError("Webhook");
    }

    const cursor = cursorParam ? decodeCursor(cursorParam) : null;
    const offset = cursor ? 0 : (page - 1) * limit;

    const where = cursor
      ? and(
          eq(webhookAttempts.webhookId, webhookId),
          or(
            lt(webhookAttempts.createdAt, cursor.createdAt),
            and(eq(webhookAttempts.createdAt, cursor.createdAt), lt(webhookAttempts.id, cursor.id)),
          ),
        )
      : eq(webhookAttempts.webhookId, webhookId);

    const totalResult = await db
      .select({ count: count() })
      .from(webhookAttempts)
      .where(eq(webhookAttempts.webhookId, webhookId));

    const rows = await db
      .select()
      .from(webhookAttempts)
      .where(where)
      .orderBy(desc(webhookAttempts.createdAt), desc(webhookAttempts.id))
      .limit(limit + 1)
      .offset(offset);

    const hasMore = rows.length > limit;
    const pageRows = hasMore ? rows.slice(0, limit) : rows;
    const lastRow = pageRows[pageRows.length - 1];

    return {
      attempts: pageRows.map((a) => this.toAttemptResponse(a)),
      total: totalResult[0]?.count ?? 0,
      nextCursor: hasMore && lastRow ? encodeCursor(lastRow) : null,
    };
  }

  /**
   * Rotate the webhook secret (for security).
   */
  async rotateSecret(webhookId: string): Promise<{ secret: string }> {
    const [webhook] = await db
      .select()
      .from(webhooks)
      .where(eq(webhooks.id, webhookId));

    if (!webhook) {
      throw new NotFoundError("Webhook");
    }

    const newSecret = crypto.randomBytes(32).toString("hex");

    await db
      .update(webhooks)
      .set({ secret: newSecret, updatedAt: new Date() })
      .where(eq(webhooks.id, webhookId));

    auditLog("webhook.secret_rotated", {
      webhookId,
    });

    logger.info({ webhookId }, "Webhook secret rotated");

    return { secret: newSecret };
  }

  /**
   * Get webhook statistics (success/failure counts, etc.).
   */
  async getWebhookStats(webhookId: string): Promise<WebhookStats> {
    const [webhook] = await db
      .select()
      .from(webhooks)
      .where(eq(webhooks.id, webhookId));

    if (!webhook) {
      throw new NotFoundError("Webhook");
    }

    const statsResult = await db
      .select({
        total: count(),
        succeeded: count(sql.raw("CASE WHEN succeeded_at IS NOT NULL THEN 1 END")),
        failed: count(sql.raw("CASE WHEN failed_at IS NOT NULL THEN 1 END")),
        pending: count(
          sql.raw("CASE WHEN succeeded_at IS NULL AND failed_at IS NULL THEN 1 END")
        ),
      })
      .from(webhookAttempts)
      .where(eq(webhookAttempts.webhookId, webhookId));

    const stats = statsResult[0];

    return {
      webhookId,
      totalAttempts: stats?.total ?? 0,
      succeeded: stats?.succeeded ?? 0,
      failed: stats?.failed ?? 0,
      pending: stats?.pending ?? 0,
      successRate: (stats?.total ?? 0) > 0
        ? Math.round(((stats?.succeeded ?? 0) / (stats?.total ?? 1)) * 100)
        : 0,
    };
  }

  private toResponse(webhook: Webhook): WebhookResponse {
    return {
      id: webhook.id,
      url: webhook.url,
      events: webhook.events ?? [],
      active: webhook.active,
      createdAt: webhook.createdAt,
      updatedAt: webhook.updatedAt,
    };
  }

  private toAttemptResponse(attempt: WebhookAttempt): WebhookAttemptResponse {
    return {
      id: attempt.id,
      webhookId: attempt.webhookId,
      event: attempt.event,
      statusCode: attempt.statusCode,
      errorMessage: attempt.errorMessage,
      succeededAt: attempt.succeededAt,
      failedAt: attempt.failedAt,
      retryCount: attempt.retryCount,
      createdAt: attempt.createdAt,
    };
  }
}

export const webhookService = new WebhookService();
