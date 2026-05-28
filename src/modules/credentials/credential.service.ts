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

export class CredentialService {
  /**
   * Mint a course completion credential (NFT) for the user.
   * Requires a passed quiz submission.
   */
  async mint(
    userId: string,
    courseId: string,
    submissionId: string
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

    // Generate NFT identifiers
    const nftAssetCode = `CL${crypto.randomBytes(4).toString("hex").toUpperCase()}`;
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
    } catch (err) {
      logger.error({ err, userId, courseId }, "On-chain credential mint failed");
      throw new Error("Failed to mint credential on-chain");
    }

    // Store credential in database
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
