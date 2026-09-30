-- Archive support for courses (#358). Null means the course is not
-- archived. Archiving sets isActive = false and archivedAt = now(),
-- hiding the course from public listings while preserving its data and
-- leaving existing enrollments/credentials untouched so enrolled users
-- can still access it.
ALTER TABLE "courses"
  ADD COLUMN IF NOT EXISTS "archived_at" timestamptz;
