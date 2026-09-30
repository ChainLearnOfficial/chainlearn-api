import { z } from "zod";

import { sanitizeText } from "../../utils/sanitize.js";

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

// Capped at 10 modules per batch request (#308) — generation runs
// sequentially against the AI service, so this also bounds the route's
// worst-case timeout (see QUIZ_BATCH_GENERATION_TIMEOUT_MS).
export const MAX_BATCH_GENERATE_MODULES = 10;

export const generateQuizBatchSchema = z.object({
  courseId: z.string().uuid("Invalid course ID"),
  moduleIds: z
    .array(z.string().min(1))
    .min(1, "At least one module ID is required")
    .max(MAX_BATCH_GENERATE_MODULES, `Too many modules (max ${MAX_BATCH_GENERATE_MODULES})`),
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

export const quizStatsQuerySchema = z.object({
  courseId: z.string().uuid("Invalid course ID").optional(),
});

export const QUIZ_FEEDBACK_TYPES = ["unclear", "wrong", "other"] as const;

export const submitQuizFeedbackSchema = z.object({
  questionId: z.string().min(1).max(100),
  type: z.enum(QUIZ_FEEDBACK_TYPES),
  comment: z.string().max(2000).optional(),
});

export const quizFeedbackSummaryQuerySchema = z.object({
  questionId: z.string().min(1).max(100).optional(),
});

// ─── Admin: Manual Quiz Authoring (#388) ─────────────────────────────────────

/** Smallest workable number of choices for a multiple-choice question. */
export const MIN_QUIZ_OPTIONS = 2;
/** Upper bound on choices per question. Capped well below
 *  submitQuizSchema's static max(20) so a hand-authored question can never
 *  exceed what a submitted answer index can address. */
export const MAX_QUIZ_OPTIONS = 10;

/**
 * One hand-authored question (#388). Matches the shape QuizService stores
 * after AI generation, minus the shuffle bookkeeping (see the note on
 * `original*` in quiz.service.ts) — an author's order *is* the final order.
 *
 * Text, options and feedback are HTML-stripped on the way in. They are
 * rendered back to learners inside quiz feedback strings, so storing raw
 * admin-supplied markup would be a stored-XSS vector for every client that
 * renders them.
 */
export const authoredQuestionSchema = z
  .object({
    id: z
      .string()
      .trim()
      .min(1, "Question id is required")
      .max(100)
      .transform(sanitizeText),
    // `.trim()` before `.min()` on every string below: the length check has
    // to see the trimmed value, or a whitespace-only field passes `.min(1)`
    // and only becomes empty *after* the sanitizing transform, storing a
    // blank question. Sanitizing strips markup but does not trim.
    text: z
      .string()
      .trim()
      .min(1, "Question text is required")
      .max(2000)
      .transform(sanitizeText),
    options: z
      .array(
        z
          .string()
          .trim()
          .min(1, "Options cannot be blank")
          .max(500)
          .transform(sanitizeText),
      )
      .min(MIN_QUIZ_OPTIONS, `A question needs at least ${MIN_QUIZ_OPTIONS} options`)
      .max(MAX_QUIZ_OPTIONS, `A question can have at most ${MAX_QUIZ_OPTIONS} options`),
    correctIndex: z.coerce
      .number()
      .int("correctIndex must be a whole number")
      .min(0, "correctIndex cannot be negative"),
    // Blank feedback is treated as absent rather than rejected: an authoring
    // form naturally submits "" for an optional field the author left empty,
    // and a 400 for that would be noise. Storing "" instead would put an
    // empty string into the learner's feedback text.
    correctFeedback: z.preprocess(
      (v) => (typeof v === "string" && v.trim() === "" ? undefined : v),
      z.string().max(2000).transform(sanitizeText).optional(),
    ),
    incorrectFeedback: z.preprocess(
      (v) => (typeof v === "string" && v.trim() === "" ? undefined : v),
      z.string().max(2000).transform(sanitizeText).optional(),
    ),
  })
  .superRefine((question, ctx) => {
    // Can't be a field rule: it depends on options.length.
    if (question.correctIndex >= question.options.length) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["correctIndex"],
        message: `correctIndex ${question.correctIndex} is out of range — this question has ${question.options.length} options (valid indexes 0-${question.options.length - 1})`,
      });
    }
  });

/** A whole hand-authored quiz. Question ids must be unique within a quiz:
 *  QuizService.submitQuiz resolves a submitted answer to a question with
 *  `questions.find(q => q.id === answer.questionId)`, so a duplicate id
 *  would silently make the second copy unanswerable and permanently score
 *  as "not answered". */
export const authoredQuizSchema = z
  .object({
    questions: z
      .array(authoredQuestionSchema)
      .min(1, "A quiz needs at least one question")
      .max(50, "Too many questions"),
  })
  .superRefine((quiz, ctx) => {
    const seen = new Map<string, number>();
    quiz.questions.forEach((question, index) => {
      const first = seen.get(question.id);
      if (first !== undefined) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["questions", index, "id"],
          message: `Duplicate question id "${question.id}" (also used by question ${first + 1}) — every question needs a unique id`,
        });
        return;
      }
      seen.set(question.id, index);
    });
  });

/** Route params for the admin quiz list/create endpoints (#388). */
export const adminQuizModuleParamsSchema = z.object({
  id: z.string().uuid("Invalid course ID"),
  moduleId: z.string().min(1).max(100),
});

/** Route params for a single admin quiz (#388). */
export const adminQuizParamsSchema = adminQuizModuleParamsSchema.extend({
  quizId: z.string().uuid("Invalid quiz ID"),
});

/** Upper bound on keys an admin may store on a quiz (#413). */
export const QUIZ_METADATA_MAX_KEYS = 20;

const quizMetadataValueSchema = z.union([
  z.string().trim().max(500).transform(sanitizeText),
  z.number().finite(),
  z.boolean(),
  z.null(),
]);

/** Free-form admin metadata. Keys are short identifiers; string values are
 *  HTML-stripped because they can be rendered back in the admin UI. */
export const adminQuizMetadataSchema = z
  .record(
    z
      .string()
      .trim()
      .min(1)
      .max(50)
      .regex(/^[A-Za-z0-9_-]+$/, "Metadata keys may only contain letters, numbers, _ and -"),
    quizMetadataValueSchema,
  )
  .superRefine((value, ctx) => {
    if (Object.keys(value).length > QUIZ_METADATA_MAX_KEYS) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: `metadata can have at most ${QUIZ_METADATA_MAX_KEYS} keys`,
      });
    }
  });

/**
 * POST body for updating an existing quiz (#413). `questions`, when sent,
 * replaces the whole question list. `archived` hides the quiz from learners
 * without deleting it. `metadata` is merged into the stored object.
 * At least one field is required so an empty POST is not a silent no-op.
 */
export const adminUpdateQuizSchema = z
  .object({
    questions: z
      .array(authoredQuestionSchema)
      .min(1, "A quiz needs at least one question")
      .max(50, "Too many questions")
      .optional(),
    archived: z.boolean().optional(),
    metadata: adminQuizMetadataSchema.optional(),
  })
  .superRefine((body, ctx) => {
    if (
      body.questions === undefined &&
      body.archived === undefined &&
      body.metadata === undefined
    ) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "Provide questions, archived, or metadata to update",
      });
    }

    if (body.questions) {
      const unique = authoredQuizSchema.safeParse({ questions: body.questions });
      if (!unique.success) {
        for (const issue of unique.error.issues) {
          // Question field errors are already reported by authoredQuestionSchema.
          // The extra rule at quiz level is unique question ids.
          if (!issue.message.startsWith("Duplicate question id")) continue;
          ctx.addIssue(issue);
        }
      }
    }
  });

// ─── Types ──────────────────────────────────────────────────────────────────

export type GenerateQuizBody = z.infer<typeof generateQuizSchema>;
export type GenerateQuizBatchBody = z.infer<typeof generateQuizBatchSchema>;
export type SubmitQuizBody = z.infer<typeof submitQuizSchema>;
export type QuizIdParams = z.infer<typeof quizIdParamsSchema>;
export type QuizStatsQuery = z.infer<typeof quizStatsQuerySchema>;
export type SubmitQuizFeedbackBody = z.infer<typeof submitQuizFeedbackSchema>;
export type QuizFeedbackSummaryQuery = z.infer<typeof quizFeedbackSummaryQuerySchema>;

export interface QuizQuestion {
  id: string;
  text: string;
  options: string[];
  correctFeedback?: string; // Custom feedback for correct answer
  incorrectFeedback?: string; // Custom feedback for incorrect answer
  // correctIndex is NOT sent to client
}

export interface QuizWithQuestions {
  id: string;
  courseId: string;
  moduleId: string;
  questions: QuizQuestion[];
  createdAt: Date;
}

/** One entry of POST /api/v1/quizzes/generate-batch's response (#308). Each
 * module is generated independently, so one module's failure (e.g. hitting
 * its own per-module rate limit) doesn't block the others in the batch. */
export type QuizBatchGenerateEntry =
  | { moduleId: string; success: true; quiz: QuizWithQuestions }
  | { moduleId: string; success: false; error: string };

export interface QuizSubmissionResult {
  id: string;
  score: number;
  totalQuestions: number;
  percentage: number;
  passed: boolean;
  feedback: string;
  rewardAvailable: boolean;
}

export interface QuizStats {
  averageScore: number;
  passRate: number;
  totalSubmissions: number;
  submissionsPerCourse: Record<string, number>;
}

export interface QuizFeedbackEntry {
  id: string;
  questionId: string;
  userId: string;
  type: (typeof QUIZ_FEEDBACK_TYPES)[number];
  comment: string | null;
  createdAt: Date;
}

/** Per-question feedback counts, for admins reviewing which questions need work. */
export interface QuizFeedbackSummaryEntry {
  questionId: string;
  total: number;
  counts: Record<(typeof QUIZ_FEEDBACK_TYPES)[number], number>;
}

// ─── Admin Quiz Types (#388) ────────────────────────────────────────────────

/** A question as an admin sees it. Unlike QuizQuestion, this includes
 *  `correctIndex` — the admin's whole job is authoring the right answer, and
 *  this is an admin-only route. Never send this shape to a learner. */
export interface AdminQuizQuestion {
  id: string;
  text: string;
  options: string[];
  correctIndex: number;
  correctFeedback?: string;
  incorrectFeedback?: string;
}

/** A quiz row as the admin quiz endpoints return it (#388). */
export interface AdminQuiz {
  id: string;
  courseId: string;
  moduleId: string;
  questions: AdminQuizQuestion[];
  questionCount: number;
  /** The user the AI generated this quiz for, or null for a hand-authored
   *  course-wide quiz. */
  generatedFor: string | null;
  /** How many learners have submitted this quiz. Surfaced so an admin can
   *  see what deleting it would destroy — quiz_submissions cascades. */
  submissionCount: number;
  /** When the quiz was archived (#413). Null while it is live. */
  archivedAt: Date | null;
  metadata: Record<string, string | number | boolean | null>;
  createdAt: Date;
}

/** One validated hand-authored question, post-sanitization — the exact shape
 *  written to `quizzes.questions`. */
export type AuthoredQuestion = z.infer<typeof authoredQuestionSchema>;
export type AuthoredQuizBody = z.infer<typeof authoredQuizSchema>;
export type AdminQuizModuleParams = z.infer<typeof adminQuizModuleParamsSchema>;
export type AdminQuizParams = z.infer<typeof adminQuizParamsSchema>;
export type AdminQuizUpdateBody = z.infer<typeof adminUpdateQuizSchema>;
export type QuizMetadata = Record<string, string | number | boolean | null>;

/** Aggregate quiz performance for one module, across every quiz belonging to
 *  it (admin only, #415). Mirrors QuizStats' normalization: `score` is a raw
 *  correct-answer count, so each submission is normalized against its own
 *  quiz's question count before averaging. */
export interface ModuleQuizHistory {
  moduleId: string;
  totalAttempts: number;
  averageScore: number;
  passRate: number;
  /** Percentage-decile bucket (e.g. "70-79") -> submission count. */
  scoreDistribution: Record<string, number>;
}

/** How often each wrong option was picked for one question (admin only,
 *  #417). Capped to the most-picked few so a question with many options
 *  doesn't dump every wrong index. */
export interface QuizQuestionAnalytics {
  questionId: string;
  questionText: string;
  totalAnswered: number;
  correctCount: number;
  correctRate: number;
  commonWrongAnswers: Array<{ selectedIndex: number; count: number }>;
}

/** Question-by-question performance for a single quiz (admin only, #417). */
export interface QuizAnalytics {
  quizId: string;
  totalAttempts: number;
  scoreDistribution: Record<string, number>;
  questions: QuizQuestionAnalytics[];
}

/** Result of DELETE on an admin quiz (#388). `submissionsDeleted` is
 *  reported explicitly because quiz_submissions rows cascade, and those
 *  rows are what reward history is read from. */
export interface AdminQuizDeleteResult {
  quizId: string;
  courseId: string;
  moduleId: string;
  submissionsDeleted: number;
  claimedRewardsDeleted: number;
  deletedAt: Date;
}
