-- Course reviews / ratings: users rate and review courses they've
-- completed. One review per user per course (upserted on repeat
-- submission). Average rating is computed from this table and cached by
-- CourseService.
CREATE TABLE IF NOT EXISTS "course_reviews" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "user_id" uuid NOT NULL REFERENCES "users"("id") ON DELETE CASCADE,
  "course_id" uuid NOT NULL REFERENCES "courses"("id") ON DELETE CASCADE,
  "rating" integer NOT NULL,
  "review_text" text,
  "created_at" timestamp with time zone NOT NULL DEFAULT now(),
  "updated_at" timestamp with time zone NOT NULL DEFAULT now(),
  CONSTRAINT "chk_course_reviews_rating" CHECK ("rating" >= 1 AND "rating" <= 5)
);

CREATE UNIQUE INDEX IF NOT EXISTS "idx_course_reviews_user_course"
  ON "course_reviews" ("user_id", "course_id");
CREATE INDEX IF NOT EXISTS "idx_course_reviews_course_id"
  ON "course_reviews" ("course_id");
