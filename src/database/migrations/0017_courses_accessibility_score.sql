-- Advisory 0–100 accessibility score for a course's authored content
-- (#326), recomputed on every create/update. Null until first written;
-- never blocks saving the course.
ALTER TABLE "courses"
  ADD COLUMN IF NOT EXISTS "accessibility_score" integer;
