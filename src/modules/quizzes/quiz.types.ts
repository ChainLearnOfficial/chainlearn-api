import { z } from "zod";

// ─── Request Schemas ────────────────────────────────────────────────────────

export const generateQuizSchema = z.object({
  courseId: z.string().uuid("Invalid course ID"),
  moduleId: z.string().min(1, "Module ID is required"),
});

export const submitQuizSchema = z.object({
  answers: z
    .array(
      z.object({
        questionId: z.string().min(1),
        selectedIndex: z.number().int().min(0),
      })
    )
    .min(1, "At least one answer is required"),
});

export const quizIdParamsSchema = z.object({
  id: z.string().uuid("Invalid quiz ID"),
});

// ─── Types ──────────────────────────────────────────────────────────────────

export type GenerateQuizBody = z.infer<typeof generateQuizSchema>;
export type SubmitQuizBody = z.infer<typeof submitQuizSchema>;
export type QuizIdParams = z.infer<typeof quizIdParamsSchema>;

export interface QuizQuestion {
  id: string;
  text: string;
  options: string[];
  // correctIndex is NOT sent to client
}

export interface QuizWithQuestions {
  id: string;
  courseId: string;
  moduleId: string;
  questions: QuizQuestion[];
  createdAt: Date;
}

export interface QuizSubmissionResult {
  id: string;
  score: number;
  totalQuestions: number;
  percentage: number;
  passed: boolean;
  feedback: string;
  rewardAvailable: boolean;
}
