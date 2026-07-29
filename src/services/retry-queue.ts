import crypto from "node:crypto";
import { redis } from "../config/redis.js";
import { db } from "../config/database.js";
import { quizSubmissions } from "../database/schema.js";
import { eq } from "drizzle-orm";
import { logger } from "../utils/logger.js";

const QUEUE_KEY = "chainlearn:retry:rewards";
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
  return raw.map((entry) => JSON.parse(entry) as RetryJob);
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
      .set({ rewardFailed: true, rewardClaimed: true })
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
