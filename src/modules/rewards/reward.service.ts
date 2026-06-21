import { eq, and, desc, sql } from "drizzle-orm";
import { db } from "../../config/database.js";
import {
  quizSubmissions,
  quizzes,
  courses,
  users,
} from "../../database/schema.js";
import { NotFoundError, ForbiddenError, ConflictError } from "../../utils/errors.js";
import { withLock } from "../../utils/lock.js";
import { invokeContract } from "../../stellar/transactions.js";
import { createQuizProof } from "../../stellar/signatures.js";
import { isCircuitBreakerError } from "../../stellar/resilience.js";
import { config } from "../../config/index.js";
import { logger } from "../../utils/logger.js";
import { enqueueReward } from "../../services/retry-queue.js";
import StellarSdk from "@stellar/stellar-sdk";
import type { RewardClaimResult, RewardHistoryItem } from "./reward.types.js";
import { auditLog } from "../../audit/index.js";
import { stellarTxDurationSeconds, rewardClaimsTotal } from "../../metrics/index.js";

const REWARD_AMOUNT = 10; // credits per passed quiz

/**
 * Shared reward claim execution logic.
 * Used by both the direct claim path and the background retry processor.
 * Returns true if the claim succeeded, false if it should be retried.
 */
export async function processRewardClaim(
  submissionId: string,
  userId: string,
  score: number
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

  const proof = createQuizProof(userId, submission.quizId, score);

  const [user] = await db
    .select()
    .from(users)
    .where(eq(users.id, userId));

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
      ]
    );
    stellarTxDurationSeconds.observe(
      { method: "claim_reward", status: "success" },
      Number(process.hrtime.bigint() - txStart) / 1e9
    );
  } catch (err) {
    stellarTxDurationSeconds.observe(
      { method: "claim_reward", status: "error" },
      Number(process.hrtime.bigint() - txStart) / 1e9
    );
    throw err;
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
    submissionId: string
  ): Promise<RewardClaimResult> {
    return withLock(`reward:${submissionId}`, async () => {
      return db.transaction(async (tx) => {
        const [submission] = await tx
          .select()
          .from(quizSubmissions)
          .where(
            and(
              eq(quizSubmissions.id, submissionId),
              eq(quizSubmissions.userId, userId)
            )
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

        const proof = createQuizProof(userId, submission.quizId, submission.score);

        let txHash: string | null = null;
        try {
          const [user] = await tx
            .select()
            .from(users)
            .where(eq(users.id, userId));

          if (!user) {
            throw new NotFoundError("User");
          }

          txHash = await invokeContract(
            config.STELLAR_REWARD_CONTRACT_ID,
            "claim_reward",
            [
              StellarSdk.Address.fromString(user.stellarAddress).toScVal(),
              StellarSdk.nativeToScVal(submission.score, { type: "u32" }),
              StellarSdk.nativeToScVal(Buffer.from(proof.signature, "base64")),
            ]
          );
        } catch (err) {
          if (err instanceof NotFoundError) throw err;

          if (isCircuitBreakerError(err)) {
            logger.warn(
              { submissionId },
              "Stellar circuit breaker open — queuing reward for later"
            );
            await enqueueReward({ submissionId, userId, score: submission.score });
            rewardClaimsTotal.inc({ status: "queued" });
            auditLog("reward.queued", { userId, submissionId, amount: REWARD_AMOUNT, queued: true });
            return {
              submissionId,
              amount: REWARD_AMOUNT,
              txHash: null,
              queued: true,
              message: "Reward claim queued — Stellar is temporarily unavailable",
            };
          }

          logger.error({ err, submissionId }, "On-chain reward claim failed");
          throw new Error("Failed to process on-chain reward");
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
        auditLog("reward.claimed", { userId, submissionId, txHash, amount: REWARD_AMOUNT });
        logger.info(
          { userId, submissionId, txHash, amount: REWARD_AMOUNT },
          "Reward claimed"
        );

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
          eq(quizSubmissions.rewardClaimed, true)
        )
      )
      .orderBy(desc(quizSubmissions.submittedAt));

    return rows.map((row) => ({
      id: row.id,
      courseTitle: row.courseTitle,
      score: row.score ?? 0,
      amount: REWARD_AMOUNT,
      txHash: row.txHash,
      claimedAt: row.submittedAt,
    }));
  }
}

export const rewardService = new RewardService();
