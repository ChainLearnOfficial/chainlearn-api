import { eq, and, desc, sql } from "drizzle-orm";
import { db } from "../../config/database.js";
import {
  quizSubmissions,
  quizzes,
  courses,
  users,
} from "../../database/schema.js";
import {
  NotFoundError,
  ForbiddenError,
  ConflictError,
  StellarError,
} from "../../utils/errors.js";
import { withLock } from "../../utils/lock.js";
import { invokeContract } from "../../stellar/transactions.js";
import { stellarClient } from "../../stellar/client.js";
import { createQuizProof } from "../../stellar/signatures.js";
import { isCircuitBreakerError } from "../../stellar/resilience.js";
import { config } from "../../config/index.js";
import { logger } from "../../utils/logger.js";
import { enqueueReward } from "../../services/retry-queue.js";
import StellarSdk from "@stellar/stellar-sdk";
import type { RewardClaimResult, RewardHistoryItem } from "./reward.types.js";
import { auditLog } from "../../audit/index.js";
import {
  stellarTxDurationSeconds,
  rewardClaimsTotal,
} from "../../metrics/index.js";
import { cacheGet, cacheSet, cacheDel, cacheKey } from "../../cache/index.js";

const REWARD_AMOUNT = 10; // credits per passed quiz
const PASSING_PERCENTAGE = 70;

/**
 * Helper function to handle bad_seq errors from Stellar transactions.
 * When a bad_seq error occurs, it attempts to fetch the current account sequence
 * for debugging purposes. The transaction may still succeed on-chain despite the error.
 * @returns txHash set to "pending_indexer_confirmation" to indicate uncertain state
 */
async function handleBadSeqError(submissionId: string, stellarAddress: string): Promise<string> {
  let accountSeq = "unknown";
  try {
    const account = await stellarClient.getAccount(stellarAddress);
    accountSeq = account.sequence;
  } catch {
    // Intentionally swallow error: sequence fetch is for debugging only
    // If Horizon is unavailable, we still want to mark the transaction as pending
  }
  
  logger.warn(
    { submissionId, accountSeq },
    "bad_seq after invoke — the tx might actually succeed on-chain"
  );
  return "pending_indexer_confirmation";
}

/**
 * Shared reward claim execution logic.
 * Used by both the direct claim path and the background retry processor.
 * Returns true if the claim succeeded, false if it should be retried.
 */
export async function processRewardClaim(
  submissionId: string,
  userId: string,
  score: number,
): Promise<boolean> {
  const [submission] = await db
    .select()
    .from(quizSubmissions)
    .where(eq(quizSubmissions.id, submissionId));

  if (!submission || submission.rewardClaimed) {
    return true;
  }

  const [quiz] = await db
    .select()
    .from(quizzes)
    .where(eq(quizzes.id, submission.quizId));

  if (!quiz) return true;
  if (submission.score === null) return true;

  const questions = quiz.questions as Array<unknown>;
  const percentage = Math.round((submission.score / questions.length) * 100);
  if (percentage < PASSING_PERCENTAGE) {
    return true;
  }

  const proof = createQuizProof(userId, submission.quizId, submission.score);

  const [user] = await db.select().from(users).where(eq(users.id, userId));

  if (!user) return true;

  const txStart = process.hrtime.bigint();
  let txHash: string;
  try {
    txHash = await invokeContract(
      config.STELLAR_REWARD_CONTRACT_ID,
      "claim_reward",
      [
        StellarSdk.Address.fromString(user.stellarAddress).toScVal(),
        StellarSdk.nativeToScVal(score, { type: "u32" }),
        StellarSdk.nativeToScVal(Buffer.from(proof.signature, "base64")),
      ],
    );
    stellarTxDurationSeconds.observe(
      { method: "claim_reward", status: "success" },
      Number(process.hrtime.bigint() - txStart) / 1e9,
    );
  } catch (err: unknown) {
    stellarTxDurationSeconds.observe(
      { method: "claim_reward", status: "error" },
      Number(process.hrtime.bigint() - txStart) / 1e9,
    );
    if (err instanceof StellarError && err.message.includes("bad_seq")) {
      txHash = await handleBadSeqError(submissionId, user.stellarAddress);
    } else if (err instanceof StellarError && err.message.includes("tx_bad_seq")) {
      txHash = await handleBadSeqError(submissionId, user.stellarAddress);
    } else {
      throw err;
    }
  }

  await db.transaction(async (tx) => {
    await tx
      .update(quizSubmissions)
      .set({ rewardClaimed: true, txHash })
      .where(eq(quizSubmissions.id, submissionId));

    await tx
      .update(users)
      .set({
        credits: sql`${users.credits} + ${REWARD_AMOUNT}`,
      })
      .where(eq(users.id, userId));
  });

  await cacheDel(cacheKey("user", "progress", userId));
  await cacheDel(cacheKey("user", "profile", userId));
  await cacheDel(cacheKey("rewards", "history", userId));

  return true;
}

export class RewardService {
  /**
   * Claim a reward for a passed quiz submission.
   * Uses distributed locking + database transaction with row-level lock
   * to prevent double-spend from concurrent requests.
   * Gracefully degrades when Stellar is unavailable by queuing the claim.
   */
  async claimReward(
    userId: string,
    submissionId: string,
  ): Promise<RewardClaimResult> {
    return withLock(`reward:${submissionId}`, async () => {
      return db.transaction(async (tx) => {
        const [submission] = await tx
          .select()
          .from(quizSubmissions)
          .where(
            and(
              eq(quizSubmissions.id, submissionId),
              eq(quizSubmissions.userId, userId),
            ),
          )
          .for("update");

        if (!submission) {
          throw new NotFoundError("Quiz submission");
        }

        if (submission.rewardClaimed) {
          throw new ConflictError("Reward already claimed for this submission");
        }

        if (!submission.score || submission.score < 1) {
          throw new ForbiddenError("Quiz not passed — no reward available");
        }

        const [quiz] = await tx
          .select()
          .from(quizzes)
          .where(eq(quizzes.id, submission.quizId));

        if (!quiz) {
          throw new NotFoundError("Quiz");
        }

        const questions = quiz.questions as Array<unknown>;
        const percentage = Math.round((submission.score / questions.length) * 100);
        if (percentage < PASSING_PERCENTAGE) {
          throw new ForbiddenError(
            `Score ${percentage}% below passing threshold of ${PASSING_PERCENTAGE}%`
          );
        }

        const proof = createQuizProof(
          userId,
          submission.quizId,
          submission.score,
        );

        const [user] = await tx
          .select()
          .from(users)
          .where(eq(users.id, userId));

        if (!user) {
          throw new NotFoundError("User");
        }

        let txHash: string | null = null;
        try {

          txHash = await invokeContract(
            config.STELLAR_REWARD_CONTRACT_ID,
            "claim_reward",
            [
              StellarSdk.Address.fromString(user.stellarAddress).toScVal(),
              StellarSdk.nativeToScVal(submission.score, { type: "u32" }),
              StellarSdk.nativeToScVal(Buffer.from(proof.signature, "base64")),
            ],
          );
        } catch (err: unknown) {
          if (err instanceof NotFoundError) throw err;

          if (isCircuitBreakerError(err)) {
            logger.warn(
              { submissionId },
              "Stellar circuit breaker open — queuing reward for later",
            );
            await enqueueReward({
              submissionId,
              userId,
              score: submission.score,
            });
            rewardClaimsTotal.inc({ status: "queued" });
            auditLog("reward.queued", {
              userId,
              submissionId,
              amount: REWARD_AMOUNT,
              queued: true,
            });
            return {
              submissionId,
              amount: REWARD_AMOUNT,
              txHash: null,
              queued: true,
              message:
                "Reward claim queued — Stellar is temporarily unavailable",
            };
          }

          if (err instanceof StellarError && err.message.includes("bad_seq")) {
            txHash = await handleBadSeqError(submissionId, user.stellarAddress);
          } else if (err instanceof StellarError && err.message.includes("tx_bad_seq")) {
            txHash = await handleBadSeqError(submissionId, user.stellarAddress);
          } else {
            logger.error({ err, submissionId }, "On-chain reward claim failed");
            throw new Error("Failed to process on-chain reward");
          }
        }

        await tx
          .update(quizSubmissions)
          .set({ rewardClaimed: true, txHash })
          .where(eq(quizSubmissions.id, submissionId));

        await tx
          .update(users)
          .set({
            credits: sql`${users.credits} + ${REWARD_AMOUNT}`,
          })
          .where(eq(users.id, userId));

        rewardClaimsTotal.inc({ status: "success" });
        auditLog("reward.claimed", {
          userId,
          submissionId,
          txHash,
          amount: REWARD_AMOUNT,
        });
        logger.info(
          { userId, submissionId, txHash, amount: REWARD_AMOUNT },
          "Reward claimed",
        );

        await cacheDel(cacheKey("user", "progress", userId));
        await cacheDel(cacheKey("user", "profile", userId));
        await cacheDel(cacheKey("rewards", "history", userId));

        return {
          submissionId,
          amount: REWARD_AMOUNT,
          txHash,
          queued: false,
          message: `Successfully claimed ${REWARD_AMOUNT} credits`,
        };
      });
    });
  }

  /**
   * Get reward history for a user.
   */
  async getHistory(userId: string): Promise<RewardHistoryItem[]> {
    const namespace = "rewards";
    const cacheKeyString = cacheKey(namespace, "history", userId);

    const cached = await cacheGet<RewardHistoryItem[]>(
      namespace,
      cacheKeyString,
    );
    if (cached) return cached;

    const rows = await db
      .select({
        id: quizSubmissions.id,
        score: quizSubmissions.score,
        txHash: quizSubmissions.txHash,
        submittedAt: quizSubmissions.submittedAt,
        courseTitle: courses.title,
      })
      .from(quizSubmissions)
      .innerJoin(quizzes, eq(quizSubmissions.quizId, quizzes.id))
      .innerJoin(courses, eq(quizzes.courseId, courses.id))
      .where(
        and(
          eq(quizSubmissions.userId, userId),
          eq(quizSubmissions.rewardClaimed, true),
        ),
      )
      .orderBy(desc(quizSubmissions.submittedAt));

    const history = rows.map((row) => ({
      id: row.id,
      courseTitle: row.courseTitle,
      score: row.score ?? 0,
      amount: REWARD_AMOUNT,
      txHash: row.txHash,
      claimedAt: row.submittedAt,
    }));

    await cacheSet(cacheKeyString, history, 30);

    return history;
  }
}

export const rewardService = new RewardService();
