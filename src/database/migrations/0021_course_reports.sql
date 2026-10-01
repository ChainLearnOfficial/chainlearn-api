-- User-submitted course reports for community moderation (inappropriate
-- content, outdated material, errors, etc). One report per user per course;
-- admins triage via `status`.
CREATE TABLE IF NOT EXISTS "course_reports" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "course_id" uuid NOT NULL REFERENCES "courses"("id") ON DELETE CASCADE,
  "user_id" uuid NOT NULL REFERENCES "users"("id") ON DELETE CASCADE,
  "reason" varchar(20) NOT NULL,
  "description" text,
  "status" varchar(20) NOT NULL DEFAULT 'pending',
  "created_at" timestamp with time zone NOT NULL DEFAULT now(),
  CONSTRAINT "chk_course_reports_reason" CHECK ("reason" IN ('inappropriate', 'outdated', 'error', 'other')),
  CONSTRAINT "chk_course_reports_status" CHECK ("status" IN ('pending', 'reviewed', 'dismissed'))
);

CREATE UNIQUE INDEX IF NOT EXISTS "idx_course_reports_user_course"
  ON "course_reports" ("user_id", "course_id");
CREATE INDEX IF NOT EXISTS "idx_course_reports_course_id"
  ON "course_reports" ("course_id");
CREATE INDEX IF NOT EXISTS "idx_course_reports_status"
  ON "course_reports" ("status");
