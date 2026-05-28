import type { FastifyInstance } from "fastify";
import { quizController } from "./quiz.controller.js";
import { authGuard } from "../../middleware/auth.js";
import { validate } from "../../middleware/validation.js";
import { generateQuizSchema, submitQuizSchema, quizIdParamsSchema } from "./quiz.types.js";

export async function quizRoutes(app: FastifyInstance): Promise<void> {
  app.addHook("onRequest", authGuard);

  app.post(
    "/generate",
    {
      preHandler: [validate({ body: generateQuizSchema })],
      schema: {
        description: "Generate a quiz for a course module",
        tags: ["quizzes"],
      },
    },
    quizController.generate.bind(quizController)
  );

  app.post(
    "/:id/submit",
    {
      preHandler: [
        validate({ params: quizIdParamsSchema, body: submitQuizSchema }),
      ],
      schema: {
        description: "Submit quiz answers",
        tags: ["quizzes"],
      },
    },
    quizController.submit.bind(quizController)
  );
}
