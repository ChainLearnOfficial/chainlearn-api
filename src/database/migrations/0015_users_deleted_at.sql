-- Soft-delete marker for DELETE /api/v1/users/me (#290). Null = active
-- account. Enrollments and credentials are never cascade-deleted or
-- nulled out when this is set — they're preserved for on-chain record
-- consistency, per the issue's explicit requirement.
ALTER TABLE "users" ADD COLUMN IF NOT EXISTS "deleted_at" timestamp with time zone;
