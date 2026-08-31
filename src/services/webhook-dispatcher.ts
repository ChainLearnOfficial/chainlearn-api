import crypto from "node:crypto";
import { eq } from "drizzle-orm";
import { db } from "../config/database.js";
import { webhooks, webhookAttempts } from "../database/schema.js";
import { logger } from "../utils/logger.js";
import type { WebhookPayload, WebhookEventType } from "../modules/admin/webhook.types.js";

const MAX_RETRIES = 5;
const INITIAL_RETRY_DELAY_MS = 60_000; // 1 minute
const MAX_RETRY_DELAY_MS = 24 * 60 * 60 * 1_000; // 24 hours

/**
 * Calculate exponential backoff delay with jitter.
 * Formula: min(INITIAL_DELAY * 2^retryCount, MAX_DELAY) * (0.8 + random 0-0.4)
 */
function getNextRetryDelay(retryCount: number): number {
  const exponential = Math.min(
    INITIAL_RETRY_DELAY_MS * Math.pow(2, retryCount),
    MAX_RETRY_DELAY_MS
  );
  const jitter = 0.8 + Math.random() * 0.4;
  return Math.floor(exponential * jitter);
}

/**
 * Create HMAC-SHA256 signature for webhook payload.
 * Format: "t={timestamp},v1={signature}"
 * Signature is HMAC-SHA256(secret, "{timestamp}.{json_payload}")
 */
function createSignature(
  payload: WebhookPayload,
  secret: string
): { timestamp: string; signature: string } {
  const timestamp = Math.floor(Date.now() / 1000).toString();
  const message = `${timestamp}.${JSON.stringify(payload)}`;
  const signature = crypto
    .createHmac("sha256", secret)
    .update(message)
    .digest("hex");
  return { timestamp, signature };
}

/**
 * Send a webhook payload to a single webhook URL.
 * Returns true if successful, false if should be retried.
 */
async function sendWebhook(
  webhookId: string,
  url: string,
  payload: WebhookPayload,
  secret: string
): Promise<{ success: boolean; statusCode?: number; error?: string }> {
  const { timestamp, signature } = createSignature(payload, secret);
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 30_000); // 30 second timeout

  try {
    const response = await fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Webhook-Signature": `t=${timestamp},v1=${signature}`,
        "X-Webhook-ID": webhookId,
        "X-Webhook-Event": payload.event,
      },
      body: JSON.stringify(payload),
      signal: controller.signal,
    });

    const responseBody = await response.text();

    if (response.ok) {
      logger.info(
        { webhookId, url, event: payload.event, statusCode: response.status },
        "Webhook delivered successfully"
      );
      return { success: true, statusCode: response.status };
    }

    // 4xx errors (except 429) are not retried — client error, not server error
    if (response.status >= 400 && response.status < 500 && response.status !== 429) {
      logger.warn(
        { webhookId, url, event: payload.event, statusCode: response.status },
        "Webhook delivery failed with client error — will not retry"
      );
      return {
        success: false,
        statusCode: response.status,
        error: `Client error (${response.status}): ${responseBody.substring(0, 200)}`,
      };
    }

    // 5xx and 429 (rate limit) are retryable
    logger.warn(
      { webhookId, url, event: payload.event, statusCode: response.status },
      "Webhook delivery failed with server error — will retry"
    );
    return {
      success: false,
      statusCode: response.status,
      error: `Server error (${response.status}): ${responseBody.substring(0, 200)}`,
    };
  } catch (err) {
    const errorMsg =
      err instanceof Error && err.name === "AbortError"
        ? "Request timeout (30s)"
        : err instanceof Error
          ? err.message
          : "Unknown error";

    logger.error(
      { webhookId, url, event: payload.event, error: errorMsg },
      "Webhook delivery error"
    );

    return {
      success: false,
      error: errorMsg,
    };
  } finally {
    clearTimeout(timeout);
  }
}

/**
 * Dispatch a webhook event to all active webhooks listening for that event.
 * Records the attempt and schedules retries on failure.
 */
export async function dispatchWebhook(
  payload: WebhookPayload
): Promise<void> {
  // Find all active webhooks listening for this event
  const activeWebhooks = await db
    .select()
    .from(webhooks)
    .where(eq(webhooks.active, true));

  const listenersForEvent = activeWebhooks.filter((w) =>
    (w.events as string[]).includes(payload.event)
  );

  if (listenersForEvent.length === 0) {
    logger.debug(
      { event: payload.event },
      "No webhooks listening for this event"
    );
    return;
  }

  // Attempt to send to each webhook
  for (const webhook of listenersForEvent) {
    const result = await sendWebhook(webhook.id, webhook.url, payload, webhook.secret);

    // Record the attempt
    const [attempt] = await db
      .insert(webhookAttempts)
      .values({
        webhookId: webhook.id,
        event: payload.event,
        payload: payload as any,
        statusCode: result.statusCode ?? null,
        errorMessage: result.error ?? null,
        succeededAt: result.success ? new Date() : null,
      })
      .returning();

    // If failed, schedule retry
    if (!result.success) {
      await scheduleRetry(attempt.id, webhook.id);
    }
  }
}

/**
 * Schedule a retry for a failed webhook attempt.
 * Uses exponential backoff with jitter.
 */
async function scheduleRetry(attemptId: string, webhookId: string): Promise<void> {
  const [attempt] = await db
    .select()
    .from(webhookAttempts)
    .where(eq(webhookAttempts.id, attemptId));

  if (!attempt) return;

  const nextRetryCount = (attempt.retryCount ?? 0) + 1;

  if (nextRetryCount > MAX_RETRIES) {
    // Max retries exceeded
    await db
      .update(webhookAttempts)
      .set({
        failedAt: new Date(),
        retryCount: nextRetryCount,
      })
      .where(eq(webhookAttempts.id, attemptId));

    logger.error(
      { webhookId, event: attempt.event, attemptId, retryCount: nextRetryCount },
      "Webhook delivery failed after max retries"
    );
    return;
  }

  // Schedule next retry
  const nextRetryAt = new Date(Date.now() + getNextRetryDelay(nextRetryCount - 1));

  await db
    .update(webhookAttempts)
    .set({
      nextRetryAt,
      retryCount: nextRetryCount,
    })
    .where(eq(webhookAttempts.id, attemptId));

  logger.info(
    { webhookId, event: attempt.event, attemptId, retryCount: nextRetryCount, nextRetryAt },
    "Scheduled webhook retry"
  );
}

/**
 * Retry failed webhook attempts whose next retry time has passed.
 * Called by background job (e.g., every 5 minutes).
 */
export async function processWebhookRetries(): Promise<void> {
  const now = new Date();

  // Find all failed attempts whose retry time has passed
  const readyForRetry = await db
    .select()
    .from(webhookAttempts)
    .where(
      (col: any) =>
        col("next_retry_at") &&
        col("next_retry_at") <= now &&
        !col("succeeded_at") &&
        !col("failed_at")
    );

  if (readyForRetry.length === 0) return;

  logger.info(
    { count: readyForRetry.length },
    "Processing webhook retries"
  );

  for (const attempt of readyForRetry) {
    // Fetch the webhook to get its details
    const [webhook] = await db
      .select()
      .from(webhooks)
      .where(eq(webhooks.id, attempt.webhookId));

    if (!webhook || !webhook.active) {
      // Webhook deleted or disabled
      await db
        .update(webhookAttempts)
        .set({ failedAt: new Date() })
        .where(eq(webhookAttempts.id, attempt.id));
      continue;
    }

    const payload = attempt.payload as WebhookPayload;
    const result = await sendWebhook(
      webhook.id,
      webhook.url,
      payload,
      webhook.secret
    );

    if (result.success) {
      // Mark as succeeded
      await db
        .update(webhookAttempts)
        .set({
          succeededAt: new Date(),
          statusCode: result.statusCode ?? null,
        })
        .where(eq(webhookAttempts.id, attempt.id));

      logger.info(
        { webhookId: webhook.id, event: attempt.event, attemptId: attempt.id },
        "Webhook retry succeeded"
      );
    } else {
      // Schedule another retry
      await scheduleRetry(attempt.id, webhook.id);
    }
  }
}
