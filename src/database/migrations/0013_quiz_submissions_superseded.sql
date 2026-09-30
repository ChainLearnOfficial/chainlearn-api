-- Marks a submission as superseded by a later quiz retry instead of
-- deleting it, so retry history stays auditable (#295).
ALTER TABLE "quiz_submissions" ADD COLUMN IF NOT EXISTS "superseded" boolean NOT NULL DEFAULT false;

CREATE INDEX IF NOT EXISTS "idx_quiz_submissions_superseded" ON "quiz_submissions" ("superseded") WHERE "superseded" = true;
