-- Admin-defined module structure for courses (#304): id/title/description/
-- order, independent of the moduleId strings quizzes reference.
ALTER TABLE "courses" ADD COLUMN IF NOT EXISTS "modules" jsonb NOT NULL DEFAULT '[]';
