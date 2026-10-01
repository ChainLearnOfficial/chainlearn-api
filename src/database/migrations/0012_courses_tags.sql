-- Tags for admin course creation/management (#292).
ALTER TABLE "courses" ADD COLUMN IF NOT EXISTS "tags" jsonb NOT NULL DEFAULT '[]';
