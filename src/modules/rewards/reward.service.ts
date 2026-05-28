import { eq, and, desc } from "drizzle-orm";
import { db } from "../../config/database.js";
import {
  quizSubmissions,
  quizzes,
  courses,
  users,
} from "../../database/schema.js";
import { NotFoundError, ForbiddenError, ConflictError } from "../../utils/errors.js";
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
   * Calls the on-chain reward contract and updates the database.
   */
  async claimReward(
    userId: string,
    submissionId: string
  ): Promise<RewardClaimResult> {
    const submission = await db.query.quizSubmissions.findFirst({
      where: and(
        eq(quizSubmissions.id, submissionId),
        eq(quizSubmissions.userId, userId)
      ),
      with: { quiz: true },
    });

    if (!submission) {
      throw new NotFoundError("Quiz submission");
    }

    if (submission.rewardClaimed) {
      throw new ConflictError("Reward already claimed for this submission");
    }

    if (!submission.score || submission.score < 1) {
      throw new ForbiddenError("Quiz not passed — no reward available");
    }

    // Generate proof for the on-chain contract
    const quiz = await db.query.quizzes.findFirst({
      where: eq(quizzes.id, submission.quizId),
    });

    if (!quiz) {
      throw new NotFoundError("Quiz");
    }

    const proof = createQuizProof(userId, submission.quizId, submission.score);

    // Invoke the reward contract on Soroban
    let txHash: string;
    try {
      const user = await db.query.users.findFirst({
        where: eq(users.id, userId),
      });

      txHash = await invokeContract(
        config.STELLAR_REWARD_CONTRACT_ID,
        "claim_reward",
        [
          StellarSdk.Address.fromString(user!.stellarAddress).toScVal(),
          StellarSdk.nativeToScVal(submission.score, { type: "u32" }),
          StellarSdk.nativeToScVal(Buffer.from(proof.signature, "base64")),
        ]
      );
    } catch (err) {
      logger.error({ err, submissionId }, "On-chain reward claim failed");
      throw new Error("Failed to process on-chain reward");
    }

    // Update submission and user credits
    await db
      .update(quizSubmissions)
      .set({ rewardClaimed: true, txHash })
      .where(eq(quizSubmissions.id, submissionId));

    await db
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

// Need to import sql
import { sql } from "drizzle-orm";

export const rewardService = new RewardService();
