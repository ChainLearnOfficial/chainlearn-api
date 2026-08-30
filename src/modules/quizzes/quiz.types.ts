import { z } from "zod";

// ─── Constants ──────────────────────────────────────────────────────────────

// Single source of truth for the quiz passing threshold. Used by both
// QuizService (to compute `passed` on submission) and RewardService (to
// re-verify a submission is actually passing before releasing a reward) —
// previously each defined its own copy, which could silently drift apart.
export const PASSING_PERCENTAGE = 70;

// Max number of times a user may retry a quiz for the same module within a
// single calendar day (#295).
export const MAX_RETRIES_PER_MODULE_PER_DAY = 3;

// Max number of times a user may *generate* a quiz for the same module
// within a rolling hour (#291). Distinct from MAX_RETRIES_PER_MODULE_PER_DAY,
// which limits retry *submissions* per calendar day — this limits the
// generation call itself, independent of whether a quiz already existed for
// that module (generateQuiz's existing-quiz short-circuit means most calls
// won't hit the AI service at all, but a user hammering the endpoint before
// the first quiz is created still shouldn't be able to spam AI generation
// calls).
export const MAX_QUIZ_GENERATIONS_PER_MODULE_PER_HOUR = 5;

// ─── Request Schemas ────────────────────────────────────────────────────────

export const generateQuizSchema = z.object({
  courseId: z.string().uuid("Invalid course ID"),
  moduleId: z.string().min(1, "Module ID is required"),
  difficulty: z.enum(["beginner", "intermediate", "advanced"]).optional(),
  numQuestions: z.coerce.number().int().min(1).max(20).optional(),
});

export const submitQuizSchema = z.object({
  answers: z
    .array(
      z.object({
        questionId: z.string().min(1).max(100),
        // Bound the index so out-of-range values can't be submitted.
        selectedIndex: z.number().int().min(0).max(20),
      })
    )
    .min(1, "At least one answer is required")
    .max(50, "Too many answers"),
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
