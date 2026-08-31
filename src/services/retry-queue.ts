import crypto from "node:crypto";
import { redis } from "../config/redis.js";
import { db } from "../config/database.js";
import { quizSubmissions } from "../database/schema.js";
import { eq, and, lte } from "drizzle-orm";
import { logger } from "../utils/logger.js";

const QUEUE_KEY = "chainlearn:retry:rewards";
const DEAD_LETTER_QUEUE_KEY = "chainlearn:retry:rewards:dead-letter";
const MAX_RETRIES = 10;
const BASE_RETRY_DELAY_MS = 30_000;
const MAX_RETRY_DELAY_MS = 5 * 60_000;
// How many jobs a single tick will pull and process concurrently, so a
// pile-up of failed rewards drains in batches instead of one job per tick.
const BATCH_SIZE = 10;
const POLL_INTERVAL_MS = 5_000;

export interface RetryJob {
  id: string;
  submissionId: string;
  userId: string;
  retryCount: number;
  createdAt: string;
}

// Atomically pulls every job whose scheduled time has passed (score <= now),
// up to `limit`, and removes them from the sorted set in the same call so
// two processor instances can never claim the same job.
const DEQUEUE_READY_BATCH_SCRIPT = `
  local jobs = redis.call('ZRANGEBYSCORE', KEYS[1], '-inf', ARGV[1], 'LIMIT', 0, ARGV[2])
  if #jobs > 0 then
    redis.call('ZREM', KEYS[1], unpack(jobs))
  end
  return jobs
`;

export async function enqueueReward(job: Omit<RetryJob, "id" | "retryCount" | "createdAt">): Promise<void> {
  const payload: RetryJob = {
    ...job,
    id: crypto.randomUUID(),
    retryCount: 0,
    createdAt: new Date().toISOString(),
  };
  await redis.zadd(QUEUE_KEY, Date.now(), JSON.stringify(payload));
  logger.info({ submissionId: job.submissionId }, "Reward queued for later processing");
}

export async function dequeueReadyBatch(limit: number = BATCH_SIZE): Promise<RetryJob[]> {
  const raw = (await redis.eval(
    DEQUEUE_READY_BATCH_SCRIPT,
    1,
    QUEUE_KEY,
    Date.now(),
    limit
  )) as string[];
  
  const jobs: RetryJob[] = [];
  
  for (const entry of raw) {
    try {
      const job = JSON.parse(entry) as RetryJob;
      jobs.push(job);
    } catch (err) {
      // Job was already removed from the main queue by the atomic script.
      // Log the error and push to dead-letter queue for manual recovery.
      logger.error(
        { err, rawEntry: entry.substring(0, 200) },
        "Failed to parse retry job JSON — moving to dead-letter queue"
      );
      
      try {
        await redis.lpush(DEAD_LETTER_QUEUE_KEY, entry);
      } catch (dlqErr) {
        // If we can't even write to DLQ, log and continue - better to process
        // other valid jobs than crash the entire batch.
        logger.error(
          { err: dlqErr, rawEntry: entry.substring(0, 200) },
          "Failed to write malformed job to dead-letter queue"
        );
      }
    }
  }
  
  return jobs;
}

// Exponential backoff, capped so a job is always retried well within the
// MAX_RETRIES budget instead of only for the first few minutes.
function backoffDelayMs(retryCount: number): number {
  return Math.min(BASE_RETRY_DELAY_MS * 2 ** retryCount, MAX_RETRY_DELAY_MS);
}

export async function requeueReward(job: RetryJob): Promise<void> {
  if (job.retryCount >= MAX_RETRIES) {
    logger.error(
      { submissionId: job.submissionId, retryCount: job.retryCount },
      "Reward retry limit exceeded — marking as failed"
    );
    await db
      .update(quizSubmissions)
      .set({ rewardFailed: true, rewardClaimed: false })
      .where(eq(quizSubmissions.id, job.submissionId));
    return;
  }
  const updated: RetryJob = { ...job, retryCount: job.retryCount + 1 };
  const readyAt = Date.now() + backoffDelayMs(job.retryCount);
  await redis.zadd(QUEUE_KEY, readyAt, JSON.stringify(updated));
}

let processorRunning = false;
let processorTimer: ReturnType<typeof setTimeout> | null = null;
let processorGeneration = 0;

export async function startRetryProcessor(
  processFn: (job: RetryJob) => Promise<boolean>
): Promise<void> {
  if (processorRunning) return;
  processorRunning = true;
  const generation = ++processorGeneration;

  const tick = async () => {
    if (generation !== processorGeneration) return;
    let batchWasFull = false;
    try {
      const jobs = await dequeueReadyBatch(BATCH_SIZE);
      batchWasFull = jobs.length === BATCH_SIZE;

      await Promise.allSettled(
        jobs.map(async (job) => {
          try {
            const success = await processFn(job);
            if (!success) {
              await requeueReward(job);
            }
          } catch (err) {
            logger.error(
              { err, submissionId: job.submissionId },
              "Retry job processing threw an error"
            );
            await requeueReward(job);
          }
        })
      );
    } catch (err) {
      logger.error({ err }, "Retry processor tick failed");
    }
    if (generation === processorGeneration) {
      // Drain immediately while a batch is full (likely more ready jobs
      // waiting); otherwise fall back to normal polling.
      processorTimer = setTimeout(tick, batchWasFull ? 0 : POLL_INTERVAL_MS);
    }
  };

  await tick();
  logger.info("Retry processor started");
}

export function stopRetryProcessor(): void {
  processorRunning = false;
  processorGeneration++;
  if (processorTimer) {
    clearTimeout(processorTimer);
    processorTimer = null;
  }
  logger.info("Retry processor stopped");
}

// How old a submission must be before we consider it "lost" and re-enqueue it.
// In-flight submissions (still within this window) are not re-enqueued so we
// don't double-process a claim that is legitimately in progress (#208).
const LOST_JOB_AGE_MINUTES = 15;

/**
 * Re-enqueue reward claims that are in the database but absent from Redis.
 *
 * After a Redis restart the sorted-set queue is empty but the database still
 * has unclaimed submissions (rewardClaimed=false, rewardFailed=false,
 * rewardPending=false) whose original enqueue time has long passed.  This
 * function finds those rows and pushes them back onto the queue so the retry
 * processor can attempt them again.
 *
 * Call this on startup and optionally on a periodic schedule.
 */
export async function recoverLostJobs(): Promise<void> {
  try {
    const cutoff = new Date(Date.now() - LOST_JOB_AGE_MINUTES * 60 * 1_000);

    const lost = await db
      .select({
        id: quizSubmissions.id,
        userId: quizSubmissions.userId,
        score: quizSubmissions.score,
      })
      .from(quizSubmissions)
      .where(
        and(
          eq(quizSubmissions.rewardClaimed, false),
          eq(quizSubmissions.rewardFailed, false),
          eq(quizSubmissions.rewardPending, false),
          lte(quizSubmissions.submittedAt, cutoff)
        )
      )
      .limit(100);

    if (lost.length === 0) return;

    for (const row of lost) {
      if (row.score === null) continue;
      await enqueueReward({
        submissionId: row.id,
        userId: row.userId,
      });
    }

    logger.info({ count: lost.length }, "recoverLostJobs: re-enqueued lost reward claims after Redis restart");
  } catch (err) {
    logger.error({ err }, "recoverLostJobs failed");
  }
}

export interface QueuedRewardJob extends RetryJob {
  /** Zero-based position in the queue, ordered by scheduled ready time. */
  position: number;
  /** Epoch ms at which the retry processor will next consider this job. */
  readyAt: number;
}

/**
 * Snapshot of the reward retry queue (#327), ordered by scheduled ready
 * time. Used to show users where a queued reward claim sits and roughly
 * when it will be processed. Malformed entries are skipped rather than
 * throwing — this is a read-only introspection path.
 */
export async function getQueuedRewardJobs(): Promise<QueuedRewardJob[]> {
  const raw = await redis.zrange(QUEUE_KEY, 0, -1, "WITHSCORES");
  const jobs: QueuedRewardJob[] = [];
  for (let i = 0; i < raw.length; i += 2) {
    try {
      const job = JSON.parse(raw[i]) as RetryJob;
      jobs.push({
        ...job,
        position: i / 2,
        readyAt: Number(raw[i + 1]),
      });
    } catch {
      // Malformed entry — dequeueReadyBatch handles moving it to the DLQ.
    }
  }
  return jobs;
}

/** Rough seconds until the retry processor reaches a job at `position` whose
 * earliest ready time is `readyAt`. Combines the job's own backoff delay with
 * how many full batches sit ahead of it. */
export function estimateProcessingSeconds(
  position: number,
  readyAt: number,
): number {
  const waitForReady = Math.max(0, readyAt - Date.now());
  const batchesAhead = Math.floor(position / BATCH_SIZE);
  return Math.ceil((waitForReady + batchesAhead * POLL_INTERVAL_MS) / 1_000);
}

/**
 * Get the count and first few entries from the dead-letter queue.
 * Used for monitoring and alerting on malformed jobs.
 */
export async function inspectDeadLetterQueue(limit: number = 10): Promise<{
  count: number;
  entries: string[];
}> {
  const count = await redis.llen(DEAD_LETTER_QUEUE_KEY);
  const entries = await redis.lrange(DEAD_LETTER_QUEUE_KEY, 0, limit - 1);
  return { count, entries };
}
