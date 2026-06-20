import { logger } from "../../utils/logger.js";

export interface AiQuizQuestion {
  prompt: string;
  options: string[];
  correct_index: number;
}

interface AiQuizResponse {
  quiz_id: string;
  questions: AiQuizQuestion[];
}

interface GenerateQuizFromAiParams {
  userId: string;
  courseId: string;
  moduleId: string;
  difficulty: "beginner" | "intermediate" | "advanced";
  numQuestions: number;
}

export type QuizQuestionForStorage = {
  id: string;
  text: string;
  options: string[];
  correctIndex: number;
};

export function normalizeAiQuizQuestions(
  questions: AiQuizQuestion[]
): QuizQuestionForStorage[] {
  return questions.map((question, index) => ({
    id: `q${index + 1}`,
    text: question.prompt,
    options: question.options,
    correctIndex: question.correct_index,
  }));
}

export async function generateQuizFromAI(
  params: GenerateQuizFromAiParams
): Promise<AiQuizQuestion[]> {
  const { config } = await import("../../config/index.js");

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
