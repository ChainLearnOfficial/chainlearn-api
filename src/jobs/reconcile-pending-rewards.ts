// #207 — Reconciliation job for bad_seq pending reward claims.
//
// When a Stellar transaction fails with bad_seq the submission is marked
// rewardPending=true with txHash="pending_indexer_confirmation".  Without this
// job those submissions stay pending forever and users never receive credits.
//
// This job runs every RECONCILE_INTERVAL_MS.  For each pending submission it
// checks the actual transaction status on Horizon.
//   • Confirmed on-chain  → grant credits, rewardClaimed=true, rewardPending=false
//   • Not found / failed  → rewardPending=false, rewardFailed=true (allow retry)
//   • Horizon unreachable → skip and try again next tick

import { eq, and, isNotNull, ne } from "drizzle-orm";
import { sql } from "drizzle-orm";
import { db } from "../config/database.js";
import { quizSubmissions, users } from "../database/schema.js";
import { stellarClient } from "../stellar/client.js";
import { logger } from "../utils/logger.js";

const RECONCILE_INTERVAL_MS = 5 * 60 * 1_000; // 5 minutes
const BATCH_LIMIT = 50;
const REWARD_AMOUNT = 10;

export async function reconcilePendingRewards(): Promise<void> {
  let reconciled = 0;
  let failed = 0;

  try {
    const pending = await db
      .select()
      .from(quizSubmissions)
      .where(
        and(
          eq(quizSubmissions.rewardPending, true),
          eq(quizSubmissions.rewardClaimed, false),
          isNotNull(quizSubmissions.txHash),
          ne(quizSubmissions.txHash, "pending_indexer_confirmation")
        )
      )
      .limit(BATCH_LIMIT);

    // Also reconcile entries whose txHash IS "pending_indexer_confirmation"
    // (bad_seq path — these need to be re-queued as failed so they can retry).
    const badSeqPending = await db
      .select()
      .from(quizSubmissions)
      .where(
        and(
          eq(quizSubmissions.rewardPending, true),
          eq(quizSubmissions.rewardClaimed, false),
          eq(quizSubmissions.txHash, "pending_indexer_confirmation")
        )
      )
      .limit(BATCH_LIMIT);

    // Reconcile submissions with real txHashes by checking Horizon.
    await Promise.allSettled(
      pending.map(async (submission) => {
        try {
          const txResult = await stellarClient.getTransaction(submission.txHash!);

          if (txResult.status === "SUCCESS") {
            await db.transaction(async (tx) => {
              await tx
                .update(quizSubmissions)
                .set({ rewardClaimed: true, rewardPending: false })
                .where(eq(quizSubmissions.id, submission.id));

              await tx
                .update(users)
                .set({ credits: sql`${users.credits} + ${REWARD_AMOUNT}` })
                .where(eq(users.id, submission.userId));
            });
            reconciled++;
            logger.info({ submissionId: submission.id, txHash: submission.txHash }, "Pending reward confirmed on-chain");
          } else {
            // Transaction failed or was not found — release pending so it can be retried.
            await db
              .update(quizSubmissions)
              .set({ rewardPending: false, rewardFailed: true })
              .where(eq(quizSubmissions.id, submission.id));
            failed++;
            logger.warn({ submissionId: submission.id, status: txResult.status }, "Pending reward tx not successful — marking failed");
          }
        } catch (err) {
          // Horizon unreachable — leave pending, retry next tick.
          logger.error({ err, submissionId: submission.id }, "Could not check tx status; will retry next reconcile tick");
        }
      })
    );

    // Release bad_seq entries back to retry-eligible state.
    if (badSeqPending.length > 0) {
      const ids = badSeqPending.map((s) => s.id);
      for (const id of ids) {
        await db
          .update(quizSubmissions)
          .set({ rewardPending: false, rewardFailed: false, txHash: null })
          .where(eq(quizSubmissions.id, id));
      }
      logger.info({ count: badSeqPending.length }, "Released bad_seq pending submissions for retry");
    }

    if (reconciled > 0 || failed > 0 || badSeqPending.length > 0) {
      logger.info({ reconciled, failed, requeued: badSeqPending.length }, "Reconcile tick complete");
    }
  } catch (err) {
    logger.error({ err }, "Reconcile pending rewards job failed");
  }
}

let reconcileInterval: ReturnType<typeof setInterval> | null = null;

export function startReconciliationJob(): void {
  if (reconcileInterval) return;

  // Run immediately on startup, then on schedule.
  reconcilePendingRewards().catch((err) =>
    logger.error({ err }, "Initial reconciliation run failed")
  );

  reconcileInterval = setInterval(reconcilePendingRewards, RECONCILE_INTERVAL_MS);
  logger.info({ intervalMs: RECONCILE_INTERVAL_MS }, "Pending reward reconciliation job started");
}

export function stopReconciliationJob(): void {
  if (reconcileInterval) {
    clearInterval(reconcileInterval);
    reconcileInterval = null;
  }
  logger.info("Pending reward reconciliation job stopped");
}
