-- Admin flag used by adminGuard to gate the admin course management routes (#292).
ALTER TABLE "users" ADD COLUMN IF NOT EXISTS "is_admin" boolean NOT NULL DEFAULT false;
