import type { FastifyInstance, FastifySchema } from "fastify";
import { quizController } from "./quiz.controller.js";
import { authGuard } from "../../middleware/auth.js";
import { validate } from "../../middleware/validation.js";
import { quizBatchGenerationRateLimit } from "../../middleware/rate-limit.js";
import { config } from "../../config/index.js";
import {
  generateQuizSchema,
  generateQuizBatchSchema,
  submitQuizSchema,
  quizIdParamsSchema,
  quizStatsQuerySchema,
  MAX_BATCH_GENERATE_MODULES,
} from "./quiz.types.js";

/**
 * Public quiz routes — registered separately from quizRoutes (below) since
 * that plugin applies an onRequest authGuard hook to every route in its
 * encapsulation context. /stats has no auth requirement (#307), so it lives
 * in its own plugin under the same "/quizzes" prefix instead.
 */
export async function quizPublicRoutes(app: FastifyInstance): Promise<void> {
  app.get<{ Querystring: import("./quiz.types.js").QuizStatsQuery }>(
    "/stats",
    {
      preHandler: [validate({ querystring: quizStatsQuerySchema })],
      schema: {
        description: "Aggregate quiz statistics (average score, pass rate, total submissions)",
        tags: ["quizzes"],
        querystring: {
          type: "object",
          properties: {
            courseId: { type: "string", format: "uuid" },
          },
        },
      } as FastifySchema,
    },
    (request, reply) => quizController.stats(request, reply)
  );
}

export async function quizRoutes(app: FastifyInstance): Promise<void> {
  app.addHook("onRequest", authGuard);

  app.post<{ Body: import("./quiz.types.js").GenerateQuizBody }>(
    "/generate",
    {
      // Longer request timeout (#305) — this calls the AI service, which
      // can itself take up to AI_TIMEOUT_MS plus retries.
      config: { timeoutMs: config.QUIZ_GENERATION_TIMEOUT_MS },
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

  app.post<{ Body: import("./quiz.types.js").GenerateQuizBatchBody }>(
    "/generate-batch",
    {
      // Modules are generated sequentially (#308), so the worst case is
      // roughly MAX_BATCH_GENERATE_MODULES times a single generation.
      config: {
        timeoutMs: config.QUIZ_GENERATION_TIMEOUT_MS * MAX_BATCH_GENERATE_MODULES,
        rateLimit: quizBatchGenerationRateLimit,
      },
      preHandler: [validate({ body: generateQuizBatchSchema })],
      schema: {
        description: "Generate quizzes for multiple modules of a course in one request",
        tags: ["quizzes"],
        security: [{ bearerAuth: [] }],
        body: {
          type: "object",
          required: ["courseId", "moduleIds"],
          properties: {
            courseId: { type: "string", format: "uuid" },
            moduleIds: {
              type: "array",
              items: { type: "string", minLength: 1 },
              minItems: 1,
              maxItems: MAX_BATCH_GENERATE_MODULES,
            },
            difficulty: { type: "string", enum: ["beginner", "intermediate", "advanced"] },
            numQuestions: { type: "integer", minimum: 1, maximum: 20 },
          },
        },
      } as FastifySchema,
    },
    (request, reply) => quizController.generateBatch(request, reply)
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

  app.post<{ Params: { id: string } }>(
    "/:id/retry",
    {
      // Also generates via the AI service — same rationale as /generate.
      config: { timeoutMs: config.QUIZ_GENERATION_TIMEOUT_MS },
      preHandler: [validate({ params: quizIdParamsSchema })],
      schema: {
        description: "Retry a previously submitted quiz with fresh questions",
        tags: ["quizzes"],
        security: [{ bearerAuth: [] }],
        params: { type: "object", required: ["id"], properties: { id: { type: "string", format: "uuid" } } },
      } as FastifySchema,
    },
    (request, reply) => quizController.retry(request, reply)
  );
}
