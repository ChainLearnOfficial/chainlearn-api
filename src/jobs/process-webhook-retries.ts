import { Job } from 'bullmq';
import { logger } from '../utils/logger';
import { metrics } from '../utils/metrics';
import { WebhookAttemptRepository } from '../repositories/webhook-attempt';
import { WebhookDispatcher } from '../services/webhook-dispatcher';

interface WebhookAttempt {
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

const MAX_RETRY_ATTEMPTS = 5;
const BASE_DELAY_MS = 1000;
const MAX_DELAY_MS = 3600000;
const JITTER_FACTOR = 0.1;

export const webhookRetryQueue = new Queue('webhookRetries', {
    connection: redisConnection,
    defaultJobOptions: {
        attempts: MAX_RETRY_ATTEMPTS,
        backoff: {
            type: 'exponential',
            delay: BASE_DELAY_MS
        }
    }
});

function isTransientFailure(statusCode: number | null, error: string | null): boolean {
    if (!statusCode) return true;
    return statusCode >= 500 || statusCode === 429 || statusCode === 408;
}

function calculateNextRetry(retryCount: number): Date {
    const delay = Math.min(BASE_DELAY_MS * Math.pow(2, retryCount), MAX_DELAY_MS);
    const jitter = delay * JITTER_FACTOR * (Math.random() * 2 - 1);
    return new Date(Date.now() + delay + jitter);
}

async function processWebhookAttempt(job: Job): Promise<void> {
    const attempt = job.data as WebhookAttempt;
    
    try {
        logger.info(`Processing webhook retry attempt ${attempt.id} for webhook ${attempt.webhookId}`);
        
        const result = await WebhookDispatcher.dispatch(
            attempt.webhookId,
            attempt.event,
            attempt.payload
        );
        
        if (result.success) {
            await WebhookAttemptRepository.markSucceeded(attempt.id, new Date());
            metrics.increment('webhook.success');
            logger.info(`Webhook ${attempt.webhookId} succeeded on attempt ${attempt.retryCount + 1}`);
            return;
        }
        
        const isTransient = isTransientFailure(result.statusCode, result.error);
        
        if (!isTransient || attempt.retryCount >= MAX_RETRY_ATTEMPTS) {
            await WebhookAttemptRepository.markFailed(attempt.id, new Date(), result.error);
            metrics.increment('webhook.failed', { type: isTransient ? 'transient' : 'permanent' });
            logger.warn(`Webhook ${attempt.webhookId} failed permanently after ${attempt.retryCount + 1} attempts`);
            return;
        }
        
        const nextRetryAt = calculateNextRetry(attempt.retryCount);
        await WebhookAttemptRepository.updateRetry(attempt.id, attempt.retryCount + 1, nextRetryAt);
        
        await job.moveToDelayed(Date.now() - Date.now() + (nextRetryAt.getTime() - Date.now()));
        metrics.increment('webhook.retry');
        logger.info(`Scheduled retry for webhook ${attempt.webhookId} at ${nextRetryAt.toISOString()}`);
        
    } catch (error) {
        logger.error(`Error processing webhook attempt ${attempt.id}: ${error}`);
        metrics.increment('webhook.error');
        
        if (attempt.retryCount >= MAX_RETRY_ATTEMPTS) {
            await WebhookAttemptRepository.markFailed(attempt.id, new Date(), error.message);
            return;
        }
        
        const nextRetryAt = calculateNextRetry(attempt.retryCount);
        await WebhookAttemptRepository.updateRetry(attempt.id, attempt.retryCount + 1, nextRetryAt);
        await job.moveToDelayed(Date.now() - Date.now() + (nextRetryAt.getTime() - Date.now()));
    }
}

export const processWebhookRetries = {
    handler: processWebhookAttempt,
    concurrency: 5
};
