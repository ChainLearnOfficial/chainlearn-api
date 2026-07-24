import { eq, and, desc } from "drizzle-orm";
import { db } from "../../config/database.js";
import {
  credentials,
  quizSubmissions,
  quizzes,
  courses,
  users,
} from "../../database/schema.js";
import {
  NotFoundError,
  ForbiddenError,
  ConflictError,
} from "../../utils/errors.js";
import { withLock } from "../../utils/lock.js";
import { invokeContract } from "../../stellar/transactions.js";
import { createMintAuthorization } from "../../stellar/signatures.js";
import { config } from "../../config/index.js";
import { logger } from "../../utils/logger.js";
import crypto from "node:crypto";
import StellarSdk from "@stellar/stellar-sdk";
import type { MintResult, CredentialListItem } from "./credential.types.js";
import { auditLog } from "../../audit/index.js";
import {
  stellarTxDurationSeconds,
  credentialsMintedTotal,
} from "../../metrics/index.js";
import { cacheGet, cacheSet, cacheDel, cacheKey } from "../../cache/index.js";

export class CredentialService {
  /**
   * Mint a course completion credential (NFT) for the user.
   * Uses distributed locking + database transaction with row-level lock
   * to prevent duplicate NFT minting from concurrent requests.
   *
   * Uses two-phase approach: validate in DB tx, execute Stellar tx outside DB,
   * then update DB. This prevents holding database connections during network calls.
   */
  async mint(
    userId: string,
    courseId: string,
    submissionId: string,
  ): Promise<MintResult> {
    return withLock(`credential:${userId}:${courseId}`, async () => {
      // Phase 1: Validate in a quick DB transaction
      const mintData = await db.transaction(async (tx) => {
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

        if (!submission.score || submission.score < 1) {
          throw new ForbiddenError("Quiz not passed — cannot mint credential");
        }

        const [quiz] = await tx
          .select()
          .from(quizzes)
          .where(eq(quizzes.id, submission.quizId));

        if (!quiz || quiz.courseId !== courseId) {
          throw new ForbiddenError("Quiz submission does not belong to this course");
        }

        const questions = quiz.questions as Array<unknown> | null;
        if (!questions || questions.length === 0) {
          throw new ForbiddenError("Quiz has no questions");
        }
        const percentage = Math.round((submission.score / questions.length) * 100);
        if (percentage < 70) {
          throw new ForbiddenError(
            `Score ${percentage}% below passing threshold of 70%`,
          );
        }

        const [existing] = await tx
          .select()
          .from(credentials)
          .where(
            and(
              eq(credentials.userId, userId),
              eq(credentials.courseId, courseId),
            ),
          )
          .for("update");

        if (existing) {
          throw new ConflictError("Credential already minted for this course");
        }

        const nftAssetCode = `CL${crypto.randomBytes(4).toString("hex").toUpperCase()}`;
        const [user] = await tx
          .select()
          .from(users)
          .where(eq(users.id, userId));

        if (!user) {
          throw new NotFoundError("User");
        }

        return {
          userId,
          courseId,
          score: submission.score,
          stellarAddress: user.stellarAddress,
          nftAssetCode,
        };
      });

      // Phase 2: Execute Stellar transaction outside DB (no connection held)
      const auth = createMintAuthorization(
        userId,
        courseId,
        mintData.score,
      );

      const txStart = process.hrtime.bigint();
      let txHash: string;
      try {
        txHash = await invokeContract(
          config.STELLAR_CREDENTIAL_CONTRACT_ID,
          "mint_credential",
          [
            StellarSdk.Address.fromString(mintData.stellarAddress).toScVal(),
            StellarSdk.nativeToScVal(mintData.nftAssetCode),
            StellarSdk.nativeToScVal(mintData.score, { type: "u32" }),
            StellarSdk.nativeToScVal(Buffer.from(auth.signature, "base64")),
          ],
        );
        stellarTxDurationSeconds.observe(
          { method: "mint_credential", status: "success" },
          Number(process.hrtime.bigint() - txStart) / 1e9,
        );
      } catch (err) {
        stellarTxDurationSeconds.observe(
          { method: "mint_credential", status: "error" },
          Number(process.hrtime.bigint() - txStart) / 1e9,
        );
        logger.error(
          { err, userId, courseId },
          "On-chain credential mint failed",
        );
        throw new Error("Failed to mint credential on-chain");
      }

      // Phase 3: Update DB with result in a quick transaction
      const [credential] = await db
        .insert(credentials)
        .values({
          userId,
          courseId,
          score: mintData.score,
          nftAssetCode: mintData.nftAssetCode,
          nftIssuer: mintData.stellarAddress,
          mintTxHash: txHash,
        })
        .returning();

      credentialsMintedTotal.inc();
      auditLog("credential.minted", {
        credentialId: credential.id,
        userId,
        courseId,
        txHash,
      });
      logger.info(
        { credentialId: credential.id, userId, courseId, txHash },
        "Credential minted",
      );

      await cacheDel(cacheKey("user", "progress", userId));
      await cacheDel(cacheKey("credentials", "list", userId));

      return {
        credentialId: credential.id,
        nftAssetCode: mintData.nftAssetCode,
        nftIssuer: mintData.stellarAddress,
        mintTxHash: txHash,
        message: "Course completion credential minted successfully",
      };
    });
  }

  /**
   * List credentials for a user.
   */
  async list(userId: string): Promise<CredentialListItem[]> {
    const namespace = "credentials";
    const cacheKeyString = cacheKey(namespace, "list", userId);

    const cached = await cacheGet<CredentialListItem[]>(
      namespace,
      cacheKeyString,
    );
    if (cached) return cached;

    const rows = await db
      .select({
        id: credentials.id,
        score: credentials.score,
        nftAssetCode: credentials.nftAssetCode,
        nftIssuer: credentials.nftIssuer,
        mintTxHash: credentials.mintTxHash,
        revoked: credentials.revoked,
        mintedAt: credentials.mintedAt,
        courseTitle: courses.title,
      })
      .from(credentials)
      .innerJoin(courses, eq(credentials.courseId, courses.id))
      .where(eq(credentials.userId, userId))
      .orderBy(desc(credentials.mintedAt));

    await cacheSet(cacheKeyString, rows, 60);

    return rows;
  }
}

export const credentialService = new CredentialService();
