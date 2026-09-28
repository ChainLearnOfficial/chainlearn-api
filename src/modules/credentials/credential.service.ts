import { eq, and, desc, sql } from "drizzle-orm";
import { db } from "../../config/database.js";
// src/modules/credentials/credential.service.ts (Service addition)
import { Injectable, NotFoundException, BadRequestException } from '@nestjs/common';
import { PrismaService } from '../../database/prisma.service';
import * as PDFDocument from 'pdfkit';

import {
  credentials,
  enrollments,
  quizSubmissions,
  quizzes,
  courses,
  users,
  type CourseModuleDefinition,
} from "../../database/schema.js";
import { PASSING_PERCENTAGE } from "../quizzes/quiz.types.js";
import {
  NotFoundError,
  ForbiddenError,
  ConflictError,
  AppError,
} from "../../utils/errors.js";
import { withLock } from "../../utils/lock.js";
import { invokeContract } from "../../stellar/transactions.js";
import { createMintAuthorization } from "../../stellar/signatures.js";
import { config } from "../../config/index.js";
import { logger } from "../../utils/logger.js";
import crypto, { createHash } from "node:crypto";
import StellarSdk from "@stellar/stellar-sdk";
import {
  buildCertificateDownloadUrl,
  buildVerificationUrl,
} from "./certificate.js";
import { renderCompletionCertificate } from "./completion-certificate.js";
import type {
  CertificateItem,
  BatchMintResultItem,
  CompletionCertificate,
  CredentialListItem,
  MintResult,
} from "./credential.types.js";
import { auditLog } from "../../audit/index.js";
import {
  stellarTxDurationSeconds,
  credentialsMintedTotal,
} from "../../metrics/index.js";
import {
  cacheGet,
  cacheSet,
  cacheDel,
  cacheKey,
  cacheInvalidatePattern,
} from "../../cache/index.js";

/** How long a rendered completion-certificate PDF (#387) is reused. Bounded
 *  rather than permanent so a fix to the certificate layout reaches users
 *  without needing a migration. */
const COMPLETION_CERTIFICATE_TTL = 86_400;

export class CredentialService {
  /**
   * Mint a course completion credential (NFT) for the user.
   * Uses distributed locking + database transaction with row-level lock
   * to prevent duplicate NFT minting from concurrent requests.
   *
   * Uses a two-phase approach: validate and reserve the mint state in a short DB transaction,
   * execute the Stellar transaction outside the DB transaction, then persist the result.
   * This prevents holding database connections during network calls.
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
        if (percentage < PASSING_PERCENTAGE) {
          throw new ForbiddenError(
            `Score ${percentage}% below passing threshold of ${PASSING_PERCENTAGE}%`,
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
        mintData.stellarAddress,
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
      await cacheDel(cacheKey("credentials", "certificates", userId));
      await cacheInvalidatePattern(cacheKey("user", "activity", userId, "*"));

      return {
        credentialId: credential.id,
        nftAssetCode: mintData.nftAssetCode,
        nftIssuer: mintData.stellarAddress,
        mintTxHash: txHash,
        message: "Course completion credential minted successfully",
      };
    });
  }

  async batchMint(
    userId: string,
    submissions: Array<{ courseId: string; submissionId: string }>,
  ): Promise<BatchMintResultItem[]> {
    const results: BatchMintResultItem[] = [];

    for (const submission of submissions) {
      try {
        const data = await this.mint(
          userId,
          submission.courseId,
          submission.submissionId,
        );
        results.push({
          ...submission,
          success: true,
          data,
        });
      } catch (err) {
        results.push({
          ...submission,
          success: false,
          error: {
            code: err instanceof AppError ? err.code : "INTERNAL_ERROR",
            message:
              err instanceof AppError
                ? err.message
                : "Failed to mint credential",
          },
        });
      }
    }

    return results;
  }

  /**
   * The user's earned (non-revoked) certificates with verification and
   * download links, newest first (#371). Cached for 5 minutes.
   */
  async listCertificates(userId: string): Promise<CertificateItem[]> {
    const namespace = "credentials";
    const cacheKeyString = cacheKey(namespace, "certificates", userId);

    const cached = await cacheGet<CertificateItem[]>(namespace, cacheKeyString);
    if (cached) return cached;

    const rows = await db
      .select({
        credentialId: credentials.id,
        courseId: credentials.courseId,
        courseTitle: courses.title,
        score: credentials.score,
        issuedAt: credentials.mintedAt,
        nftAssetCode: credentials.nftAssetCode,
        nftIssuer: credentials.nftIssuer,
        mintTxHash: credentials.mintTxHash,
      })
      .from(credentials)
      .innerJoin(courses, eq(credentials.courseId, courses.id))
      .where(and(eq(credentials.userId, userId), eq(credentials.revoked, false)))
      .orderBy(desc(credentials.mintedAt));

    const certificates = rows.map(({ mintTxHash, ...row }) => ({
      ...row,
      verificationUrl: buildVerificationUrl(config.STELLAR_NETWORK, mintTxHash),
      downloadUrl: buildCertificateDownloadUrl(config.PUBLIC_BASE_URL, row.credentialId),
    }));

    await cacheSet(cacheKeyString, certificates, 300);

    return certificates;
  }

  /** One of the user's certificates, for the download endpoint (#371). */
  async getCertificate(userId: string, credentialId: string): Promise<CertificateItem> {
    const certificates = await this.listCertificates(userId);
    const certificate = certificates.find((c) => c.credentialId === credentialId);
    if (!certificate) {
      throw new NotFoundError("Credential");
    }
    return certificate;
  }

  /**
   * A downloadable PDF certificate for a course the user has completed
   * (#387) — the traditional certificate, separate from the on-chain NFT
   * credential.
   *
   * "Completed" means every module of the course has a non-superseded quiz
   * submission from this user — the same rule getCourseProgress and
   * getCourseModules use to compute module completion. It deliberately does
   * *not* read `enrollments.completed_at`: nothing in the codebase ever
   * writes that column, so keying off it would make this endpoint 404 for
   * every real user.
   *
   * The completion date is the timestamp of the user's most recent
   * submission on the course, which is the moment the final module was
   * completed. `enrollments.completed_at` is used when it happens to be set
   * (some data may predate this service, and a caller could set it
   * explicitly).
   *
   * The rendered PDF is cached for 24h. Regenerating it on every request
   * would mean re-running font metrics and layout for a document that
   * cannot change once the course is complete — but it is bounded rather
   * than permanent, so a fix to the certificate layout reaches users without
   * a migration.
   */
  async getCompletionCertificate(
    userId: string,
    courseId: string,
  ): Promise<CompletionCertificate> {
    const namespace = "credentials";
    const cacheKeyString = cacheKey(
      namespace,
      "completion-certificate",
      userId,
      courseId,
    );

    const cached = await cacheGet<string>(namespace, cacheKeyString);
    if (cached) {
      // Stored base64 (the cache serializes with JSON, which can't carry a
      // Buffer) and returned as bytes for the HTTP response.
      return {
        pdf: Buffer.from(cached, "base64"),
        ...(await this.describeCompletionCertificate(userId, courseId)),
        cached: true,
      };
    }

    const details = await this.describeCompletionCertificate(userId, courseId);
    const pdf = await renderCompletionCertificate({
      certificateId: details.certificateId,
      userName: details.userName,
      stellarAddress: details.stellarAddress,
      courseTitle: details.courseTitle,
      courseDifficulty: details.courseDifficulty,
      courseId: details.courseId,
      completedOn: details.completedOn,
      modulesCompleted: details.modulesCompleted,
      onChainVerificationUrl: details.onChainVerificationUrl,
    });

    await cacheSet(cacheKeyString, pdf.toString("base64"), COMPLETION_CERTIFICATE_TTL);

    return { pdf, ...details, cached: false };
  }

  /**
   * Resolve everything the certificate needs and enforce the completion
   * requirement. Split out from getCompletionCertificate so a cache hit can
   * reuse the eligibility check and the response metadata without
   * re-rendering the PDF — a hit still has to answer 404 for a user who
   * isn't eligible, and the metadata is what a client needs to name the
   * downloaded file.
   */
  private async describeCompletionCertificate(
    userId: string,
    courseId: string,
  ): Promise<Omit<CompletionCertificate, "pdf" | "cached">> {
    const course = await db.query.courses.findFirst({
      where: eq(courses.id, courseId),
    });
    if (!course) {
      throw new NotFoundError("Course");
    }

    const [user] = await db
      .select({
        displayName: users.displayName,
        stellarAddress: users.stellarAddress,
      })
      .from(users)
      .where(eq(users.id, userId));
    if (!user) {
      throw new NotFoundError("User");
    }

    // Module list, matching getCourseProgress: the authored definitions when
    // there are any, otherwise the module ids implied by existing quizzes.
    const moduleDefinitions = (course.modules ?? []) as CourseModuleDefinition[];
    let moduleIds: string[];
    if (moduleDefinitions.length > 0) {
      moduleIds = moduleDefinitions.map((m) => m.id);
    } else {
      const moduleRows = await db
        .select({ moduleId: quizzes.moduleId })
        .from(quizzes)
        .where(eq(quizzes.courseId, courseId))
        .groupBy(quizzes.moduleId);
      moduleIds = moduleRows.map((r) => r.moduleId);
    }

    // One query answers both "is every module done" and "when did they
    // finish": the per-module completion set plus the latest submission time.
    const submissionRows = moduleIds.length
      ? await db
          .select({
            moduleId: quizzes.moduleId,
            lastSubmittedAt: sql<Date>`MAX(${quizSubmissions.submittedAt})`,
          })
          .from(quizSubmissions)
          .innerJoin(quizzes, eq(quizSubmissions.quizId, quizzes.id))
          .where(
            and(
              eq(quizzes.courseId, courseId),
              eq(quizSubmissions.userId, userId),
              eq(quizSubmissions.superseded, false),
            ),
          )
          .groupBy(quizzes.moduleId)
      : [];

    const completedModuleIds = new Set(submissionRows.map((r) => r.moduleId));
    const isComplete =
      moduleIds.length > 0 && completedModuleIds.size === moduleIds.length;

    if (!isComplete) {
      // 404, not 403, per the endpoint's contract: a certificate simply does
      // not exist for a course the caller hasn't finished, and the same
      // response covers "no such course" and "not completed" so the endpoint
      // can't be used to probe which courses exist.
      throw new NotFoundError("Completion certificate");
    }

    const enrollment = await db.query.enrollments.findFirst({
      where: and(
        eq(enrollments.userId, userId),
        eq(enrollments.courseId, courseId),
      ),
    });

    const lastSubmission = submissionRows.reduce<Date | null>((latest, row) => {
      if (!latest || row.lastSubmittedAt > latest) return row.lastSubmittedAt;
      return latest;
    }, null);
    const completedAt = enrollment?.completedAt ?? lastSubmission ?? new Date();

    // A credential, if minted, gives the certificate a link to the
    // on-chain record. Optional — the PDF is valid without one.
    const [credential] = await db
      .select({ mintTxHash: credentials.mintTxHash, revoked: credentials.revoked })
      .from(credentials)
      .where(
        and(
          eq(credentials.userId, userId),
          eq(credentials.courseId, courseId),
        ),
      );

    return {
      // A certificate number the learner can quote, derived from the pair
      // rather than stored, so it's reproducible without a schema change.
      certificateId: createHash("sha256")
        .update(`${userId}:${courseId}`)
        .digest("hex")
        .slice(0, 16)
        .toUpperCase(),
      userName: user.displayName?.trim() || `Learner ${user.stellarAddress.slice(0, 6)}…`,
      stellarAddress: user.stellarAddress,
      courseId: course.id,
      courseTitle: course.title,
      courseDifficulty: course.difficulty,
      completedOn: completedAt.toISOString().slice(0, 10),
      modulesCompleted: `${completedModuleIds.size} of ${moduleIds.length}`,
      onChainVerificationUrl:
        credential && !credential.revoked
          ? buildVerificationUrl(config.STELLAR_NETWORK, credential.mintTxHash)
          : null,
    };
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



@Injectable()
export class CredentialService {
  constructor(private readonly prisma: PrismaService) {}

  async generateCompletionCertificate(userId: string, courseId: string): Promise<Buffer> {
    // 1. Verify user and course existence and check if course is completed
    const enrollment = await this.prisma.courseEnrollment.findUnique({
      where: {
        userId_courseId: { userId, courseId },
      },
      include: {
        user: { select: { name: true } },
        course: { select: { title: true } },
      },
    });

    if (!enrollment) {
      throw new NotFoundException(`Enrollment not found for user in course ${courseId}`);
    }

    if (!enrollment.completedAt) {
      throw new BadRequestException(`Course ${courseId} has not been completed by the user yet.`);
    }

    const userName = enrollment.user.name || 'Valued Learner';
    const courseTitle = enrollment.course.title;
    const completionDate = new Date(enrollment.completedAt).toLocaleDateString('en-US', {
      year: 'numeric',
      month: 'long',
      day: 'numeric',
    });

    // 2. Generate PDF Certificate using PDFKit in memory
    return new Promise((resolve, reject) => {
      const doc = new PDFDocument({
        layout: 'landscape',
        size: 'A4',
        margins: { top: 50, bottom: 50, left: 50, right: 50 },
      });

      const buffers: Buffer[] = [];
      doc.on('data', (chunk) => buffers.push(chunk));
      doc.on('end', () => resolve(Buffer.concat(buffers)));
      doc.on('error', (err) => reject(err));

      // Certificate Border & Styling
      doc.rect(20, 20, doc.page.width - 40, doc.page.height - 40).lineWidth(2).stroke('#3b82f6');
      doc.rect(28, 28, doc.page.width - 56, doc.page.height - 56).lineWidth(1).stroke('#93c5fd');

      // Header
      doc.font('Helvetica-Bold').fontSize(28).fillColor('#1e3a8a').text('CERTIFICATE OF COMPLETION', { align: 'center' });
      doc.moveDown(0.5);

      doc.font('Helvetica').fontSize(14).fillColor('#64748b').text('This is proudly presented to', { align: 'center' });
      doc.moveDown(0.75);

      // Recipient Name
      doc.font('Helvetica-Bold').fontSize(26).fillColor('#0f172a').text(userName, { align: 'center' });
      doc.moveDown(0.75);

      // Course Completion Statement
      doc.font('Helvetica').fontSize(14).fillColor('#64748b').text('for successfully completing the official curriculum and requirements for', { align: 'center' });
      doc.moveDown(0.75);

      // Course Title
      doc.font('Helvetica-Bold').fontSize(20).fillColor('#2563eb').text(courseTitle, { align: 'center' });
      doc.moveDown(1.5);

      // Footer / Date & Signatory
      const footerY = doc.y + 20;
      doc.font('Helvetica').fontSize(12.').fillColor('#475569').text(`Completed on: ${completionDate}`, 80, footerY);
      doc.text('ChainLearn Official Academy', doc.page.width - 280, footerY, { align: 'right' });

      doc.end();
    });
  }
}