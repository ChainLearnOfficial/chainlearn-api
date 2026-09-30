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
  AdminQuizModuleParams,
  AdminQuizParams,
  AdminQuizUpdateBody,
  AuthoredQuizBody,
  AuthoredQuestion,
  ArchiveModuleQuizBody,
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

  // ─── Admin: Manual Quiz Authoring (#388) ─────────────────────────────────

  /**
   * GET /api/v1/admin/courses/:id/modules/:moduleId/quizzes
   * Every quiz on a course module, with correct answers and submission
   * counts (admin only).
   */
  async listModuleQuizzes(
    request: FastifyRequest<{ Params: AdminQuizModuleParams }>,
    reply: FastifyReply
  ): Promise<void> {
    const { id, moduleId } = request.params;
    const result = await quizService.listModuleQuizzes(id, moduleId);

    reply.send({ success: true, data: result });
  }

  /**
   * POST /api/v1/admin/courses/:id/modules/:moduleId/quizzes
   * Create a hand-authored quiz for a course module (admin only).
   */
  async createModuleQuiz(
    request: FastifyRequest<{
      Params: AdminQuizModuleParams;
      Body: AuthoredQuizBody;
    }>,
    reply: FastifyReply
  ): Promise<void> {
    const { id, moduleId } = request.params;
    const quiz = await quizService.createModuleQuiz(
      id,
      moduleId,
      request.body.questions,
    );

    reply.status(201).send({ success: true, data: quiz });
  }

  /**
   * PUT /api/v1/admin/courses/:id/modules/:moduleId/quizzes/:quizId
   * Replace a quiz's questions (admin only).
   */
  async updateModuleQuiz(
    request: FastifyRequest<{
      Params: AdminQuizParams;
      Body: AuthoredQuizBody;
    }>,
    reply: FastifyReply
  ): Promise<void> {
    const { id, moduleId, quizId } = request.params;
    const quiz = await quizService.updateModuleQuiz(
      id,
      moduleId,
      quizId,
      request.body.questions,
    );

    reply.send({ success: true, data: quiz });
  }

  /**
   * POST /api/v1/admin/courses/:id/modules/:moduleId/quizzes/:quizId
   * Replace questions, merge metadata, and/or archive a quiz (admin only, #413).
   */
  async updateModuleQuizDetails(
    request: FastifyRequest<{
      Params: AdminQuizParams;
      Body: AdminQuizUpdateBody;
    }>,
    reply: FastifyReply
  ): Promise<void> {
    const { id, moduleId, quizId } = request.params;
    const quiz = await quizService.updateModuleQuizDetails(
      id,
      moduleId,
      quizId,
      request.body,
    );

    reply.send({ success: true, data: quiz });
  }

  /**
   * POST /api/v1/admin/courses/:id/modules/:moduleId/quizzes/:quizId/questions
   * Append one question to an existing quiz (admin only, #411).
   */
  async addModuleQuizQuestion(
    request: FastifyRequest<{
      Params: AdminQuizParams;
      Body: AuthoredQuestion;
    }>,
    reply: FastifyReply
  ): Promise<void> {
    const { id, moduleId, quizId } = request.params;
    const quiz = await quizService.addModuleQuizQuestion(
      id,
      moduleId,
      quizId,
      request.body,
    );

    reply.status(201).send({ success: true, data: quiz });
  }

  /**
   * DELETE /api/v1/admin/courses/:id/modules/:moduleId/quizzes/:quizId
   * Delete a quiz and its submissions (admin only).
   */
  async deleteModuleQuiz(
    request: FastifyRequest<{ Params: AdminQuizParams }>,
    reply: FastifyReply
  ): Promise<void> {
    const { id, moduleId, quizId } = request.params;
    const result = await quizService.deleteModuleQuiz(id, moduleId, quizId);

    reply.send({ success: true, data: result });
  }

  /**
   * POST /api/v1/admin/courses/:id/modules/:moduleId/quizzes/:quizId/archive
   * Archive (or unarchive) a quiz via its own endpoint (admin only, #416).
   */
  async archiveModuleQuiz(
    request: FastifyRequest<{
      Params: AdminQuizParams;
      Body: ArchiveModuleQuizBody;
    }>,
    reply: FastifyReply
  ): Promise<void> {
    const { id, moduleId, quizId } = request.params;
    const quiz = await quizService.archiveModuleQuiz(
      id,
      moduleId,
      quizId,
      request.body.archived,
    );
   * Archive a quiz without deleting it (admin only, #416). Thin wrapper
   * around the same archive path updateModuleQuizDetails already supports.
   */
  async archiveModuleQuiz(
    request: FastifyRequest<{ Params: AdminQuizParams }>,
    reply: FastifyReply
  ): Promise<void> {
    const { id, moduleId, quizId } = request.params;
    const quiz = await quizService.updateModuleQuizDetails(id, moduleId, quizId, {
      archived: true,
    });

    reply.send({ success: true, data: quiz });
  }

  /**
   * GET /api/v1/courses/:id/modules/:moduleId/quiz-history
   * Aggregate quiz stats for every quiz in a course module (admin only, #415).
   * Aggregate quiz performance across a module's quizzes (admin only, #415).
   */
  async getModuleQuizHistory(
    request: FastifyRequest<{ Params: AdminQuizModuleParams }>,
    reply: FastifyReply
  ): Promise<void> {
    const { id, moduleId } = request.params;
    const history = await quizService.getModuleQuizHistory(id, moduleId);

    reply.send({ success: true, data: history });
  }

  /**
   * GET /api/v1/admin/courses/:id/modules/:moduleId/quizzes/:quizId/analytics
   * Detailed question-by-question analytics for one quiz (admin only, #417).
   * Question-by-question analytics for a single quiz (admin only, #417).
   */
  async getQuizAnalytics(
    request: FastifyRequest<{ Params: AdminQuizParams }>,
    reply: FastifyReply
  ): Promise<void> {
    const { id, moduleId, quizId } = request.params;
    const analytics = await quizService.getQuizAnalytics(id, moduleId, quizId);

    reply.send({ success: true, data: analytics });
  }
}

export const quizController = new QuizController();
