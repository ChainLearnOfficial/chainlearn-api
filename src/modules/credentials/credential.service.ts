import { eq, and, desc } from "drizzle-orm";
import { db } from "../../config/database.js";
import {
  credentials,
  quizSubmissions,
  quizzes,
  courses,
  users,
} from "../../database/schema.js";
import { NotFoundError, ForbiddenError, ConflictError } from "../../utils/errors.js";
import { invokeContract } from "../../stellar/transactions.js";
import { createMintAuthorization } from "../../stellar/signatures.js";
import { config } from "../../config/index.js";
import { logger } from "../../utils/logger.js";
import crypto from "node:crypto";
import StellarSdk from "@stellar/stellar-sdk";
import type { MintResult, CredentialListItem } from "./credential.types.js";
import {
  deleteIdempotencyKey,
  reserveIdempotencyKey,
  storeIdempotentResponse,
  storeIdempotencyTxHash,
} from "../../middleware/idempotency.js";

export class CredentialService {
  /**
   * Mint a course completion credential (NFT) for the user.
   * Requires a passed quiz submission.
   */
  async mint(
    userId: string,
    courseId: string,
    submissionId: string,
    idempotencyKey?: string
  ): Promise<MintResult> {
    // Verify the submission exists and belongs to the user
    const submission = await db.query.quizSubmissions.findFirst({
      where: and(
        eq(quizSubmissions.id, submissionId),
        eq(quizSubmissions.userId, userId)
      ),
    });

    if (!submission) {
      throw new NotFoundError("Quiz submission");
    }

    if (!submission.score || submission.score < 1) {
      throw new ForbiddenError("Quiz not passed — cannot mint credential");
    }

    // Check if credential already exists for this user/course
    const existing = await db.query.credentials.findFirst({
      where: and(
        eq(credentials.userId, userId),
        eq(credentials.courseId, courseId)
      ),
    });

    if (existing) {
      throw new ConflictError("Credential already minted for this course");
    }

    const idempotency = idempotencyKey
      ? await reserveIdempotencyKey({
          key: idempotencyKey,
          userId,
          endpoint: "/api/credentials/mint",
          requestBody: { courseId, submissionId, idempotencyKey },
        })
      : null;

    if (idempotency?.state === "cached") {
      return idempotency.record.responseBody as MintResult;
    }

    const nftAssetCode = deriveNftAssetCode(idempotencyKey ?? `${userId}:${courseId}:${submissionId}`);

    // Generate NFT identifiers
    const user = await db.query.users.findFirst({
      where: eq(users.id, userId),
    });

    if (!user) {
      throw new NotFoundError("User");
    }

    // Create mint authorization
    const auth = createMintAuthorization(userId, courseId, submission.score);

    // Call the on-chain credential contract
    let txHash: string;
    let onChainSucceeded = false;
    try {
      if (idempotency?.state === "resume" && idempotency.record.txHash) {
        txHash = idempotency.record.txHash;
      } else {
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
        onChainSucceeded = true;
      }

      if (idempotencyKey) {
        await storeIdempotencyTxHash(idempotencyKey, txHash);
      }

      const existingCredential = await db.query.credentials.findFirst({
        where: and(
          eq(credentials.userId, userId),
          eq(credentials.courseId, courseId)
        ),
      });

      let credentialId = existingCredential?.id;
      if (!existingCredential) {
        const [credential] = await db
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

        credentialId = credential.id;
      }

      const result: MintResult = {
        credentialId: credentialId!,
        nftAssetCode,
        nftIssuer: user.stellarAddress,
        mintTxHash: txHash,
        message: "Course completion credential minted successfully",
      };

      if (idempotencyKey) {
        await storeIdempotentResponse(idempotencyKey, 201, result);
      }

      logger.info(
        { credentialId: credentialId!, userId, courseId, txHash },
        "Credential minted"
      );

      return result;
    } catch (err) {
      if (!onChainSucceeded && idempotencyKey) {
        await deleteIdempotencyKey(idempotencyKey);
      }

      logger.error({ err, userId, courseId }, "On-chain credential mint failed");
      throw new Error("Failed to mint credential on-chain");
    }
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

function deriveNftAssetCode(seed: string): string {
  const suffix = crypto
    .createHash("sha256")
    .update(seed)
    .digest("hex")
    .slice(0, 8)
    .toUpperCase();

  return `CL${suffix}`;
}

export const credentialService = new CredentialService();
