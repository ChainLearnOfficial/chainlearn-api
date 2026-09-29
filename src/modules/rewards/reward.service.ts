import { eq, and, desc, inArray, sql } from "drizzle-orm";
import { db } from "../../config/database.js";
import crypto from "node:crypto";
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
import { enqueueReward, getQueuedRewardJobs, estimateProcessingSeconds } from "../../services/retry-queue.js";
import { dispatchWebhook } from "../../services/webhook-dispatcher.js";
import StellarSdk from "@stellar/stellar-sdk";
import type {
  RewardClaimResult,
  RewardHistoryItem,
  RewardTransaction,
  PendingRewardItem,
} from "./reward.types.js";
import { PASSING_PERCENTAGE } from "../quizzes/quiz.types.js";
import { auditLog } from "../../audit/index.js";
import {
  stellarTxDurationSeconds,
  rewardClaimsTotal,
} from "../../metrics/index.js";
import {
  cacheGet,
  cacheSet,
  cacheDel,
  cacheKey,
  cacheInvalidatePattern,
} from "../../cache/index.js";
import { Injectable, BadRequestException, NotFoundException } from '@nestjs/common';
import { DeductCreditsDto } from './dto/deduct-credits.dto';

const REWARD_AMOUNT = 10; // credits per passed quiz

export async function selectSubmissionForUpdate(
  tx: Parameters<typeof db.transaction>[0] extends (arg: infer T) => any ? T : never,
  submissionId: string,
  userId?: string,
) {
  const filters = [eq(quizSubmissions.id, submissionId)];
  if (userId) {
    filters.push(eq(quizSubmissions.userId, userId));
  }

  return tx
    .select()
    .from(quizSubmissions)
    .where(and(...filters))
    .for("update");
}

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
  } catch (err) {
    // Intentionally swallow error: sequence fetch is for debugging only —
    // if Horizon is unavailable, we still want to mark the transaction as
    // pending. Logged at warn (not error) since this is a best-effort
    // diagnostic lookup, not the failure itself — the bad_seq warning below
    // still fires either way.
    logger.warn(
      { err, submissionId },
      "Could not fetch account sequence while handling bad_seq (debugging aid only)",
    );
  }
  
  logger.warn(
    { submissionId, accountSeq },
    "bad_seq after invoke — the tx might actually succeed on-chain"
  );
  return "pending_indexer_confirmation";
}

interface RewardClaimData {
  submissionId: string;
  userId: string;
  score: number;
  stellarAddress: string;
  quizId: string;
}

// Phase 2: invoke Stellar, observe metrics, handle bad_seq. Throws on all other errors.
async function _executeStellarRewardClaim(claimData: RewardClaimData): Promise<string> {
  const proof = createQuizProof(claimData.userId, claimData.quizId, claimData.score);
  const txStart = process.hrtime.bigint();
  try {
    const txHash = await invokeContract(
      config.STELLAR_REWARD_CONTRACT_ID,
      "claim_reward",
      [
        StellarSdk.Address.fromString(claimData.stellarAddress).toScVal(),
        StellarSdk.nativeToScVal(claimData.score, { type: "u32" }),
        StellarSdk.nativeToScVal(Buffer.from(proof.signature, "base64")),
      ],
    );
    stellarTxDurationSeconds.observe(
      { method: "claim_reward", status: "success" },
      Number(process.hrtime.bigint() - txStart) / 1e9,
    );
    return txHash;
  } catch (err: unknown) {
    stellarTxDurationSeconds.observe(
      { method: "claim_reward", status: "error" },
      Number(process.hrtime.bigint() - txStart) / 1e9,
    );
    if (
      err instanceof StellarError &&
      (err.message.includes("bad_seq") || err.message.includes("tx_bad_seq"))
    ) {
      return handleBadSeqError(claimData.submissionId, claimData.stellarAddress);
    }
    logger.error(
      { err, submissionId: claimData.submissionId, userId: claimData.userId },
      "Stellar reward claim transaction failed",
    );
    throw err;
  }
}

// Phase 3: write the confirmed or pending-confirmation outcome to the database.
async function _applyRewardToDb(submissionId: string, userId: string, txHash: string): Promise<void> {
  const isPending = txHash === "pending_indexer_confirmation";
  await db.transaction(async (tx) => {
    if (isPending) {
      await tx
        .update(quizSubmissions)
        .set({ rewardClaimed: false, rewardPending: true, txHash })
        .where(eq(quizSubmissions.id, submissionId));
    } else {
      await tx
        .update(quizSubmissions)
        .set({ rewardClaimed: true, rewardPending: false, txHash, rewardAmount: REWARD_AMOUNT })
        .where(eq(quizSubmissions.id, submissionId));
      await tx
        .update(users)
        .set({ credits: sql`${users.credits} + ${REWARD_AMOUNT}` })
        .where(eq(users.id, userId));
    }
  });
}

/**
 * Shared reward claim execution logic.
 * Used by both the direct claim path and the background retry processor.
 * Returns true if the claim succeeded, false if it should be retried.
 *
 * Uses a two-phase approach: validate and mark the submission in a short DB transaction,
 * execute the Stellar transaction outside the DB transaction, then update the DB once
 * the on-chain result is known. This prevents holding database connections during network calls.
 */
export async function processRewardClaim(
  submissionId: string,
  userId: string,
): Promise<boolean> {
  return withLock(`reward:${submissionId}`, async () => {
    // Phase 1: Validate and mark as pending in a quick DB transaction.
    // Score is always read from the database — never trusted from the caller
    // so a tampered retry-queue payload cannot elevate a failing score.
    const claimData = await db.transaction(async (tx) => {
      const [submission] = await selectSubmissionForUpdate(tx, submissionId);

      if (!submission || submission.rewardClaimed || submission.rewardPending || submission.rewardFailed) {
        return null;
      }

      const [quiz] = await tx
        .select()
        .from(quizzes)
        .where(eq(quizzes.id, submission.quizId));

      if (!quiz) return null;
      if (submission.score === null) return null;

      const dbScore = submission.score;
      const questions = quiz.questions as Array<unknown> | null;
      if (!questions || questions.length === 0) return null;
      const percentage = Math.round((dbScore / questions.length) * 100);
      if (percentage < PASSING_PERCENTAGE) {
        return null;
      }

      const [user] = await tx.select().from(users).where(eq(users.id, userId));
      if (!user) return null;

      // Mark as pending to prevent concurrent claims
      await tx
        .update(quizSubmissions)
        .set({ rewardPending: true })
        .where(eq(quizSubmissions.id, submissionId));

      return {
        submissionId,
        userId,
        score: dbScore,
        stellarAddress: user.stellarAddress,
        quizId: submission.quizId,
      };
    });

    // If validation failed or already pending, return early
    if (!claimData) {
      return true;
    }

    // Phase 2 & 3: Stellar invocation then DB update — shared with claimReward.
    let txHash: string;
    try {
      txHash = await _executeStellarRewardClaim(claimData);
    } catch (err: unknown) {
      logger.error(
        { err, submissionId, userId },
        "Reward claim failed — marking submission as rewardFailed",
      );
      await db
        .update(quizSubmissions)
        .set({ rewardPending: false, rewardFailed: true })
        .where(eq(quizSubmissions.id, submissionId));
      throw err;
    }
    await _applyRewardToDb(submissionId, userId, txHash);

    return true;
  }).then(async (result) => {
    if (result) {
      await cacheDel(cacheKey("user", "progress", userId));
      await cacheDel(cacheKey("user", "profile", userId));
      await cacheInvalidatePattern(cacheKey("rewards", "history", userId, "*"));
      await cacheInvalidatePattern(cacheKey("user", "activity", userId, "*"));
    }
    return result;
  });
}

export class RewardService {
  /**
   * Claim a reward for a passed quiz submission.
   * Uses distributed locking + database transaction with row-level lock
   * to prevent double-spend from concurrent requests.
   * Gracefully degrades when Stellar is unavailable by queuing the claim.
   *
   * Uses two-phase approach: validate in DB tx, execute Stellar tx outside DB,
   * then update DB. This prevents holding database connections during network calls.
   */
  async claimReward(
    userId: string,
    submissionId: string,
  ): Promise<RewardClaimResult> {
    return withLock(`reward:${submissionId}`, async () => {
      // Phase 1: Validate and mark as pending in a quick DB transaction
      const claimData = await db.transaction(async (tx) => {
        const [submission] = await selectSubmissionForUpdate(tx, submissionId, userId);

        if (!submission) {
          throw new NotFoundError("Quiz submission");
        }

        if (submission.rewardClaimed) {
          throw new ConflictError("Reward already claimed for this submission");
        }

        if (submission.rewardPending) {
          throw new ConflictError("Reward claim in progress");
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

        const questions = quiz.questions as Array<unknown> | null;
        if (!questions || questions.length === 0) {
          throw new ForbiddenError("Quiz has no questions");
        }
        const percentage = Math.round((submission.score / questions.length) * 100);
        if (percentage < PASSING_PERCENTAGE) {
          throw new ForbiddenError(
            `Score ${percentage}% below passing threshold of ${PASSING_PERCENTAGE}%`
          );
        }

        const [user] = await tx
          .select()
          .from(users)
          .where(eq(users.id, userId));

        if (!user) {
          throw new NotFoundError("User");
        }

        // Mark as pending to prevent concurrent claims
        await tx
          .update(quizSubmissions)
          .set({ rewardPending: true })
          .where(eq(quizSubmissions.id, submissionId));

        return {
          submissionId,
          userId,
          score: submission.score,
          stellarAddress: user.stellarAddress,
          quizId: submission.quizId,
        };
      });

      // Phase 2 & 3: Stellar invocation then DB update — shared with processRewardClaim.
      let txHash: string;
      try {
        txHash = await _executeStellarRewardClaim(claimData);
      } catch (err: unknown) {
        if (err instanceof NotFoundError) throw err;

        if (isCircuitBreakerError(err)) {
          logger.warn(
            { submissionId },
            "Stellar circuit breaker open — queuing reward for later",
          );
          await db
            .update(quizSubmissions)
            .set({ rewardPending: false })
            .where(eq(quizSubmissions.id, submissionId));
          await enqueueReward({ submissionId, userId });
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
            message: "Reward claim queued — Stellar is temporarily unavailable",
          };
        }

        await db
          .update(quizSubmissions)
          .set({ rewardPending: false, rewardFailed: true })
          .where(eq(quizSubmissions.id, submissionId));
        logger.error({ err, submissionId }, "On-chain reward claim failed");
        throw new Error("Failed to process on-chain reward");
      }

      await _applyRewardToDb(submissionId, userId, txHash);

      const isPending = txHash === "pending_indexer_confirmation";
      if (isPending) {
        rewardClaimsTotal.inc({ status: "pending" });
        auditLog("reward.pending_confirmation", {
          userId,
          submissionId,
          txHash,
          amount: REWARD_AMOUNT,
        });
        logger.info(
          { userId, submissionId, txHash },
          "Reward claim pending indexer confirmation due to sequence error"
        );

        await cacheDel(cacheKey("user", "progress", userId));
        await cacheDel(cacheKey("user", "profile", userId));
        await cacheInvalidatePattern(cacheKey("rewards", "history", userId, "*"));

        return {
          submissionId,
          amount: REWARD_AMOUNT,
          txHash,
          queued: true,
          message:
            "Reward transaction pending confirmation. Credits will be applied once confirmed.",
        };
      }

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
      await cacheInvalidatePattern(cacheKey("rewards", "history", userId, "*"));
      await cacheInvalidatePattern(cacheKey("user", "activity", userId, "*"));

      return {
        submissionId,
        amount: REWARD_AMOUNT,
        txHash,
        queued: false,
        message: `Successfully claimed ${REWARD_AMOUNT} credits`,
      };
    });
  }

  /**
   * The user's reward claims that haven't landed yet (#327) — claims sitting
   * in the retry queue, plus claims whose Stellar transaction was submitted
   * but left unconfirmed by a sequence error.
   *
   * Queued entries come first, ordered by the retry queue's own ordering, so
   * the response reads as "here's what will happen, in what order".
   *
   * Cached for 10s: short enough that a claim moving from queued to claimed
   * disappears from this list promptly, long enough that a client polling it
   * while Stellar is down doesn't hammer the DB on every tick.
   */
  async getPendingRewards(userId: string): Promise<PendingRewardItem[]> {
    const namespace = "rewards";
    const cacheKeyString = cacheKey(namespace, "pending", userId);

    const cached = await cacheGet<PendingRewardItem[]>(namespace, cacheKeyString);
    if (cached) return cached;

    // A job still in the queue but already marked claimed/pending in the DB
    // would be double-reported (once as queued, once as awaiting
    // confirmation) — the metadata query below only picks up submissions that
    // are neither, so the two lists stay disjoint.
    const pendingRows = await db
      .select({
        submissionId: quizSubmissions.id,
        courseTitle: courses.title,
        rewardAmount: quizSubmissions.rewardAmount,
        txHash: quizSubmissions.txHash,
        submittedAt: quizSubmissions.submittedAt,
      })
      .from(quizSubmissions)
      .innerJoin(quizzes, eq(quizSubmissions.quizId, quizzes.id))
      .innerJoin(courses, eq(quizzes.courseId, courses.id))
      .where(
        and(
          eq(quizSubmissions.userId, userId),
          eq(quizSubmissions.rewardPending, true),
        ),
      );

    // The queue is a single global Redis sorted set shared by every user, so
    // filter to this user's jobs and keep the queue's own ordering (already
    // sorted by scheduled ready time) rather than re-sorting here.
    const queuedJobs = (await getQueuedRewardJobs()).filter(
      (job) => job.userId === userId,
    );

    let queuedItems: PendingRewardItem[] = [];
    if (queuedJobs.length > 0) {
      const metadataRows = await db
        .select({
          submissionId: quizSubmissions.id,
          courseTitle: courses.title,
          rewardAmount: quizSubmissions.rewardAmount,
          submittedAt: quizSubmissions.submittedAt,
        })
        .from(quizSubmissions)
        .innerJoin(quizzes, eq(quizSubmissions.quizId, quizzes.id))
        .innerJoin(courses, eq(quizzes.courseId, courses.id))
        .where(
          and(
            inArray(
              quizSubmissions.id,
              queuedJobs.map((job) => job.submissionId),
            ),
            eq(quizSubmissions.rewardClaimed, false),
            eq(quizSubmissions.rewardPending, false),
          ),
        );

      const bySubmissionId = new Map(
        metadataRows.map((row) => [row.submissionId, row]),
      );

      queuedItems = queuedJobs.flatMap((job) => {
        const row = bySubmissionId.get(job.submissionId);
        if (!row) return [];
        return [
          {
            submissionId: row.submissionId,
            courseTitle: row.courseTitle,
            amount: row.rewardAmount ?? REWARD_AMOUNT,
            status: "queued" as const,
            // 1-based: the queue's own `position` is 0-based, and "position 0"
            // reads as a bug to a user looking at a queue position.
            queuePosition: job.position + 1,
            estimatedProcessingSeconds: estimateProcessingSeconds(
              job.position,
              job.readyAt,
            ),
            submittedAt: row.submittedAt,
          },
        ];
      });
    }

    const result: PendingRewardItem[] = [
      ...queuedItems,
      ...pendingRows.map((row) => ({
        submissionId: row.submissionId,
        courseTitle: row.courseTitle,
        amount: row.rewardAmount ?? REWARD_AMOUNT,
        status: "awaiting_confirmation" as const,
        queuePosition: null,
        estimatedProcessingSeconds: null,
        submittedAt: row.submittedAt,
      })),
    ];

    await cacheSet(cacheKeyString, result, 10);

    return result;
  }

  /**
   * Get reward history for a user, paginated (issue #154 — this previously
   * returned every claimed reward unbounded, which grows without limit for
   * long-tenured users).
   */
  async getHistory(
    userId: string,
    page: number,
    limit: number,
  ): Promise<{ history: RewardHistoryItem[]; total: number }> {
    const namespace = "rewards";
    const cacheKeyString = cacheKey(namespace, "history", userId, page, limit);

    const cached = await cacheGet<{ history: RewardHistoryItem[]; total: number }>(
      namespace,
      cacheKeyString,
    );
    if (cached) return cached;

    const offset = (page - 1) * limit;
    const where = and(
      eq(quizSubmissions.userId, userId),
      eq(quizSubmissions.rewardClaimed, true),
    );

    const [totalResult] = await db
      .select({ value: sql<number>`count(*)`.mapWith(Number) })
      .from(quizSubmissions)
      .where(where);

    const rows = await db
      .select({
        id: quizSubmissions.id,
        score: quizSubmissions.score,
        txHash: quizSubmissions.txHash,
        submittedAt: quizSubmissions.submittedAt,
        courseTitle: courses.title,
        rewardAmount: quizSubmissions.rewardAmount,
      })
      .from(quizSubmissions)
      .innerJoin(quizzes, eq(quizSubmissions.quizId, quizzes.id))
      .innerJoin(courses, eq(quizzes.courseId, courses.id))
      .where(where)
      .orderBy(desc(quizSubmissions.submittedAt))
      .limit(limit)
      .offset(offset);

    const history = rows.map((row) => ({
      id: row.id,
      courseTitle: row.courseTitle,
      score: row.score ?? 0,
      // Issue #153: read back the amount actually granted at claim time.
      // rewardAmount is null on rows claimed before this column existed —
      // REWARD_AMOUNT was the only value ever granted at that point, so it's
      // an accurate backfill for pre-migration rows, not a guess.
      amount: row.rewardAmount ?? REWARD_AMOUNT,
      txHash: row.txHash,
      claimedAt: row.submittedAt,
    }));

    const result = { history, total: totalResult?.value ?? 0 };
    await cacheSet(cacheKeyString, result, 30);

    return result;
  }

  /**
   * Get all reward-related blockchain transactions for a user, each
   * verified against Stellar Horizon so the caller doesn't have to trust
   * the stored tx hash blindly. Paginated and cached for 30s — verification
   * involves a live Horizon call per transaction, so a short cache keeps
   * repeated page loads cheap without going stale for long.
   */
  async getTransactions(
    userId: string,
    page: number,
    limit: number,
  ): Promise<{ transactions: RewardTransaction[]; total: number }> {
    const namespace = "rewards";
    const cacheKeyString = cacheKey(namespace, "transactions", userId, page, limit);

    const cached = await cacheGet<{ transactions: RewardTransaction[]; total: number }>(
      namespace,
      cacheKeyString,
    );
    if (cached) return cached;

    const offset = (page - 1) * limit;
    const where = and(
      eq(quizSubmissions.userId, userId),
      sql`${quizSubmissions.txHash} IS NOT NULL`,
    );

    const [totalResult] = await db
      .select({ value: sql<number>`count(*)`.mapWith(Number) })
      .from(quizSubmissions)
      .where(where);

    const rows = await db
      .select({
        id: quizSubmissions.id,
        txHash: quizSubmissions.txHash,
        rewardAmount: quizSubmissions.rewardAmount,
        submittedAt: quizSubmissions.submittedAt,
        courseTitle: courses.title,
      })
      .from(quizSubmissions)
      .innerJoin(quizzes, eq(quizSubmissions.quizId, quizzes.id))
      .innerJoin(courses, eq(quizzes.courseId, courses.id))
      .where(where)
      .orderBy(desc(quizSubmissions.submittedAt))
      .limit(limit)
      .offset(offset);

    const transactions: RewardTransaction[] = await Promise.all(
      rows.map(async (row) => {
        const txHash = row.txHash as string;

        // A bad_seq retry marks the tx as pending indexer confirmation
        // rather than a real hash — nothing to look up on Horizon yet.
        if (txHash === "pending_indexer_confirmation") {
          return {
            id: row.id,
            courseTitle: row.courseTitle,
            amount: row.rewardAmount ?? REWARD_AMOUNT,
            txHash,
            status: "pending" as const,
            blockHeight: null,
            confirmationCount: null,
            submittedAt: row.submittedAt,
          };
        }

        const verification = await stellarClient.getHorizonTransaction(txHash);
        return {
          id: row.id,
          courseTitle: row.courseTitle,
          amount: row.rewardAmount ?? REWARD_AMOUNT,
          txHash,
          status: verification.status,
          blockHeight: verification.ledger,
          confirmationCount: verification.confirmations,
          submittedAt: row.submittedAt,
        };
      }),
    );

    const result = { transactions, total: totalResult?.value ?? 0 };
    await cacheSet(cacheKeyString, result, 30);

    return result;
  }

  /**
   * Get the top earners by total credits (leaderboard).
   * Excludes users with 0 credits, cached for 5 minutes.
   * Returns top 50 by default, max 50.
   */
  async getLeaderboard(
    limit: number = 50,
  ): Promise<{ rank: number; displayName: string; credits: number }[]> {
    const namespace = "rewards";
    const cacheKeyString = cacheKey(namespace, "leaderboard", limit);

    const cached = await cacheGet<
      { rank: number; displayName: string; credits: number }[]
    >(namespace, cacheKeyString);
    if (cached) return cached;

    // Query users with credits > 0, ordered by credits descending
    const rows = await db
      .select({
        displayName: users.displayName,
        credits: users.credits,
      })
      .from(users)
      .where(sql`${users.credits} > 0`)
      .orderBy(desc(users.credits), desc(users.createdAt))
      .limit(limit);

    // Add rank to each entry
    const leaderboard = rows.map((row, index) => ({
      rank: index + 1,
      displayName: row.displayName ?? "Anonymous",
      credits: row.credits,
    }));

    await cacheSet(cacheKeyString, leaderboard, 300); // 5 minute TTL

    return leaderboard;
  }
  async deductCredits(adminId: string, userId: string, dto: DeductCreditsDto) {
    return this.prisma.$transaction(async (tx) => {
      // 1. Fetch user to verify existence and current balance
      const user = await tx.user.findUnique({
        where: { id: userId },
        select: { id: true, credits: true },
      });

      if (!user) {
        throw new NotFoundException(`User with ID ${userId} not found`);
      }

      // 2. Validate that amount does not exceed user's balance
      if (user.credits < dto.amount) {
        throw new BadRequestException(
          `Insufficient credits. User balance (${user.credits}) is less than requested deduction amount (${dto.amount}).`,
        );
      }
}


export const rewardService = new RewardService();
