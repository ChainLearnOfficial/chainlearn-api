-- Course IDs that should be completed before this one (#354). Purely
-- advisory — never enforced at enrollment time, only surfaced via
-- GET /api/v1/courses/:id/prerequisites.
ALTER TABLE "courses"
  ADD COLUMN IF NOT EXISTS "prerequisites" jsonb NOT NULL DEFAULT '[]'::jsonb;
-- Prerequisite course IDs for a course (#369). Admin-configurable, informational
-- only — enrolling never checks this list. Empty array means no prerequisites.
ALTER TABLE "courses"
  ADD COLUMN IF NOT EXISTS "prerequisites" jsonb NOT NULL DEFAULT '[]';
