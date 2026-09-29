import crypto from "node:crypto";
import { eq, and, desc, sql, isNull } from "drizzle-orm";
import { db } from "../../config/database.js";
import {
  quizzes,
  quizSubmissions,
  quizFeedback,
  enrollments,
  courses,
  moduleContent,
  type CourseModuleDefinition,
} from "../../database/schema.js";
import {
  NotFoundError,
  ForbiddenError,
  ConflictError,
  RateLimitError,
  ValidationError,
} from "../../utils/errors.js";
import { withLock } from "../../utils/lock.js";
import { createQuizProof } from "../../stellar/signatures.js";
import { logger } from "../../utils/logger.js";
import { redis } from "../../config/redis.js";
import { generateQuizFromAI } from "./ai-client.js";
import { sanitizeQuizFeedback } from "../../utils/sanitize.js";
import { auditLog } from "../../audit/index.js";
import { dispatchWebhook } from "../../services/webhook-dispatcher.js";
import { quizSubmissionsTotal } from "../../metrics/index.js";
import {
  cacheGet,
  cacheSet,
  cacheDel,
  cacheKey,
  cacheKeyPattern,
  cacheInvalidatePattern,
  cacheGetOrSet,
} from "../../cache/index.js";
import {
  PASSING_PERCENTAGE,
  MAX_RETRIES_PER_MODULE_PER_DAY,
  MAX_QUIZ_GENERATIONS_PER_MODULE_PER_HOUR,
  type GenerateQuizBody,
  type GenerateQuizBatchBody,
  type SubmitQuizBody,
  type QuizWithQuestions,
  type QuizBatchGenerateEntry,
  type QuizSubmissionResult,
  type QuizQuestion,
  type QuizStats,
  type SubmitQuizFeedbackBody,
  type QuizFeedbackEntry,
  type QuizFeedbackSummaryEntry,
  type AuthoredQuestion,
  type AdminQuiz,
  type AdminQuizDeleteResult,
  type AdminQuizUpdateBody,
  type QuizMetadata,
  type ModuleQuizHistory,
  type QuizAnalytics,
  type QuizQuestionAnalytics,
  type ScoreDistribution,
} from "./quiz.types.js";

const QUIZ_STATS_TTL_SECONDS = 300;

type GeneratedQuestion = QuizQuestion & { correctIndex: number };
type StoredQuestion = GeneratedQuestion & {
  /** Pre-shuffle bookkeeping, written by shuffleQuestions so an AI-generated
   *  quiz can be traced back to the order and options the model produced.
   *  Absent on hand-authored questions (#388) — there is no pre-shuffle
   *  state to record, and faking identity mappings would misattribute the
   *  content to the model. Nothing in src/ reads these fields. */
  originalQuestionIndex?: number;
  originalCorrectIndex?: number;
  originalOptions?: string[];
};

export class QuizService {
  /**
   * Generate a quiz for a given course/module. Calls the chainlearn-ai
   * service for fresh questions and falls back to a fixed placeholder set
   * if the service is unreachable. Existing quizzes for the same user +
   * module are returned as-is so a refresh doesn't regenerate.
   */
  async generateQuiz(
    userId: string,
    data: GenerateQuizBody
  ): Promise<QuizWithQuestions> {
    // Verify enrollment
    const enrollment = await db.query.enrollments.findFirst({
      where: and(
        eq(enrollments.userId, userId),
        eq(enrollments.courseId, data.courseId)
      ),
    });

    if (!enrollment) {
      throw new ForbiddenError("Must be enrolled in the course to take a quiz");
    }

    await this.assertGenerationAllowed(userId, data.courseId, data.moduleId);

    // Check for existing quiz for this user/module
    const existing = await db.query.quizzes.findFirst({
      where: and(
        eq(quizzes.courseId, data.courseId),
        eq(quizzes.moduleId, data.moduleId),
        eq(quizzes.generatedFor, userId),
        isNull(quizzes.archivedAt),
      ),
    });

    if (existing) {
      // Return existing quiz, strip correct answers
      const questions = existing.questions as StoredQuestion[];

      return {
        id: existing.id,
        courseId: existing.courseId,
        moduleId: existing.moduleId,
        questions: this.toClientQuestions(questions),
        createdAt: existing.createdAt,
      };
    }

    const generatedQuestions = this.shuffleQuestions(
      await this.generateQuestions(userId, {
        courseId: data.courseId,
        moduleId: data.moduleId,
        difficulty: data.difficulty ?? "beginner",
        numQuestions: data.numQuestions ?? 5,
      }),
    );

    const [quiz] = await db
      .insert(quizzes)
      .values({
        courseId: data.courseId,
        moduleId: data.moduleId,
        questions: generatedQuestions,
        generatedFor: userId,
      })
      .returning();

    logger.info(
      { quizId: quiz.id, courseId: data.courseId, moduleId: data.moduleId },
      "Quiz generated"
    );

    return {
      id: quiz.id,
      courseId: quiz.courseId,
      moduleId: quiz.moduleId,
      questions: this.toClientQuestions(generatedQuestions),
      createdAt: quiz.createdAt,
    };
  }

  /**
   * Generate quizzes for several modules of the same course in one request
   * (#308). Each module goes through the same generateQuiz path — enrollment
   * check, per-module rate limit, existing-quiz short-circuit, AI generation
   * with placeholder fallback — sequentially rather than in parallel so a
   * batch request can't fan out into a burst of concurrent AI service calls.
   * One module failing (e.g. its own per-module generation rate limit) is
   * reported in that module's entry rather than aborting the rest of the
   * batch.
   */
  async generateQuizBatch(
    userId: string,
    data: GenerateQuizBatchBody
  ): Promise<QuizBatchGenerateEntry[]> {
    const results: QuizBatchGenerateEntry[] = [];

    for (const moduleId of data.moduleIds) {
      try {
        const quiz = await this.generateQuiz(userId, {
          courseId: data.courseId,
          moduleId,
          difficulty: data.difficulty,
          numQuestions: data.numQuestions,
        });
        results.push({ moduleId, success: true, quiz });
      } catch (err) {
        logger.warn(
          { err, courseId: data.courseId, moduleId },
          "Batch quiz generation failed for module"
        );
        results.push({
          moduleId,
          success: false,
          error: err instanceof Error ? err.message : "Quiz generation failed",
        });
      }
    }

    return results;
  }

  /**
   * Submit answers for a quiz and calculate the score.
   * Uses distributed locking + database transaction with row-level lock
   * to prevent duplicate submissions from concurrent requests.
   */
  async submitQuiz(
    userId: string,
    quizId: string,
    data: SubmitQuizBody
  ): Promise<QuizSubmissionResult> {
    return withLock(`quiz:${quizId}:${userId}`, async () => {
      const result = await db.transaction(async (tx) => {
        const [quiz] = await tx
          .select()
          .from(quizzes)
          .where(eq(quizzes.id, quizId));

        if (!quiz) {
          throw new NotFoundError("Quiz");
        }

        if (quiz.archivedAt) {
          throw new ForbiddenError("This quiz has been archived");
        }

        const enrollment = await tx.query.enrollments.findFirst({
          where: and(
            eq(enrollments.userId, userId),
            eq(enrollments.courseId, quiz.courseId)
          ),
        });

        if (!enrollment) {
          throw new ForbiddenError("Must be enrolled in the course to take a quiz");
        }

        const [existingSubmission] = await tx
          .select()
          .from(quizSubmissions)
          .where(
            and(
              eq(quizSubmissions.quizId, quizId),
              eq(quizSubmissions.userId, userId)
            )
          )
          .for("update");

        if (existingSubmission) {
          throw new ConflictError("Quiz already submitted");
        }

        // Grade the quiz
        const questions = (quiz.questions ?? []) as StoredQuestion[];

        if (!questions || questions.length === 0) {
          throw new ForbiddenError("Quiz has no questions");
        }

        let correctCount = 0;
        const feedbackParts: string[] = [];

        for (const answer of data.answers) {
          const question = questions.find((q) => q.id === answer.questionId);
          if (!question) {
            logger.warn(
              { quizId, userId, questionId: answer.questionId },
              "Submitted answer references an unrecognized questionId — skipping"
            );
            continue;
          }

          // submitQuizSchema only bounds selectedIndex to a static max(20) —
          // it has no way to know this specific question's real options
          // length at request-validation time. Re-check it here against the
          // actual question so an out-of-range index (e.g. 20 on a 4-option
          // question) is treated as a distinctly-logged invalid answer
          // rather than silently scored as just "incorrect".
          if (
            answer.selectedIndex < 0 ||
            answer.selectedIndex >= question.options.length
          ) {
            logger.warn(
              {
                quizId,
                userId,
                questionId: answer.questionId,
                selectedIndex: answer.selectedIndex,
                optionsCount: question.options.length,
              },
              "Submitted selectedIndex is out of range for this question's options — treating as incorrect"
            );
            // Use custom feedback if available for incorrect answers
            const customFeedback = question.incorrectFeedback;
            feedbackParts.push(
              sanitizeQuizFeedback(
                customFeedback
                  ? `Q: "${question.text}" - Incorrect. ${customFeedback}`
                  : `Q: "${question.text}" - Incorrect. The correct answer was: "${question.options[question.correctIndex]}"`
              )
            );
            continue;
          }

          if (answer.selectedIndex === question.correctIndex) {
            correctCount++;
            // Use custom feedback if available, otherwise fall back to generic
            const customFeedback = question.correctFeedback;
            feedbackParts.push(
              sanitizeQuizFeedback(
                customFeedback
                  ? `Q: "${question.text}" - Correct! ${customFeedback}`
                  : `Q: "${question.text}" - Correct!`
              )
            );
          } else {
            // Use custom feedback if available, otherwise fall back to generic with correct answer
            const customFeedback = question.incorrectFeedback;
            feedbackParts.push(
              sanitizeQuizFeedback(
                customFeedback
                  ? `Q: "${question.text}" - Incorrect. ${customFeedback}`
                  : `Q: "${question.text}" - Incorrect. The correct answer was: "${question.options[question.correctIndex]}"`
              )
            );
          }
        }

        const totalQuestions = questions.length;
        const percentage = Math.round((correctCount / totalQuestions) * 100);
        const passed = percentage >= PASSING_PERCENTAGE;

        // Generate proof signature for reward claiming
        const proof = passed
          ? createQuizProof(userId, quizId, correctCount)
          : null;

        const [submission] = await tx
          .insert(quizSubmissions)
          .values({
            quizId,
            userId,
            answers: data.answers,
            score: correctCount,
            feedback: feedbackParts.join("\n"),
          })
          .returning();

        quizSubmissionsTotal.inc({ result: passed ? "passed" : "failed" });

        // #286: invalidate the cached modules-with-completion view for
        // this user+course now that this module's completion state has
        // changed. Redis isn't part of the Postgres transaction (same
        // reasoning as course.service.ts's enroll()), so this necessarily
        // runs after the insert rather than atomically with it; cacheDel
        // fails soft and the cache's own 60s TTL bounds any staleness if
        // it does fail.
        await cacheDel(cacheKey("user", "modules", userId, quiz.courseId));

        auditLog("quiz.submitted", {
          userId,
          submissionId: submission.id,
          score: correctCount,
          total: totalQuestions,
          passed,
        });
        logger.info(
          {
            submissionId: submission.id,
            score: correctCount,
            total: totalQuestions,
            passed,
          },
          "Quiz submitted"
        );

        return {
          id: submission.id,
          score: correctCount,
          totalQuestions,
          percentage,
          passed,
          feedback: submission.feedback ?? "",
          rewardAvailable: passed,
        };
      });

      // Quiz submissions change totalQuizScore and rewardsClaimed in the user's
      // progress, and the submission itself appears in the activity timeline.
      // Invalidate both caches so stale aggregates aren't served. Runs after
      // the transaction commits but within the distributed lock, matching the
      // pattern used by courseService.enroll().
      await Promise.allSettled([
        cacheDel(cacheKey("user", "progress", userId)),
        cacheInvalidatePattern(cacheKeyPattern("user", "activity", userId)),
      ]);

      // Dispatch webhook events for quiz submission
      try {
        await dispatchWebhook({
          id: crypto.randomUUID(),
          event: "quiz.submitted",
          timestamp: new Date(),
          data: {
            userId,
            quizId,
            submissionId: result.id,
            score: result.score,
            totalQuestions: result.totalQuestions,
            passed: result.passed,
          },
        });

        if (result.passed) {
          await dispatchWebhook({
            id: crypto.randomUUID(),
            event: "quiz.passed",
            timestamp: new Date(),
            data: {
              userId,
              quizId,
              submissionId: result.id,
              score: result.score,
              totalQuestions: result.totalQuestions,
            },
          });
        } else {
          await dispatchWebhook({
            id: crypto.randomUUID(),
            event: "quiz.failed",
            timestamp: new Date(),
            data: {
              userId,
              quizId,
              submissionId: result.id,
              score: result.score,
              totalQuestions: result.totalQuestions,
            },
          });
        }
      } catch (err) {
        logger.error({ err, userId, quizId }, "Failed to dispatch quiz webhook");
        // Don't fail the submission if webhook dispatch fails
      }

      return result;
    });
  }

  /**
   * Retake a quiz the user has already submitted (#295). The previous
   * submission is kept but marked `superseded` (never deleted) and a brand
   * new quiz row with fresh AI-generated questions is created for the same
   * course/module. Limited to MAX_RETRIES_PER_MODULE_PER_DAY per user per
   * module per calendar day.
   */
  async retryQuiz(userId: string, quizId: string): Promise<QuizWithQuestions> {
    return withLock(`quiz-retry:${quizId}:${userId}`, async () => {
      const [quiz] = await db
        .select()
        .from(quizzes)
        .where(eq(quizzes.id, quizId));

      if (!quiz) {
        throw new NotFoundError("Quiz");
      }

      const enrollment = await db.query.enrollments.findFirst({
        where: and(
          eq(enrollments.userId, userId),
          eq(enrollments.courseId, quiz.courseId)
        ),
      });

      if (!enrollment) {
        throw new ForbiddenError("Must be enrolled in the course to retry a quiz");
      }

      const [submission] = await db
        .select()
        .from(quizSubmissions)
        .where(
          and(
            eq(quizSubmissions.quizId, quizId),
            eq(quizSubmissions.userId, userId)
          )
        );

      if (!submission) {
        throw new ForbiddenError("Quiz must be submitted before it can be retried");
      }

      await this.assertRetryAllowed(userId, quiz.courseId, quiz.moduleId);

      const generatedQuestions = this.shuffleQuestions(
        await this.generateQuestions(userId, {
          courseId: quiz.courseId,
          moduleId: quiz.moduleId,
        }),
      );

      const [newQuiz] = await db
        .insert(quizzes)
        .values({
          courseId: quiz.courseId,
          moduleId: quiz.moduleId,
          questions: generatedQuestions,
          generatedFor: userId,
        })
        .returning();

      if (!submission.superseded) {
        await db
          .update(quizSubmissions)
          .set({ superseded: true })
          .where(eq(quizSubmissions.id, submission.id));

        // #286: the module this quiz belongs to just went from completed
        // back to incomplete (its only submission is now superseded) —
        // invalidate the cached modules-with-completion view so callers
        // don't see stale `completed: true` until the 60s TTL expires.
        await cacheDel(cacheKey("user", "modules", userId, quiz.courseId));
      }

      auditLog("quiz.retried", {
        userId,
        courseId: quiz.courseId,
        moduleId: quiz.moduleId,
        submissionId: submission.id,
      });
      logger.info(
        {
          previousQuizId: quizId,
          newQuizId: newQuiz.id,
          courseId: quiz.courseId,
          moduleId: quiz.moduleId,
        },
        "Quiz retried"
      );

      return {
        id: newQuiz.id,
        courseId: newQuiz.courseId,
        moduleId: newQuiz.moduleId,
        questions: this.toClientQuestions(generatedQuestions),
        createdAt: newQuiz.createdAt,
      };
    });
  }

  /**
   * Enforces MAX_QUIZ_GENERATIONS_PER_MODULE_PER_HOUR using a Redis counter
   * keyed per user/course/module with a rolling one-hour TTL, mirroring
   * assertRetryAllowed's pattern below (#291). Keying on
   * user+course+module (not just user) means the limit is scoped per
   * module — a user working through many modules isn't penalized by a
   * shared global counter, but hammering generateQuiz for one module is
   * capped independently of activity on any other module.
   */
  private async assertGenerationAllowed(
    userId: string,
    courseId: string,
    moduleId: string
  ): Promise<void> {
    const key = `chainlearn:quiz:generate-count:${userId}:${courseId}:${moduleId}`;
    const windowSeconds = 60 * 60;

    let count: number;
    try {
      count = await redis.incr(key);
      if (count === 1) {
        // First generation of the window for this module — start the TTL.
        await redis.expire(key, windowSeconds);
      }
    } catch (err) {
      // Redis unavailable: fail open rather than blocking generation
      // entirely, consistent with assertRetryAllowed's degrade-on-Redis-
      // outage behavior.
      logger.error({ err, userId, courseId, moduleId }, "Generation-count check failed, proceeding without rate limit");
      return;
    }

    if (count > MAX_QUIZ_GENERATIONS_PER_MODULE_PER_HOUR) {
      let retryAfterSeconds = windowSeconds;
      try {
        const ttl = await redis.ttl(key);
        if (ttl > 0) {
          retryAfterSeconds = ttl;
        }
      } catch (err) {
        // Fall back to the full window if TTL can't be read — still a
        // correct (if conservative) Retry-After value.
        logger.warn({ err, userId, courseId, moduleId }, "Failed to read generation-count TTL for Retry-After");
      }

      throw new RateLimitError(
        `Maximum ${MAX_QUIZ_GENERATIONS_PER_MODULE_PER_HOUR} quiz generations per module per hour reached`,
        retryAfterSeconds
      );
    }
  }

  /**
   * Enforces MAX_RETRIES_PER_MODULE_PER_DAY using a Redis counter keyed per
   * user/course/module/day. A dedicated counter (rather than counting rows
   * in `quizzes`) means the limit reflects retry *calls* specifically,
   * independent of when the original quiz happened to be generated.
   */
  private async assertRetryAllowed(
    userId: string,
    courseId: string,
    moduleId: string
  ): Promise<void> {
    const today = new Date().toISOString().slice(0, 10);
    const key = `chainlearn:quiz:retry-count:${userId}:${courseId}:${moduleId}:${today}`;

    let count: number;
    try {
      count = await redis.incr(key);
      if (count === 1) {
        // First retry of the day for this module — expire at day's end.
        await redis.expire(key, 60 * 60 * 24);
      }
    } catch (err) {
      // Redis unavailable: fail open rather than blocking retries entirely,
      // consistent with withLock's degrade-on-Redis-outage behavior.
      logger.error({ err, userId, courseId, moduleId }, "Retry-count check failed, proceeding without rate limit");
      return;
    }

    if (count > MAX_RETRIES_PER_MODULE_PER_DAY) {
      throw new RateLimitError(
        `Maximum ${MAX_RETRIES_PER_MODULE_PER_DAY} quiz retries per module per day reached`
      );
    }
  }

  /**
   * Shared AI-generation path used by both generateQuiz and retryQuiz.
   * Falls back to the fixed placeholder set if the AI service is
   * unreachable or returns no valid questions, so quiz creation never
   * hard-fails on a transient AI outage.
   */
  private async generateQuestions(
    userId: string,
    params: {
      courseId: string;
      moduleId: string;
      difficulty?: "beginner" | "intermediate" | "advanced";
      numQuestions?: number;
    }
  ): Promise<GeneratedQuestion[]> {
    try {
      const aiQuestions = await generateQuizFromAI({
        userId,
        courseId: params.courseId,
        moduleId: params.moduleId,
        difficulty: params.difficulty ?? "beginner",
        numQuestions: params.numQuestions ?? 5,
      });
      if (!Array.isArray(aiQuestions)) {
        throw new Error("AI service returned non-array questions");
      }

      const validQuestions = aiQuestions.filter((q) => {
        const hasPrompt =
          typeof q?.prompt === "string" && q.prompt.trim().length > 0;
        const hasOptions = Array.isArray(q?.options) && q.options.length > 0;
        const hasValidIndex =
          typeof q?.correct_index === "number" &&
          Number.isInteger(q.correct_index) &&
          q.correct_index >= 0 &&
          q.correct_index < (q.options?.length ?? 0);

        const isValid = hasPrompt && hasOptions && hasValidIndex;
        if (!isValid) {
          logger.warn({ question: q }, "Invalid AI-generated question skipped");
        }
        return isValid;
      });

      if (validQuestions.length === 0) {
        throw new Error("AI service returned no valid questions");
      }

      return validQuestions.map((q, i) => ({
        id: `q${i + 1}`,
        text: q.prompt,
        options: q.options,
        correctIndex: q.correct_index,
      }));
    } catch (err) {
      logger.warn(
        { err },
        "AI service unavailable, falling back to placeholder questions"
      );
      return this.createPlaceholderQuestions(params.courseId, params.moduleId);
    }
  }

  /**
   * Aggregate quiz statistics (#307): average score, pass rate, total
   * submissions, and a per-course submission breakdown. Superseded
   * submissions (from #295 retries) are excluded so a retried quiz's stale
   * attempt doesn't double-count. `score` is stored as a raw correct-answer
   * count, not a percentage, so each row is normalized against its own
   * quiz's question count before averaging — quizzes can have different
   * numbers of questions (numQuestions: 1-20).
   */
  async getQuizStats(courseId?: string): Promise<QuizStats> {
    const namespace = "quizzes";
    const cacheKeyString = cacheKey(namespace, "stats", courseId ?? "all");

    const cached = await cacheGet<QuizStats>(namespace, cacheKeyString);
    if (cached) return cached;

    const conditions = [eq(quizSubmissions.superseded, false)];
    if (courseId) {
      conditions.push(eq(quizzes.courseId, courseId));
    }

    const rows = await db
      .select({
        score: quizSubmissions.score,
        courseId: quizzes.courseId,
        questions: quizzes.questions,
      })
      .from(quizSubmissions)
      .innerJoin(quizzes, eq(quizSubmissions.quizId, quizzes.id))
      .where(and(...conditions));

    let percentageSum = 0;
    let passCount = 0;
    const submissionsPerCourse: Record<string, number> = {};

    for (const row of rows) {
      const totalQuestions = Array.isArray(row.questions)
        ? row.questions.length
        : 0;
      const percentage =
        totalQuestions > 0 && row.score != null
          ? Math.round((row.score / totalQuestions) * 100)
          : 0;

      percentageSum += percentage;
      if (percentage >= PASSING_PERCENTAGE) passCount++;
      submissionsPerCourse[row.courseId] =
        (submissionsPerCourse[row.courseId] ?? 0) + 1;
    }

    const totalSubmissions = rows.length;
    const stats: QuizStats = {
      averageScore:
        totalSubmissions > 0 ? Math.round(percentageSum / totalSubmissions) : 0,
      passRate:
        totalSubmissions > 0
          ? Math.round((passCount / totalSubmissions) * 100)
          : 0,
      totalSubmissions,
      submissionsPerCourse,
    };

    await cacheSet(cacheKeyString, stats, QUIZ_STATS_TTL_SECONDS);

    return stats;
  }

  /**
   * Submit feedback on a specific quiz question (#331): "this question is
   * unclear", "wrong answer marked as correct", or something else.
   *
   * One submission per (quiz, question, user) — a second attempt is
   * rejected with a ConflictError rather than overwriting the first, so a
   * question's feedback count reflects distinct reporters.
   */
  async submitFeedback(
    userId: string,
    quizId: string,
    data: SubmitQuizFeedbackBody,
  ): Promise<QuizFeedbackEntry> {
    const quiz = await db.query.quizzes.findFirst({
      where: eq(quizzes.id, quizId),
    });
    if (!quiz) {
      throw new NotFoundError("Quiz");
    }

    const questions = (quiz.questions ?? []) as StoredQuestion[];
    if (!questions.some((q) => q.id === data.questionId)) {
      throw new NotFoundError("Question");
    }

    const existing = await db.query.quizFeedback.findFirst({
      where: and(
        eq(quizFeedback.quizId, quizId),
        eq(quizFeedback.questionId, data.questionId),
        eq(quizFeedback.userId, userId),
      ),
    });
    if (existing) {
      throw new ConflictError("Feedback already submitted for this question");
    }

    try {
      const [row] = await db
        .insert(quizFeedback)
        .values({
          quizId,
          questionId: data.questionId,
          userId,
          type: data.type,
          comment: data.comment ?? null,
        })
        .returning();

      await auditLog("quiz.feedback.submitted", {
        userId,
        courseId: quiz.courseId,
      });

      return row as QuizFeedbackEntry;
    } catch (err) {
      const code = (err as { code?: string }).code;
      // 23505 = unique_violation — a concurrent submission for the same
      // (quiz, question, user) beat this one to the pre-check above.
      if (code === "23505") {
        throw new ConflictError("Feedback already submitted for this question");
      }
      throw err;
    }
  }

  /**
   * Per-question feedback counts for a quiz, for admins reviewing which
   * questions need work (#331).
   */
  async getFeedbackSummary(
    quizId: string,
    questionId?: string,
  ): Promise<QuizFeedbackSummaryEntry[]> {
    const quiz = await db.query.quizzes.findFirst({
      where: eq(quizzes.id, quizId),
    });
    if (!quiz) {
      throw new NotFoundError("Quiz");
    }

    const conditions = [eq(quizFeedback.quizId, quizId)];
    if (questionId) {
      conditions.push(eq(quizFeedback.questionId, questionId));
    }

    const rows = await db
      .select({
        questionId: quizFeedback.questionId,
        type: quizFeedback.type,
      })
      .from(quizFeedback)
      .where(and(...conditions));

    const byQuestion = new Map<string, QuizFeedbackSummaryEntry>();
    for (const row of rows) {
      let entry = byQuestion.get(row.questionId);
      if (!entry) {
        entry = {
          questionId: row.questionId,
          total: 0,
          counts: { unclear: 0, wrong: 0, other: 0 },
        };
        byQuestion.set(row.questionId, entry);
      }
      entry.total++;
      entry.counts[row.type as QuizFeedbackEntry["type"]]++;
    }

    return Array.from(byQuestion.values());
  }

  // ─── Admin: Manual Quiz Authoring (#388) ─────────────────────────────────

  /**
   * Verify the course exists and that `moduleId` is a module a learner can
   * actually reach.
   *
   * The check is conditional on the course having module definitions at
   * all. A course authored only through the legacy `courseModules` field has
   * no `modules` array to match against, and rejecting every moduleId there
   * would make the endpoint unusable for those courses. When definitions do
   * exist, the match is enforced: a quiz whose moduleId isn't one of them is
   * content no learner can open, and it would also silently fail
   * CourseService's publish check, which counts quizzes by module.
   */
  private async assertModuleBelongsToCourse(
    courseId: string,
    moduleId: string,
  ): Promise<void> {
    const course = await db.query.courses.findFirst({
      where: eq(courses.id, courseId),
    });
    if (!course) {
      throw new NotFoundError("Course");
    }

    const modules = (course.modules ?? []) as CourseModuleDefinition[];
    if (modules.length === 0) return;

    if (!modules.some((module) => module.id === moduleId)) {
      throw new ValidationError({
        moduleId: [
          `Module "${moduleId}" is not one of this course's modules. Create the module first, or use one of: ${modules
            .map((module) => module.id)
            .join(", ")}`,
        ],
      });
    }
  }

  /**
   * Invalidate everything a course's set of quizzes feeds into.
   *
   * Course-wide keys are dropped exactly. The one view deliberately left
   * alone is `user:modules:<userId>:<courseId>` (the per-user module list
   * with completion status): it's keyed by user first, so clearing it would
   * mean fanning a SCAN or a per-enrollee write over the whole roster for
   * every authoring change. Its own 60s TTL bounds the staleness — the same
   * tradeoff QuizService.submitQuiz already makes for a submission.
   *
   * Also clears getModuleQuizHistory's (#415) and getQuizAnalytics's (#417)
   * 5-minute caches course-wide via pattern match, since a write here
   * (archiving via #416 in particular) changes which submissions count
   * toward both views and which quizzes are even eligible.
   */
  private async invalidateQuizCaches(courseId: string): Promise<void> {
    const invalidations = await Promise.allSettled([
      // Both the course-scoped and the all-courses aggregate.
      cacheInvalidatePattern(cacheKeyPattern("quizzes", "stats")),
      // Enrollment status derives its module list from quizzes.
      cacheInvalidatePattern(cacheKeyPattern("user", "enrollment-status")),
      cacheDel(cacheKey("courses", "detail", courseId)),
      // #415/#417: module-history and per-quiz analytics aggregates.
      cacheInvalidatePattern(cacheKeyPattern("quizzes", "module-history")),
      cacheInvalidatePattern(cacheKeyPattern("quizzes", "analytics")),
    ]);
    const failed = invalidations.filter((r) => r.status === "rejected");
    if (failed.length > 0) {
      logger.warn(
        { courseId, failedCount: failed.length },
        "Post-quiz-write cache invalidation had failures — affected views may serve stale data until their TTL expires",
      );
    }
  }

  /**
   * Every quiz on a course module, newest first, for the admin authoring UI
   * (#388). Includes `correctIndex` and the submission count, neither of
   * which learner-facing endpoints expose.
   */
  async listModuleQuizzes(
    courseId: string,
    moduleId: string,
  ): Promise<AdminQuiz[]> {
    await this.assertModuleBelongsToCourse(courseId, moduleId);

    const rows = await db
      .select({
        id: quizzes.id,
        courseId: quizzes.courseId,
        moduleId: quizzes.moduleId,
        questions: quizzes.questions,
        generatedFor: quizzes.generatedFor,
        archivedAt: quizzes.archivedAt,
        metadata: quizzes.metadata,
        createdAt: quizzes.createdAt,
        submissionCount: sql<number>`(
          SELECT count(*)::int FROM ${quizSubmissions}
          WHERE ${quizSubmissions.quizId} = ${quizzes.id}
        )`,
      })
      .from(quizzes)
      .where(and(eq(quizzes.courseId, courseId), eq(quizzes.moduleId, moduleId)))
      .orderBy(desc(quizzes.createdAt));

    return rows.map((row) => this.toAdminQuiz(row));
  }

  private toAdminQuiz(row: {
    id: string;
    courseId: string;
    moduleId: string;
    questions: unknown;
    generatedFor: string | null;
    archivedAt?: Date | null;
    metadata?: QuizMetadata | null;
    createdAt: Date;
    submissionCount: number;
  }): AdminQuiz {
    const questions = (Array.isArray(row.questions) ? row.questions : []) as StoredQuestion[];
    return {
      id: row.id,
      courseId: row.courseId,
      moduleId: row.moduleId,
      questions: questions.map((question) => ({
        id: question.id,
        text: question.text,
        options: question.options ?? [],
        correctIndex: question.correctIndex,
        ...(question.correctFeedback && {
          correctFeedback: question.correctFeedback,
        }),
        ...(question.incorrectFeedback && {
          incorrectFeedback: question.incorrectFeedback,
        }),
      })),
      questionCount: questions.length,
      generatedFor: row.generatedFor,
      submissionCount: row.submissionCount,
      archivedAt: row.archivedAt ?? null,
      metadata: row.metadata ?? {},
      createdAt: row.createdAt,
    };
  }

  /**
   * Create a hand-authored quiz for a course module (#388).
   *
   * `generatedFor` is deliberately left null. AI quizzes are per-learner
   * (`generateQuiz` looks for an existing quiz matching course + module +
   * user), so a quiz with a user attached belongs to that one learner. An
   * admin-authored quiz has no such owner and is course-wide content.
   *
   * Questions are stored in the author's order without shuffling. Shuffling
   * exists to stop a learner pattern-matching an AI-generated set; for
   * hand-written content the order is usually meaningful (a walkthrough, a
   * difficulty ramp) and an admin editing a specific question expects to
   * find it where they put it.
   */
  async createModuleQuiz(
    courseId: string,
    moduleId: string,
    questions: AuthoredQuestion[],
  ): Promise<AdminQuiz> {
    await this.assertModuleBelongsToCourse(courseId, moduleId);

    const [quiz] = await db
      .insert(quizzes)
      .values({ courseId, moduleId, questions })
      .returning();

    await this.invalidateQuizCaches(courseId);
    await auditLog("course.quiz.created", {
      courseId,
      moduleId,
      quizId: quiz.id,
      questionCount: questions.length,
    });
    logger.info(
      { courseId, moduleId, quizId: quiz.id, questionCount: questions.length },
      "Quiz created by admin",
    );

    return this.toAdminQuiz({
      id: quiz.id,
      courseId: quiz.courseId,
      moduleId: quiz.moduleId,
      questions: quiz.questions,
      generatedFor: quiz.generatedFor,
      archivedAt: quiz.archivedAt,
      metadata: quiz.metadata ?? {},
      createdAt: quiz.createdAt,
      submissionCount: 0,
    });
  }

  /**
   * Replace a quiz's questions with a hand-authored set (#388).
   *
   * The `questions` body is a full replacement, not a patch — sending
   * `questions` replaces the array wholesale. Partial edits are what the
   * alternative would be for, and this keeps the stored document consistent
   * with what's validated.
   *
   * This rewrites a quiz learners may already have answered. Existing
   * submissions keep their recorded score (it's a stored integer, not
   * recomputed), but a submission made against the old questions can no
   * longer be explained by the questions now on the quiz. The audit log
   * records the before/after question counts for exactly that reason.
   */
  async updateModuleQuiz(
    courseId: string,
    moduleId: string,
    quizId: string,
    questions: AuthoredQuestion[],
  ): Promise<AdminQuiz> {
    await this.assertModuleBelongsToCourse(courseId, moduleId);
    const existing = await this.assertQuizInModule(courseId, moduleId, quizId);

    const [updated] = await db
      .update(quizzes)
      .set({ questions })
      .where(eq(quizzes.id, existing.id))
      .returning();

    await this.invalidateQuizCaches(courseId);
    await auditLog("course.quiz.updated", {
      courseId,
      moduleId,
      quizId: existing.id,
      questionCount: questions.length,
    });
    logger.info(
      {
        courseId,
        moduleId,
        quizId: existing.id,
        previousQuestionCount: (existing.questions as unknown[]).length,
        questionCount: questions.length,
      },
      "Quiz updated by admin",
    );

    const submissionCount = await this.countSubmissions(existing.id);
    return this.toAdminQuiz({
      id: updated.id,
      courseId: updated.courseId,
      moduleId: updated.moduleId,
      questions: updated.questions,
      generatedFor: updated.generatedFor,
      archivedAt: updated.archivedAt,
      metadata: (updated.metadata ?? {}) as QuizMetadata,
      createdAt: updated.createdAt,
      submissionCount,
    });
  }

  /**
   * Update an existing quiz in one transaction (#413): replace its questions,
   * merge metadata, and/or archive it. New questions are validated before
   * this runs. Archiving hides the quiz from learners without deleting
   * submissions.
   */
  async updateModuleQuizDetails(
    courseId: string,
    moduleId: string,
    quizId: string,
    body: AdminQuizUpdateBody,
  ): Promise<AdminQuiz> {
    await this.assertModuleBelongsToCourse(courseId, moduleId);

    const updated = await db.transaction(async (tx) => {
      const [existing] = await tx
        .select()
        .from(quizzes)
        .where(eq(quizzes.id, quizId))
        .for("update");

      if (
        !existing ||
        existing.courseId !== courseId ||
        existing.moduleId !== moduleId
      ) {
        throw new NotFoundError("Quiz");
      }

      const currentMetadata = (existing.metadata ?? {}) as QuizMetadata;
      const metadata = body.metadata
        ? { ...currentMetadata, ...body.metadata }
        : currentMetadata;

      let archivedAt = existing.archivedAt;
      if (body.archived === true) {
        archivedAt = existing.archivedAt ?? new Date();
      } else if (body.archived === false) {
        archivedAt = null;
      }

      const [row] = await tx
        .update(quizzes)
        .set({
          ...(body.questions ? { questions: body.questions } : {}),
          ...(body.metadata ? { metadata } : {}),
          ...(body.archived !== undefined ? { archivedAt } : {}),
        })
        .where(eq(quizzes.id, existing.id))
        .returning();

      return row;
    });

    const changes: string[] = [];
    if (body.questions) changes.push("questions");
    if (body.metadata) changes.push("metadata");
    if (body.archived !== undefined) changes.push("archived");

    await this.invalidateQuizCaches(courseId);
    await auditLog("course.quiz.updated", {
      courseId,
      moduleId,
      quizId: updated.id,
      questionCount: Array.isArray(updated.questions)
        ? updated.questions.length
        : 0,
      changes,
    });
    logger.info(
      { courseId, moduleId, quizId: updated.id, changes },
      "Quiz updated by admin",
    );

    const submissionCount = await this.countSubmissions(updated.id);
    return this.toAdminQuiz({
      id: updated.id,
      courseId: updated.courseId,
      moduleId: updated.moduleId,
      questions: updated.questions,
      generatedFor: updated.generatedFor,
      archivedAt: updated.archivedAt,
      metadata: (updated.metadata ?? {}) as QuizMetadata,
      createdAt: updated.createdAt,
      submissionCount,
    });
  }

  /**
   * Append one validated question to a quiz (#411). The questions JSONB
   * array is rewritten inside a row lock so two adds cannot drop each
   * other. Archived quizzes are rejected — unarchive first.
   */
  async addModuleQuizQuestion(
    courseId: string,
    moduleId: string,
    quizId: string,
    question: AuthoredQuestion,
  ): Promise<AdminQuiz> {
    await this.assertModuleBelongsToCourse(courseId, moduleId);

    const updated = await db.transaction(async (tx) => {
      const [existing] = await tx
        .select()
        .from(quizzes)
        .where(eq(quizzes.id, quizId))
        .for("update");

      if (
        !existing ||
        existing.courseId !== courseId ||
        existing.moduleId !== moduleId
      ) {
        throw new NotFoundError("Quiz");
      }

      if (existing.archivedAt) {
        throw new ValidationError({
          quizId: [
            "Archived quizzes cannot accept new questions. Unarchive the quiz first.",
          ],
        });
      }

      const questions = (
        Array.isArray(existing.questions) ? existing.questions : []
      ) as StoredQuestion[];

      if (questions.some((existingQuestion) => existingQuestion.id === question.id)) {
        throw new ConflictError(
          `Question id "${question.id}" already exists on this quiz`,
        );
      }

      if (questions.length >= 50) {
        throw new ValidationError({
          questions: ["A quiz can have at most 50 questions"],
        });
      }

      const [row] = await tx
        .update(quizzes)
        .set({ questions: [...questions, question] })
        .where(eq(quizzes.id, existing.id))
        .returning();

      return row;
    });

    await this.invalidateQuizCaches(courseId);
    await auditLog("course.quiz.question.added", {
      courseId,
      moduleId,
      quizId: updated.id,
      questionCount: Array.isArray(updated.questions)
        ? updated.questions.length
        : 0,
    });
    logger.info(
      { courseId, moduleId, quizId: updated.id, questionId: question.id },
      "Question added to quiz by admin",
    );

    const submissionCount = await this.countSubmissions(updated.id);
    return this.toAdminQuiz({
      id: updated.id,
      courseId: updated.courseId,
      moduleId: updated.moduleId,
      questions: updated.questions,
      generatedFor: updated.generatedFor,
      archivedAt: updated.archivedAt,
      metadata: (updated.metadata ?? {}) as QuizMetadata,
      createdAt: updated.createdAt,
      submissionCount,
    });
  }

  /**
   * Delete a quiz, every submission against it, and any module content
   * item that points at it (#414, #388).
   *
   * Submissions are removed in the same transaction as the quiz row so a
   * failure cannot leave an orphaned submission or a quiz whose history
   * was already wiped. Reward history is read from quiz_submissions, so
   * the counts of what went with the quiz are returned and audit-logged.
   */
  async deleteModuleQuiz(
    courseId: string,
    moduleId: string,
    quizId: string,
  ): Promise<AdminQuizDeleteResult> {
    await this.assertModuleBelongsToCourse(courseId, moduleId);

    const deleted = await db.transaction(async (tx) => {
      const [existing] = await tx
        .select()
        .from(quizzes)
        .where(eq(quizzes.id, quizId))
        .for("update");

      if (
        !existing ||
        existing.courseId !== courseId ||
        existing.moduleId !== moduleId
      ) {
        throw new NotFoundError("Quiz");
      }

      const removedSubmissions = await tx
        .delete(quizSubmissions)
        .where(eq(quizSubmissions.quizId, existing.id))
        .returning({ rewardClaimed: quizSubmissions.rewardClaimed });

      // Module content of type "quiz" can reference this row by id. Drop
      // those items in the same transaction so the quiz is gone from the
      // module, not only from the quizzes table.
      await tx
        .delete(moduleContent)
        .where(
          and(
            eq(moduleContent.courseId, courseId),
            eq(moduleContent.moduleId, moduleId),
            sql`${moduleContent.content}->>'quizId' = ${existing.id}`,
          ),
        );

      await tx.delete(quizzes).where(eq(quizzes.id, existing.id));

      return {
        quiz: existing,
        submissionsDeleted: removedSubmissions.length,
        claimedRewardsDeleted: removedSubmissions.filter(
          (row) => row.rewardClaimed,
        ).length,
      };
    });

    await this.invalidateQuizCaches(courseId);
    await auditLog("course.quiz.deleted", {
      courseId,
      moduleId,
      quizId: deleted.quiz.id,
      questionCount: Array.isArray(deleted.quiz.questions)
        ? deleted.quiz.questions.length
        : 0,
      submissionsDeleted: deleted.submissionsDeleted,
      claimedRewardsDeleted: deleted.claimedRewardsDeleted,
    });
    logger.info(
      {
        courseId,
        moduleId,
        quizId: deleted.quiz.id,
        submissionsDeleted: deleted.submissionsDeleted,
      },
      "Quiz deleted by admin",
    );

    return {
      quizId: deleted.quiz.id,
      courseId,
      moduleId,
      submissionsDeleted: deleted.submissionsDeleted,
      claimedRewardsDeleted: deleted.claimedRewardsDeleted,
      deletedAt: new Date(),
    };
  }

  private async countSubmissions(quizId: string): Promise<number> {
    const [row] = await db
      .select({ value: sql<number>`count(*)::int` })
      .from(quizSubmissions)
      .where(eq(quizSubmissions.quizId, quizId));
    return row?.value ?? 0;
  }

  /**
   * Archive or unarchive a quiz via a dedicated endpoint (#416).
   *
   * This is a thin wrapper over updateModuleQuizDetails (#413) rather than
   * new logic: archiving is already atomic (single UPDATE inside a row
   * lock), already hides the quiz from learners (isNull(quizzes.archivedAt)
   * filters in generateQuiz/submitQuiz), already preserves submissions
   * (nothing is deleted), and already audit-logs via "course.quiz.updated"
   * with changes: ["archived"]. #416 asks for the action to live at its own
   * URL (POST .../quizzes/:quizId/archive) for discoverability — an admin
   * client shouldn't need to know a generic update endpoint doubles as an
   * archive action — but the underlying write is intentionally the same
   * code path so there is exactly one place that knows how to archive a
   * quiz.
   */
  async archiveModuleQuiz(
    courseId: string,
    moduleId: string,
    quizId: string,
    archived: boolean,
  ): Promise<AdminQuiz> {
    return this.updateModuleQuizDetails(courseId, moduleId, quizId, {
      archived,
    });
  }

  /**
   * Aggregate quiz stats across every quiz in a course module (#415):
   * average score, pass rate, total attempts, and a score distribution.
   * Cached for 5 minutes, keyed by courseId+moduleId so different modules
   * don't collide (mirrors getQuizStats's cache-aside pattern above).
   *
   * Scoped to this module's quizzes specifically (unlike getQuizStats,
   * which is course- or platform-wide) — a course creator reviewing one
   * module's difficulty shouldn't have other modules' scores mixed in.
   * Superseded submissions (#295 retries) are excluded for the same reason
   * getQuizStats excludes them: a retried quiz's stale attempt would
   * otherwise double-count against the same learner's real result.
   */
  async getModuleQuizHistory(
    courseId: string,
    moduleId: string,
  ): Promise<ModuleQuizHistory> {
    await this.assertModuleBelongsToCourse(courseId, moduleId);

    const cacheKeyString = cacheKey(
      "quizzes",
      "module-history",
      courseId,
      moduleId,
    );

    return cacheGetOrSet(
      "quizzes",
      cacheKeyString,
      async () => {
        const rows = await db
          .select({
            score: quizSubmissions.score,
            questions: quizzes.questions,
            quizId: quizzes.id,
          })
          .from(quizSubmissions)
          .innerJoin(quizzes, eq(quizSubmissions.quizId, quizzes.id))
          .where(
            and(
              eq(quizzes.courseId, courseId),
              eq(quizzes.moduleId, moduleId),
              eq(quizSubmissions.superseded, false),
            ),
          );

        const percentages = rows.map((row) => {
          const totalQuestions = Array.isArray(row.questions)
            ? row.questions.length
            : 0;
          return totalQuestions > 0 && row.score != null
            ? Math.round((row.score / totalQuestions) * 100)
            : 0;
        });

        const quizIds = new Set(rows.map((row) => row.quizId));
        const passCount = percentages.filter(
          (p) => p >= PASSING_PERCENTAGE,
        ).length;
        const totalAttempts = percentages.length;

        return {
          courseId,
          moduleId,
          quizCount: quizIds.size,
          totalAttempts,
          averageScore:
            totalAttempts > 0
              ? Math.round(
                  percentages.reduce((sum, p) => sum + p, 0) / totalAttempts,
                )
              : 0,
          passRate:
            totalAttempts > 0
              ? Math.round((passCount / totalAttempts) * 100)
              : 0,
          scoreDistribution: this.buildScoreDistribution(percentages),
        };
      },
      QUIZ_STATS_TTL_SECONDS,
    );
  }

  /**
   * Detailed analytics for one specific quiz (#417): question-by-question
   * correct rate and most common wrong answer, score distribution, and
   * attempt patterns (current vs superseded, using quizSubmissions.superseded
   * the same way retryQuiz sets it). Cached for 5 minutes like
   * getModuleQuizHistory.
   *
   * Unlike getModuleQuizHistory, superseded submissions are NOT excluded
   * from the top-level attempt counts (totalAttempts includes them,
   * currentAttempts/supersededAttempts break them out) — #417 explicitly
   * asks for "attempt patterns (e.g. retry counts)", which requires seeing
   * both current and superseded rows rather than filtering superseded ones
   * out. Score distribution and the per-question breakdown are computed
   * only from current (non-superseded) submissions, matching
   * getModuleQuizHistory's and getQuizStats's convention that "the score"
   * for a learner is their current attempt, not a stale retried one.
   *
   * Per-question average time is not derivable: quizSubmissions.answers only
   * stores { questionId, selectedIndex } per answer (submitQuizSchema), with
   * no per-answer timestamp captured anywhere in submitQuiz. Rather than
   * fabricate a number, averageTimeSeconds is always null and
   * perQuestionTimingAvailable is false on the response so callers can
   * render "not tracked" instead of misreading a missing value as 0.
   */
  async getQuizAnalytics(
    courseId: string,
    moduleId: string,
    quizId: string,
  ): Promise<QuizAnalytics> {
    const quiz = await this.assertQuizInModule(courseId, moduleId, quizId);

    const cacheKeyString = cacheKey("quizzes", "analytics", quizId);

    return cacheGetOrSet(
      "quizzes",
      cacheKeyString,
      async () => {
        const submissions = await db
          .select({
            score: quizSubmissions.score,
            answers: quizSubmissions.answers,
            superseded: quizSubmissions.superseded,
          })
          .from(quizSubmissions)
          .where(eq(quizSubmissions.quizId, quizId));

        const questions = (
          Array.isArray(quiz.questions) ? quiz.questions : []
        ) as StoredQuestion[];
        const totalQuestions = questions.length;

        const current = submissions.filter((s) => !s.superseded);
        const superseded = submissions.filter((s) => s.superseded);

        const percentages = current.map((row) =>
          totalQuestions > 0 && row.score != null
            ? Math.round((row.score / totalQuestions) * 100)
            : 0,
        );
        const passCount = percentages.filter(
          (p) => p >= PASSING_PERCENTAGE,
        ).length;

        const questionAnalytics = questions.map((question) =>
          this.buildQuestionAnalytics(question, current),
        );

        return {
          quizId,
          courseId,
          moduleId,
          totalAttempts: submissions.length,
          currentAttempts: current.length,
          supersededAttempts: superseded.length,
          averageScore:
            percentages.length > 0
              ? Math.round(
                  percentages.reduce((sum, p) => sum + p, 0) /
                    percentages.length,
                )
              : 0,
          passRate:
            percentages.length > 0
              ? Math.round((passCount / percentages.length) * 100)
              : 0,
          scoreDistribution: this.buildScoreDistribution(percentages),
          questions: questionAnalytics,
          perQuestionTimingAvailable: false,
        };
      },
      QUIZ_STATS_TTL_SECONDS,
    );
  }

  /**
   * Correct rate and most common wrong answer for one question, across a
   * set of (non-superseded) submissions. A submission that never answered
   * this questionId (skipped, or an unrecognized id per submitQuiz's
   * lenient handling of stale questionIds) simply doesn't contribute a row
   * — `totalAnswered` is how many submissions actually included this
   * question, not the submission count.
   */
  private buildQuestionAnalytics(
    question: StoredQuestion,
    submissions: Array<{ answers: unknown }>,
  ): QuizQuestionAnalytics {
    let totalAnswered = 0;
    let correctCount = 0;
    const wrongAnswerCounts = new Map<number, number>();

    for (const submission of submissions) {
      const answers = Array.isArray(submission.answers)
        ? (submission.answers as Array<{
            questionId: string;
            selectedIndex: number;
          }>)
        : [];
      const answer = answers.find((a) => a?.questionId === question.id);
      if (!answer) continue;

      totalAnswered++;
      if (answer.selectedIndex === question.correctIndex) {
        correctCount++;
      } else {
        wrongAnswerCounts.set(
          answer.selectedIndex,
          (wrongAnswerCounts.get(answer.selectedIndex) ?? 0) + 1,
        );
      }
    }

    let commonWrongAnswer: QuizQuestionAnalytics["commonWrongAnswer"] = null;
    for (const [selectedIndex, count] of wrongAnswerCounts) {
      if (!commonWrongAnswer || count > commonWrongAnswer.count) {
        commonWrongAnswer = { selectedIndex, count };
      }
    }

    return {
      questionId: question.id,
      totalAnswered,
      correctCount,
      correctRate:
        totalAnswered > 0 ? Math.round((correctCount / totalAnswered) * 100) : 0,
      commonWrongAnswer,
      averageTimeSeconds: null,
    };
  }

  /** Buckets a list of percentage scores (0-100) into
   *  SCORE_DISTRIBUTION_BUCKETS. Shared by getModuleQuizHistory (#415) and
   *  getQuizAnalytics (#417) so both endpoints report distribution the same
   *  way. */
  private buildScoreDistribution(percentages: number[]): ScoreDistribution {
    const distribution: ScoreDistribution = {
      "0-20": 0,
      "21-40": 0,
      "41-60": 0,
      "61-80": 0,
      "81-100": 0,
    };

    for (const percentage of percentages) {
      const clamped = Math.max(0, Math.min(100, percentage));
      if (clamped <= 20) distribution["0-20"]++;
      else if (clamped <= 40) distribution["21-40"]++;
      else if (clamped <= 60) distribution["41-60"]++;
      else if (clamped <= 80) distribution["61-80"]++;
      else distribution["81-100"]++;
    }

    return distribution;
  }

  /**
   * Load a quiz and assert it belongs to the course + module in the URL.
   * Scoping by all three means a quiz id from another course reports 404
   * here rather than being editable through the wrong course's admin URL.
   */
  private async assertQuizInModule(
    courseId: string,
    moduleId: string,
    quizId: string,
  ): Promise<typeof quizzes.$inferSelect> {
    const [quiz] = await db
      .select()
      .from(quizzes)
      .where(eq(quizzes.id, quizId));

    if (
      !quiz ||
      quiz.courseId !== courseId ||
      quiz.moduleId !== moduleId
    ) {
      throw new NotFoundError("Quiz");
    }

    return quiz;
  }

  private createPlaceholderQuestions(
    courseId: string,
    moduleId: string
  ) {
    // Placeholder quiz generation — in production, call an LLM or content
    // service. There is no per-course/per-module content store to draw
    // from today (courses only has title/description/difficulty), so this
    // fallback set is necessarily generic rather than genuinely tailored
    // to courseId/moduleId (#146). Logging the ids here at least makes it
    // visible which course/module is receiving the generic fallback,
    // rather than that happening silently.
    logger.warn(
      { courseId, moduleId },
      "Falling back to generic placeholder questions — no course/module-specific content source available"
    );
    return [
      {
        id: "q1",
        text: "What is the primary purpose of the Stellar network?",
        options: [
          "Social media",
          "Cross-border payments and asset issuance",
          "Gaming",
          "File storage",
        ],
        correctIndex: 1,
      },
      {
        id: "q2",
        text: "What language are Soroban smart contracts written in?",
        options: ["Solidity", "JavaScript", "Rust", "Python"],
        correctIndex: 2,
      },
      {
        id: "q3",
        text: "What is the minimum account balance on Stellar?",
        options: [
          "0 XLM",
          "1 XLM (base reserve)",
          "10 XLM",
          "100 XLM",
        ],
        correctIndex: 1,
      },
    ];
  }

  private shuffleQuestions(questions: GeneratedQuestion[]): StoredQuestion[] {
    const storedQuestions = questions.map((question, originalQuestionIndex) => {
      const shuffledOptions = this.shuffleArray(
        question.options.map((option, originalOptionIndex) => ({
          option,
          originalOptionIndex,
        })),
      );
      const correctIndex = shuffledOptions.findIndex(
        (option) => option.originalOptionIndex === question.correctIndex,
      );

      return {
        ...question,
        options: shuffledOptions.map((option) => option.option),
        correctIndex,
        originalQuestionIndex,
        originalCorrectIndex: question.correctIndex,
        originalOptions: question.options,
      };
    });

    return this.shuffleArray(storedQuestions);
  }

  private shuffleArray<T>(items: T[]): T[] {
    const shuffled = [...items];
    for (let i = shuffled.length - 1; i > 0; i--) {
      const j = crypto.randomInt(i + 1);
      [shuffled[i], shuffled[j]] = [shuffled[j], shuffled[i]];
    }
    return shuffled;
  }

  private toClientQuestions(questions: StoredQuestion[]): QuizQuestion[] {
    return questions.map(({ id, text, options, correctFeedback, incorrectFeedback }) => ({
      id,
      text,
      options,
      ...(correctFeedback && { correctFeedback }),
      ...(incorrectFeedback && { incorrectFeedback }),
    }));
  }
}

export const quizService = new QuizService();
