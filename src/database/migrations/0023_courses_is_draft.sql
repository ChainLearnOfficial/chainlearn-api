-- Draft/publish workflow for courses (#376). A draft is saved content that is
-- not visible to users. It is tracked separately from is_active: saving a
-- draft sets is_draft = true and is_active = false; publishing (is_active =
-- true) clears is_draft.
ALTER TABLE "courses"
  ADD COLUMN IF NOT EXISTS "is_draft" boolean NOT NULL DEFAULT false;
