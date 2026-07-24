ALTER TABLE "quiz_submissions" ADD COLUMN IF NOT EXISTS "reward_pending" boolean NOT NULL DEFAULT false;

CREATE INDEX IF NOT EXISTS "idx_quiz_submissions_reward_pending" ON "quiz_submissions" ("reward_pending") WHERE "reward_pending" = true;
