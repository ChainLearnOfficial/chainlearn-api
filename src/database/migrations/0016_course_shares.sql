-- Shareable per-user, per-course referral links (#325). One row per
-- (user, course); referral_code is the short token embedded in the link and
-- click_count / enrollment_count track word-of-mouth growth.
CREATE TABLE IF NOT EXISTS "course_shares" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "user_id" uuid NOT NULL REFERENCES "users"("id") ON DELETE CASCADE,
  "course_id" uuid NOT NULL REFERENCES "courses"("id") ON DELETE CASCADE,
  "referral_code" varchar(16) NOT NULL,
  "click_count" integer NOT NULL DEFAULT 0,
  "enrollment_count" integer NOT NULL DEFAULT 0,
  "created_at" timestamp with time zone NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS "course_shares_referral_code_unique"
  ON "course_shares" ("referral_code");
CREATE UNIQUE INDEX IF NOT EXISTS "idx_course_shares_user_course"
  ON "course_shares" ("user_id", "course_id");
CREATE INDEX IF NOT EXISTS "idx_course_shares_referral_code"
  ON "course_shares" ("referral_code");
