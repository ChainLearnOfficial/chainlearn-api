-- Prerequisite course IDs for a course (#369). Admin-configurable, informational
-- only — enrolling never checks this list. Empty array means no prerequisites.
ALTER TABLE "courses"
  ADD COLUMN IF NOT EXISTS "prerequisites" jsonb NOT NULL DEFAULT '[]';
