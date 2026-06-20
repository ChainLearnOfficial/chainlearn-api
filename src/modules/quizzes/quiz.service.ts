import { eq, and } from "drizzle-orm";
import { db } from "../../config/database.js";
import { quizzes, quizSubmissions, enrollments } from "../../database/schema.js";
import { NotFoundError, ForbiddenError, ConflictError } from "../../utils/errors.js";
import { withLock } from "../../utils/lock.js";
import { createQuizProof } from "../../stellar/signatures.js";
import { logger } from "../../utils/logger.js";
import type {
  GenerateQuizBody,
  SubmitQuizBody,
  QuizWithQuestions,
  QuizSubmissionResult,
  QuizQuestion,
} from "./quiz.types.js";

const PASSING_PERCENTAGE = 70;

export class QuizService {
  /**
   * Generate a quiz for a given course/module.
   * In a real system this would call an AI service; here we return
   * a pre-generated quiz or fetch from the database.
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
      const questions = existing.questions as Array<{
        id: string;
        text: string;
        options: string[];
        correctIndex: number;
      }>;

      return {
        id: existing.id,
        courseId: existing.courseId,
        moduleId: existing.moduleId,
        questions: questions.map(({ correctIndex: _, ...q }) => q),
        createdAt: existing.createdAt,
      };
    }

    // Generate new quiz (placeholder — would call AI service)
    const generatedQuestions = this.createPlaceholderQuestions(
      data.courseId,
      data.moduleId
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
      questions: generatedQuestions.map(({ correctIndex: _, ...q }) => q),
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
      return db.transaction(async (tx) => {
        const [quiz] = await tx
          .select()
          .from(quizzes)
          .where(eq(quizzes.id, quizId));

        if (!quiz) {
          throw new NotFoundError("Quiz");
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
        const questions = quiz.questions as Array<{
          id: string;
          text: string;
          options: string[];
          correctIndex: number;
        }>;

        let correctCount = 0;
        const feedbackParts: string[] = [];

        for (const answer of data.answers) {
          const question = questions.find((q) => q.id === answer.questionId);
          if (!question) continue;

          if (answer.selectedIndex === question.correctIndex) {
            correctCount++;
            feedbackParts.push(`Q: "${question.text}" - Correct!`);
          } else {
            feedbackParts.push(
              `Q: "${question.text}" - Incorrect. The correct answer was: "${question.options[question.correctIndex]}"`
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
    });
  }

  private createPlaceholderQuestions(
    courseId: string,
    moduleId: string
  ) {
    // Placeholder quiz generation — in production, call an LLM or content service
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
}

export const quizService = new QuizService();
