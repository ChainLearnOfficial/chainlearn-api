import crypto from "node:crypto";
import { eq, and } from "drizzle-orm";
import { db } from "../../config/database.js";
import { quizzes, quizSubmissions, enrollments } from "../../database/schema.js";
import {
  NotFoundError,
  ForbiddenError,
  ConflictError,
  RateLimitError,
} from "../../utils/errors.js";
import { withLock } from "../../utils/lock.js";
import { createQuizProof } from "../../stellar/signatures.js";
import { logger } from "../../utils/logger.js";
import { redis } from "../../config/redis.js";
import { generateQuizFromAI } from "./ai-client.js";
import { sanitizeQuizFeedback } from "../../utils/sanitize.js";
import { auditLog } from "../../audit/index.js";
import { quizSubmissionsTotal } from "../../metrics/index.js";
import { cacheGet, cacheSet, cacheKey } from "../../cache/index.js";
import {
  cacheDel,
  cacheKey,
  cacheKeyPattern,
  cacheInvalidatePattern,
} from "../../cache/index.js";
import {
  PASSING_PERCENTAGE,
  MAX_RETRIES_PER_MODULE_PER_DAY,
  MAX_QUIZ_GENERATIONS_PER_MODULE_PER_HOUR,
  type GenerateQuizBody,
  type SubmitQuizBody,
  type QuizWithQuestions,
  type QuizSubmissionResult,
  type QuizQuestion,
  type QuizStats,
} from "./quiz.types.js";

const QUIZ_STATS_TTL_SECONDS = 300;

type GeneratedQuestion = QuizQuestion & { correctIndex: number };
type StoredQuestion = GeneratedQuestion & {
  originalQuestionIndex: number;
  originalCorrectIndex: number;
  originalOptions: string[];
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
        eq(quizzes.generatedFor, userId)
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
            feedbackParts.push(
              sanitizeQuizFeedback(
                `Q: "${question.text}" - Incorrect. The correct answer was: "${question.options[question.correctIndex]}"`
              )
            );
            continue;
          }

          if (answer.selectedIndex === question.correctIndex) {
            correctCount++;
            feedbackParts.push(
              sanitizeQuizFeedback(`Q: "${question.text}" - Correct!`)
            );
          } else {
            feedbackParts.push(
              sanitizeQuizFeedback(
                `Q: "${question.text}" - Incorrect. The correct answer was: "${question.options[question.correctIndex]}"`
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
    return questions.map(({ id, text, options }) => ({ id, text, options }));
  }
}

export const quizService = new QuizService();
