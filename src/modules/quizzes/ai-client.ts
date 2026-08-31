import { z } from "zod";
import { config } from "../../config/index.js";
import { logger } from "../../utils/logger.js";
import { createTransientRetryPolicy, createCircuitBreaker } from "../../utils/resilience.js";
import { context, propagation } from "@opentelemetry/api";
import { getRequestId } from "../../utils/request-context.js";

const aiQuizQuestionSchema = z.object({
  prompt: z.string(),
  options: z.array(z.string()),
  correct_index: z.number().int(),
  correct_feedback: z.string().optional(),
  incorrect_feedback: z.string().optional(),
});

const aiQuizResponseSchema = z.object({
  quiz_id: z.string(),
  questions: z.array(aiQuizQuestionSchema),
});

export type AiQuizQuestion = z.infer<typeof aiQuizQuestionSchema>;

export type AiDifficulty = "beginner" | "intermediate" | "advanced";

export interface GenerateQuizFromAIParams {
  userId: string;
  courseId: string;
  moduleId: string;
  difficulty: AiDifficulty;
  numQuestions: number;
}

const aiRetry = createTransientRetryPolicy("AI service", { maxAttempts: 3 });
const aiBreaker = createCircuitBreaker({ label: "AI service" });

async function requestQuiz(
  params: GenerateQuizFromAIParams
): Promise<AiQuizQuestion[]> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), config.AI_TIMEOUT_MS);

  try {
    const headers: Record<string, string> = { "Content-Type": "application/json" };
    const requestId = getRequestId();
    if (requestId) headers["X-Request-ID"] = requestId;
    propagation.inject(context.active(), headers);

    const response = await fetch(`${config.AI_SERVICE_URL}/generate-quiz`, {
      method: "POST",
      headers,
      body: JSON.stringify({
        user_id: params.userId,
        course_id: params.courseId,
        module_id: params.moduleId,
        difficulty: params.difficulty,
        num_questions: params.numQuestions,
      }),
      signal: controller.signal,
    });

    if (!response.ok) {
      logger.error(
        { status: response.status },
        "AI service quiz generation failed"
      );
      throw new Error(`AI service returned ${response.status}`);
    }

    const raw = await response.json();
    const parsed = aiQuizResponseSchema.safeParse(raw);
    if (!parsed.success) {
      logger.error(
        { issues: parsed.error.issues },
        "AI service returned a malformed response"
      );
      throw new Error("AI service returned a malformed response");
    }

    return parsed.data.questions;
  } catch (err) {
    if (err instanceof Error && err.name === "AbortError") {
      logger.error({ timeout: config.AI_TIMEOUT_MS }, "AI service request timed out");
      throw new Error(`AI service request timed out after ${config.AI_TIMEOUT_MS}ms`);
    }
    throw err;
  } finally {
    clearTimeout(timeout);
  }
}

/**
 * Requests a generated quiz from the chainlearn-ai service. Wrapped with the
 * same retry + circuit breaker pattern used for Stellar calls: transient
 * failures are retried with backoff, and a persistent outage trips the
 * breaker so requests fail fast instead of blocking on every quiz request.
 */
export async function generateQuizFromAI(
  params: GenerateQuizFromAIParams
): Promise<AiQuizQuestion[]> {
  return aiBreaker.execute(() => aiRetry.execute(() => requestQuiz(params)));
}
