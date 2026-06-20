import { config } from "../../config/index.js";
import { logger } from "../../utils/logger.js";

interface AiQuizQuestion {
  prompt: string;
  options: string[];
  correct_index: number;
}

interface AiQuizResponse {
  quiz_id: string;
  questions: AiQuizQuestion[];
}

export type AiDifficulty = "beginner" | "intermediate" | "advanced";

export interface GenerateQuizFromAIParams {
  userId: string;
  courseId: string;
  moduleId: string;
  difficulty: AiDifficulty;
  numQuestions: number;
}

export async function generateQuizFromAI(
  params: GenerateQuizFromAIParams
): Promise<AiQuizQuestion[]> {
  const response = await fetch(`${config.AI_SERVICE_URL}/generate-quiz`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      user_id: params.userId,
      course_id: params.courseId,
      module_id: params.moduleId,
      difficulty: params.difficulty,
      num_questions: params.numQuestions,
    }),
  });

  if (!response.ok) {
    logger.error(
      { status: response.status },
      "AI service quiz generation failed"
    );
    throw new Error(`AI service returned ${response.status}`);
  }

  const data = (await response.json()) as AiQuizResponse;
  return data.questions;
}
