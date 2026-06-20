import { eq, and, desc, sql } from "drizzle-orm";
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
import {
  deleteIdempotencyKey,
  reserveIdempotencyKey,
  storeIdempotentResponse,
  storeIdempotencyTxHash,
} from "../../middleware/idempotency.js";
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
    submissionId: string,
    idempotencyKey?: string
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

    const user = await db.query.users.findFirst({
      where: eq(users.id, userId),
    });

    if (!user) {
      throw new NotFoundError("User");
    }

    const proof = createQuizProof(userId, submission.quizId, submission.score);
    const idempotency = idempotencyKey
      ? await reserveIdempotencyKey({
          key: idempotencyKey,
          userId,
          endpoint: "/api/rewards/claim",
          requestBody: { submissionId, idempotencyKey },
        })
      : null;

    if (idempotency?.state === "cached") {
      return idempotency.record.responseBody as RewardClaimResult;
    }

    const responseSubmissionId = submission.id;
    const claimResultFromState = async (txHash: string): Promise<RewardClaimResult> => {
      const latestSubmission = await db.query.quizSubmissions.findFirst({
        where: eq(quizSubmissions.id, submissionId),
      });

      if (latestSubmission?.rewardClaimed && latestSubmission.txHash === txHash) {
        return {
          submissionId: responseSubmissionId,
          amount: REWARD_AMOUNT,
          txHash,
          message: `Successfully claimed ${REWARD_AMOUNT} credits`,
        };
      }

      await db.transaction(async (tx) => {
        const currentSubmission = await tx.query.quizSubmissions.findFirst({
          where: eq(quizSubmissions.id, submissionId),
        });

        if (!currentSubmission) {
          throw new NotFoundError("Quiz submission");
        }

        if (!currentSubmission.rewardClaimed) {
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
        }
      });

      return {
        submissionId: responseSubmissionId,
        amount: REWARD_AMOUNT,
        txHash,
        message: `Successfully claimed ${REWARD_AMOUNT} credits`,
      };
    };

    let txHash: string;
    let onChainSucceeded = false;
    try {
      if (idempotency?.state === "resume" && idempotency.record.txHash) {
        txHash = idempotency.record.txHash;
      } else {
        txHash = await invokeContract(
          config.STELLAR_REWARD_CONTRACT_ID,
          "claim_reward",
          [
            StellarSdk.Address.fromString(user.stellarAddress).toScVal(),
            StellarSdk.nativeToScVal(submission.score, { type: "u32" }),
            StellarSdk.nativeToScVal(Buffer.from(proof.signature, "base64")),
          ]
        );
        onChainSucceeded = true;
      }

      if (idempotencyKey) {
        await storeIdempotencyTxHash(idempotencyKey, txHash);
      }

      const result = await claimResultFromState(txHash);

      if (idempotencyKey) {
        await storeIdempotentResponse(idempotencyKey, 200, result);
      }

      logger.info(
        { userId, submissionId, txHash, amount: REWARD_AMOUNT },
        "Reward claimed"
      );

      return result;
    } catch (err) {
      if (!onChainSucceeded && idempotencyKey) {
        await deleteIdempotencyKey(idempotencyKey);
      }

      logger.error({ err, submissionId }, "On-chain reward claim failed");
      throw new Error("Failed to process on-chain reward");
    }
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
