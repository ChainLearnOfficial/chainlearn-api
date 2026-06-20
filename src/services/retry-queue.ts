import { redis } from "../config/redis.js";
import { db } from "../config/database.js";
import { quizSubmissions } from "../database/schema.js";
import { eq } from "drizzle-orm";
import { logger } from "../utils/logger.js";

const QUEUE_KEY = "chainlearn:retry:rewards";
const MAX_RETRIES = 10;
const RETRY_INTERVAL_MS = 30_000;

export interface RetryJob {
  submissionId: string;
  userId: string;
  score: number;
  retryCount: number;
  createdAt: string;
}

export async function enqueueReward(job: Omit<RetryJob, "retryCount" | "createdAt">): Promise<void> {
  const payload: RetryJob = {
    ...job,
    retryCount: 0,
    createdAt: new Date().toISOString(),
  };
  await redis.lpush(QUEUE_KEY, JSON.stringify(payload));
  logger.info({ submissionId: job.submissionId }, "Reward queued for later processing");
}

export async function dequeueReward(): Promise<RetryJob | null> {
  const raw = await redis.rpop(QUEUE_KEY);
  if (!raw) return null;
  return JSON.parse(raw) as RetryJob;
}

export async function requeueReward(job: RetryJob): Promise<void> {
  if (job.retryCount >= MAX_RETRIES) {
    logger.error(
      { submissionId: job.submissionId, retryCount: job.retryCount },
      "Reward retry limit exceeded — marking as failed"
    );
    await db
      .update(quizSubmissions)
      .set({ rewardFailed: true })
      .where(eq(quizSubmissions.id, job.submissionId));
    return;
  }
  const updated: RetryJob = { ...job, retryCount: job.retryCount + 1 };
  await redis.lpush(QUEUE_KEY, JSON.stringify(updated));
}

export async function getQueueLength(): Promise<number> {
  return redis.llen(QUEUE_KEY);
}

let processorRunning = false;
let processorTimer: ReturnType<typeof setTimeout> | null = null;

export async function startRetryProcessor(
  processFn: (job: RetryJob) => Promise<boolean>
): Promise<void> {
  if (processorRunning) return;
  processorRunning = true;

  const tick = async () => {
    if (!processorRunning) return;
    try {
      const job = await dequeueReward();
      if (job) {
        const success = await processFn(job);
        if (!success) {
          await requeueReward(job);
        }
      }
    } catch (err) {
      logger.error({ err }, "Retry processor tick failed");
    }
    if (processorRunning) {
      processorTimer = setTimeout(tick, RETRY_INTERVAL_MS);
    }
  };

  tick();
  logger.info("Retry processor started");
}

export function stopRetryProcessor(): void {
  processorRunning = false;
  if (processorTimer) {
    clearTimeout(processorTimer);
    processorTimer = null;
  }
  logger.info("Retry processor stopped");
}
