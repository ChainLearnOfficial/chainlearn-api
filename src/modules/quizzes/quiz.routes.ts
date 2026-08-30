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
        security: [{ bearerAuth: [] }],
        body: {
          type: "object",
          required: ["courseId", "moduleId"],
          properties: {
            courseId: { type: "string", format: "uuid" },
            moduleId: { type: "string", minLength: 1 },
            difficulty: { type: "string", enum: ["beginner", "intermediate", "advanced"] },
            numQuestions: { type: "integer", minimum: 1, maximum: 20 },
          },
        },
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
        security: [{ bearerAuth: [] }],
        params: { type: "object", required: ["id"], properties: { id: { type: "string", format: "uuid" } } },
        body: {
          type: "object",
          required: ["answers"],
          properties: {
            answers: {
              type: "array", minItems: 1, maxItems: 50,
              items: {
                type: "object", required: ["questionId", "selectedIndex"],
                properties: {
                  questionId: { type: "string", minLength: 1, maxLength: 100 },
                  selectedIndex: { type: "integer", minimum: 0, maximum: 20 },
                },
              },
            },
          },
        },
      } as FastifySchema,
    },
    (request, reply) => quizController.submit(request, reply)
  );
}
