import { eq, and, desc } from "drizzle-orm";
import { db } from "../../config/database.js";
import {
  credentials,
  quizSubmissions,
  courses,
  users,
} from "../../database/schema.js";
import { NotFoundError, ForbiddenError, ConflictError } from "../../utils/errors.js";
import { withLock } from "../../utils/lock.js";
import { invokeContract } from "../../stellar/transactions.js";
import { createMintAuthorization } from "../../stellar/signatures.js";
import { config } from "../../config/index.js";
import { logger } from "../../utils/logger.js";
import crypto from "node:crypto";
import StellarSdk from "@stellar/stellar-sdk";
import type { MintResult, CredentialListItem } from "./credential.types.js";
import { auditLog } from "../../audit/index.js";
import { stellarTxDurationSeconds, credentialsMintedTotal } from "../../metrics/index.js";

export class CredentialService {
  /**
   * Mint a course completion credential (NFT) for the user.
   * Uses distributed locking + database transaction with row-level lock
   * to prevent duplicate NFT minting from concurrent requests.
   */
  async mint(
    userId: string,
    courseId: string,
    submissionId: string
  ): Promise<MintResult> {
    return withLock(`credential:${userId}:${courseId}`, async () => {
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

        if (!submission.score || submission.score < 1) {
          throw new ForbiddenError("Quiz not passed — cannot mint credential");
        }

        const [existing] = await tx
          .select()
          .from(credentials)
          .where(
            and(
              eq(credentials.userId, userId),
              eq(credentials.courseId, courseId)
            )
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

        const auth = createMintAuthorization(userId, courseId, submission.score);

        let txHash: string;
        const txStart = process.hrtime.bigint();
        try {
          txHash = await invokeContract(
            config.STELLAR_CREDENTIAL_CONTRACT_ID,
            "mint_credential",
            [
              StellarSdk.Address.fromString(user.stellarAddress).toScVal(),
              StellarSdk.nativeToScVal(nftAssetCode),
              StellarSdk.nativeToScVal(submission.score, { type: "u32" }),
              StellarSdk.nativeToScVal(Buffer.from(auth.signature, "base64")),
            ]
          );
          stellarTxDurationSeconds.observe(
            { method: "mint_credential", status: "success" },
            Number(process.hrtime.bigint() - txStart) / 1e9
          );
        } catch (err) {
          stellarTxDurationSeconds.observe(
            { method: "mint_credential", status: "error" },
            Number(process.hrtime.bigint() - txStart) / 1e9
          );
          logger.error({ err, userId, courseId }, "On-chain credential mint failed");
          throw new Error("Failed to mint credential on-chain");
        }

        const [credential] = await tx
          .insert(credentials)
          .values({
            userId,
            courseId,
            score: submission.score,
            nftAssetCode,
            nftIssuer: user.stellarAddress,
            mintTxHash: txHash,
          })
          .returning();

        credentialsMintedTotal.inc();
        auditLog("credential.minted", { credentialId: credential.id, userId, courseId, txHash });
        logger.info(
          { credentialId: credential.id, userId, courseId, txHash },
          "Credential minted"
        );

        return {
          credentialId: credential.id,
          nftAssetCode,
          nftIssuer: user.stellarAddress,
          mintTxHash: txHash,
          message: "Course completion credential minted successfully",
        };
      });
    });
  }

  /**
   * List credentials for a user.
   */
  async list(userId: string): Promise<CredentialListItem[]> {
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

    return rows;
  }
}

export const credentialService = new CredentialService();
