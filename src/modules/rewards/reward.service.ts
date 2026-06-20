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
import { config } from "../../config/index.js";
import { logger } from "../../utils/logger.js";
import StellarSdk from "@stellar/stellar-sdk";
import type { RewardClaimResult, RewardHistoryItem } from "./reward.types.js";

const REWARD_AMOUNT = 10; // credits per passed quiz

export class RewardService {
  /**
   * Claim a reward for a passed quiz submission.
   * Uses distributed locking + database transaction with row-level lock
   * to prevent double-spend from concurrent requests.
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

        let txHash: string;
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

        logger.info(
          { userId, submissionId, txHash, amount: REWARD_AMOUNT },
          "Reward claimed"
        );

        return {
          submissionId,
          amount: REWARD_AMOUNT,
          txHash,
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
