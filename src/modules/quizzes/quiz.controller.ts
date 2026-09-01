import type { FastifyRequest, FastifyReply } from "fastify";
import { quizService } from "./quiz.service.js";
import type { AuthenticatedRequest } from "../../middleware/auth.js";
import type {
  GenerateQuizBody,
  GenerateQuizBatchBody,
  SubmitQuizBody,
  QuizIdParams,
  QuizStatsQuery,
  SubmitQuizFeedbackBody,
  QuizFeedbackSummaryQuery,
} from "./quiz.types.js";

export class QuizController {
  /**
   * POST /api/quizzes/generate
   * Generate a quiz for a course module.
   */
  async generate(
    request: FastifyRequest<{ Body: GenerateQuizBody }>,
    reply: FastifyReply
  ): Promise<void> {
    const { authUser } = request as AuthenticatedRequest;
    const data = request.body;
    const quiz = await quizService.generateQuiz(authUser.id, data);

    reply.status(201).send({ success: true, data: quiz });
  }

  /**
   * POST /api/v1/quizzes/generate-batch
   * Generate quizzes for multiple modules of a course in one request (#308).
   */
  async generateBatch(
    request: FastifyRequest<{ Body: GenerateQuizBatchBody }>,
    reply: FastifyReply
  ): Promise<void> {
    const { authUser } = request as AuthenticatedRequest;
    const data = request.body;
    const results = await quizService.generateQuizBatch(authUser.id, data);

    reply.status(201).send({ success: true, data: results });
  }

  /**
   * POST /api/quizzes/:id/submit
   * Submit answers for a quiz.
   */
  async submit(
    request: FastifyRequest<{ Params: QuizIdParams; Body: SubmitQuizBody }>,
    reply: FastifyReply
  ): Promise<void> {
    const { authUser } = request as AuthenticatedRequest;
    const { id } = request.params;
    const data = request.body;
    const result = await quizService.submitQuiz(authUser.id, id, data);

    reply.send({ success: true, data: result });
  }

  /**
   * POST /api/quizzes/:id/retry
   * Retake a previously submitted quiz with freshly generated questions.
   */
  async retry(
    request: FastifyRequest<{ Params: QuizIdParams }>,
    reply: FastifyReply
  ): Promise<void> {
    const { authUser } = request as AuthenticatedRequest;
    const { id } = request.params;
    const quiz = await quizService.retryQuiz(authUser.id, id);

    reply.status(201).send({ success: true, data: quiz });
  }

  /**
   * GET /api/quizzes/stats
   * Aggregate quiz statistics — average score, pass rate, total submissions.
   * No authentication required.
   */
  async stats(
    request: FastifyRequest<{ Querystring: QuizStatsQuery }>,
    reply: FastifyReply
  ): Promise<void> {
    const { courseId } = request.query;
    const stats = await quizService.getQuizStats(courseId);

    reply.send({ success: true, data: stats });
  }

  /**
   * POST /api/v1/quizzes/:id/feedback
   * Submit feedback on a specific quiz question.
   */
  async submitFeedback(
    request: FastifyRequest<{ Params: QuizIdParams; Body: SubmitQuizFeedbackBody }>,
    reply: FastifyReply
  ): Promise<void> {
    const { authUser } = request as AuthenticatedRequest;
    const { id } = request.params;
    const data = request.body;
    const feedback = await quizService.submitFeedback(authUser.id, id, data);

    reply.status(201).send({ success: true, data: feedback });
  }

  /**
   * GET /api/v1/quizzes/:id/feedback/summary
   * Per-question feedback counts for a quiz (admin only).
   */
  async feedbackSummary(
    request: FastifyRequest<{ Params: QuizIdParams; Querystring: QuizFeedbackSummaryQuery }>,
    reply: FastifyReply
  ): Promise<void> {
    const { id } = request.params;
    const { questionId } = request.query;
    const summary = await quizService.getFeedbackSummary(id, questionId);

    reply.send({ success: true, data: summary });
  }
}

export const quizController = new QuizController();
