import { logger } from "../utils/logger.js";
import { processWebhookRetries } from "../services/webhook-dispatcher.js";

let retryProcessorRunning = false;
let retryProcessorTimer: ReturnType<typeof setInterval> | null = null;
let retryProcessorGeneration = 0;

const POLL_INTERVAL_MS = 60_000; // 1 minute

export async function startWebhookRetryProcessor(): Promise<void> {
  if (retryProcessorRunning) return;
  retryProcessorRunning = true;
  const generation = ++retryProcessorGeneration;

  const tick = async () => {
    if (generation !== retryProcessorGeneration) return;
    try {
      await processWebhookRetries();
    } catch (err) {
      logger.error({ err }, "Webhook retry processor tick failed");
    }
    if (generation === retryProcessorGeneration) {
      retryProcessorTimer = setTimeout(tick, POLL_INTERVAL_MS);
    }
  };

  await tick();
  logger.info("Webhook retry processor started");
}

export function stopWebhookRetryProcessor(): void {
  retryProcessorRunning = false;
  retryProcessorGeneration++;
  if (retryProcessorTimer) {
    clearTimeout(retryProcessorTimer);
    retryProcessorTimer = null;
  }
  logger.info("Webhook retry processor stopped");
}
