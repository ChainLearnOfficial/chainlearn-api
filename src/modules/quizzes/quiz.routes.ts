import type { FastifyInstance, FastifySchema } from "fastify";
import { quizController } from "./quiz.controller.js";
import { authGuard } from "../../middleware/auth.js";
import { validate } from "../../middleware/validation.js";
import { generateQuizSchema, submitQuizSchema, quizIdParamsSchema } from "./quiz.types.js";

export async function quizRoutes(app: FastifyInstance): Promise<void> {
  app.addHook("onRequest", authGuard);

  app.post<{ Body: import("./quiz.types.js").GenerateQuizBody }>(
    "/generate",
    {
      preHandler: [validate({ body: generateQuizSchema })],
      schema: {
        description: "Generate a quiz for a course module",
        tags: ["quizzes"],
      } as FastifySchema,
    },
    (request, reply) => quizController.generate(request, reply)
  );

  app.post<{ Params: { id: string }, Body: import("./quiz.types.js").SubmitQuizBody }>(
    "/:id/submit",
    {
      preHandler: [
        validate({ params: quizIdParamsSchema, body: submitQuizSchema }),
      ],
      schema: {
        description: "Submit quiz answers",
        tags: ["quizzes"],
      } as FastifySchema,
    },
    (request, reply) => quizController.submit(request, reply)
  );
}
