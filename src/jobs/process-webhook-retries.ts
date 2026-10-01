import { redis } from "../config/redis.js";
import { logger } from "../utils/logger.js";

const WEBHOOK_RETRY_QUEUE = "chainlearn:retry:webhooks";
const MAX_RETRIES = 5;
const BASE_DELAY_MS = 1_000;
const MAX_DELAY_MS = 3_600_000;

export interface WebhookAttempt {
  id: string;
  webhookId: string;
  event: string;
  payload: unknown;
  statusCode: number | null;
  errorMessage: string | null;
  retryCount: number;
  nextRetryAt: Date | null;
  succeededAt: Date | null;
  failedAt: Date | null;
}

export function isTransientFailure(statusCode: number | null, _error: string | null): boolean {
  if (!statusCode) return true;
  return statusCode >= 500 || statusCode === 429;
}

export function calculateNextRetry(retryCount: number): Date {
  const delay = Math.min(BASE_DELAY_MS * Math.pow(2, retryCount), MAX_DELAY_MS);
  const jitter = Math.random() * delay * 0.1;
  return new Date(Date.now() + delay + jitter);
}

async function deliverWebhook(attempt: WebhookAttempt): Promise<{ statusCode: number; success: boolean }> {
  const { webhookId, payload } = attempt;
  const webhookUrl = await redis.get(`chainlearn:webhook:url:${webhookId}`);

  if (!webhookUrl) {
    logger.warn({ webhookId }, "Webhook URL not found, skipping delivery");
    return { statusCode: 0, success: false };
  }

  try {
    const response = await fetch(webhookUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(30_000),
    });

    return { statusCode: response.status, success: response.ok };
  } catch (err: unknown) {
    logger.error({ err, webhookId }, "Webhook delivery network error");
    return { statusCode: 0, success: false };
  }
}

export async function processWebhookRetryQueue(): Promise<void> {
  const raw = await redis.rpop(WEBHOOK_RETRY_QUEUE);
  if (!raw) return;

  let attempt: WebhookAttempt;
  try {
    attempt = JSON.parse(raw) as WebhookAttempt;
  } catch {
    logger.error({ raw }, "Invalid webhook retry payload, discarding");
    return;
  }

  const { id, webhookId, event, retryCount } = attempt;

  if (retryCount >= MAX_RETRIES) {
    logger.error(
      { id, webhookId, event, retryCount },
      "Webhook max retries exceeded, marking as permanently failed"
    );
    attempt.failedAt = new Date();
    await redis.set(
      `chainlearn:webhook:failed:${id}`,
      JSON.stringify(attempt),
      "EX",
      86400
    );
    return;
  }

  const result = await deliverWebhook(attempt);

  if (result.success) {
    attempt.succeededAt = new Date();
    logger.info({ id, webhookId, event, retryCount }, "Webhook delivered successfully");
    return;
  }

  if (!isTransientFailure(result.statusCode, attempt.errorMessage)) {
    logger.error(
      { id, webhookId, event, statusCode: result.statusCode },
      "Webhook permanent failure, not retrying"
    );
    attempt.failedAt = new Date();
    await redis.set(
      `chainlearn:webhook:failed:${id}`,
      JSON.stringify(attempt),
      "EX",
      86400
    );
    return;
  }

  const nextRetry = calculateNextRetry(retryCount);
  attempt.retryCount = retryCount + 1;
  attempt.nextRetryAt = nextRetry;
  attempt.statusCode = result.statusCode;

  logger.warn(
    { id, webhookId, event, retryCount: attempt.retryCount, nextRetryAt: nextRetry },
    "Webhook delivery failed, scheduling retry"
  );

  await redis.lpush(WEBHOOK_RETRY_QUEUE, JSON.stringify(attempt));
}

let processorRunning = false;
let processorTimer: ReturnType<typeof setTimeout> | null = null;

export function startWebhookRetryProcessor(): void {
  if (processorRunning) return;
  processorRunning = true;

  const tick = async () => {
    if (!processorRunning) return;
    try {
      await processWebhookRetryQueue();
    } catch (err) {
      logger.error({ err }, "Webhook retry processor tick failed");
    }
    if (processorRunning) {
      processorTimer = setTimeout(tick, 5_000);
    }
  };

  tick();
  logger.info("Webhook retry processor started");
}

export function stopWebhookRetryProcessor(): void {
  processorRunning = false;
  if (processorTimer) {
    clearTimeout(processorTimer);
    processorTimer = null;
  }
  logger.info("Webhook retry processor stopped");
}