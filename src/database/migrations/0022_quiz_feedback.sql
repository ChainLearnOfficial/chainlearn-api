-- Quiz feedback: users can flag a specific question as unclear, wrong, or
-- other. One feedback submission per user per (quiz, question) — a second
-- submission is rejected rather than silently overwriting the first.
CREATE TABLE IF NOT EXISTS "quiz_feedback" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "quiz_id" uuid NOT NULL REFERENCES "quizzes"("id") ON DELETE CASCADE,
  "question_id" varchar(100) NOT NULL,
  "user_id" uuid NOT NULL REFERENCES "users"("id") ON DELETE CASCADE,
  "type" varchar(20) NOT NULL,
  "comment" text,
  "created_at" timestamp with time zone NOT NULL DEFAULT now(),
  CONSTRAINT "chk_quiz_feedback_type" CHECK ("type" IN ('unclear', 'wrong', 'other'))
);

CREATE UNIQUE INDEX IF NOT EXISTS "idx_quiz_feedback_unique"
  ON "quiz_feedback" ("quiz_id", "question_id", "user_id");
CREATE INDEX IF NOT EXISTS "idx_quiz_feedback_quiz_question"
  ON "quiz_feedback" ("quiz_id", "question_id");
