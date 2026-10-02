import { logger } from "../utils/logger.js";
import { redis } from "../config/redis.js";

const QUEUE_KEY = "chainlearn:retry:webhooks";
const MAX_RETRIES = 5;
const BASE_DELAY_MS = 1000;
const MAX_DELAY_MS = 3600000;

export interface WebhookAttempt {
  id: string;
  webhookId: string;
  event: string;
  payload: unknown;
  statusCode: number | null;
  errorMessage: string | null;
  retryCount: number;
  nextRetryAt: string | null;
  succeededAt: string | null;
  failedAt: string | null;
}

function isTransientFailure(statusCode: number | null, error: string | null): boolean {
  if (!statusCode) return true;
  return statusCode >= 500 || statusCode === 429;
}

function calculateNextRetry(retryCount: number): Date {
  const delay = Math.min(BASE_DELAY_MS * Math.pow(2, retryCount), MAX_DELAY_MS);
  const jitter = delay * (0.5 + Math.random() * 0.5);
  return new Date(Date.now() + jitter);
}

export async function enqueueWebhookRetry(attempt: WebhookAttempt): Promise<void> {
  await redis.lpush(QUEUE_KEY, JSON.stringify(attempt));
  logger.info({ webhookId: attempt.webhookId, event: attempt.event }, "Webhook retry enqueued");
}

export async function dequeueWebhookRetry(): Promise<WebhookAttempt | null> {
  const raw = await redis.rpop(QUEUE_KEY);
  if (!raw) return null;
  return JSON.parse(raw) as WebhookAttempt;
}

export function shouldRetry(attempt: WebhookAttempt): boolean {
  if (attempt.retryCount >= MAX_RETRIES) return false;
  if (!isTransientFailure(attempt.statusCode, attempt.errorMessage)) return false;
  return true;
}

export function markForRetry(attempt: WebhookAttempt): WebhookAttempt {
  const nextRetry = calculateNextRetry(attempt.retryCount);
  return {
    ...attempt,
    retryCount: attempt.retryCount + 1,
    nextRetryAt: nextRetry.toISOString(),
  };
}

export function markAsFailed(attempt: WebhookAttempt): WebhookAttempt {
  return {
    ...attempt,
    failedAt: new Date().toISOString(),
  };
}

let processorRunning = false;
let processorTimer: ReturnType<typeof setTimeout> | null = null;

export async function startWebhookRetryProcessor(
  processFn: (attempt: WebhookAttempt) => Promise<boolean>
): Promise<void> {
  if (processorRunning) return;
  processorRunning = true;

  const tick = async () => {
    if (!processorRunning) return;
    try {
      const attempt = await dequeueWebhookRetry();
      if (attempt) {
        if (!shouldRetry(attempt)) {
          const failed = markAsFailed(attempt);
          logger.warn(
            { webhookId: failed.webhookId, retryCount: failed.retryCount },
            "Webhook permanently failed"
          );
          return;
        }

        const success = await processFn(attempt);
        if (!success) {
          const retried = markForRetry(attempt);
          await enqueueWebhookRetry(retried);
        }
      }
    } catch (err) {
      logger.error({ err }, "Webhook retry processor tick failed");
    }
    if (processorRunning) {
      processorTimer = setTimeout(tick, 30000);
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
