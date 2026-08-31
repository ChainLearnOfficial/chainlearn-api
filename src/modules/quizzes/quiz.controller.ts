import type { FastifyRequest, FastifyReply } from "fastify";
import { quizService } from "./quiz.service.js";
import type { AuthenticatedRequest } from "../../middleware/auth.js";
import type { GenerateQuizBody, SubmitQuizBody, QuizIdParams } from "./quiz.types.js";

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
}

export const quizController = new QuizController();
