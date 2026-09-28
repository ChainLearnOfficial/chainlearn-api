-- Admin quiz update (#413): archive timestamp and editable metadata.
-- archived_at null means the quiz is live. metadata holds admin-supplied
-- key/value fields that are not part of the question document.
ALTER TABLE "quizzes"
  ADD COLUMN IF NOT EXISTS "archived_at" timestamptz;

ALTER TABLE "quizzes"
  ADD COLUMN IF NOT EXISTS "metadata" jsonb NOT NULL DEFAULT '{}'::jsonb;
