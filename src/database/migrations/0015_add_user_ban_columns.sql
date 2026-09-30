ALTER TABLE "users" ADD COLUMN IF NOT EXISTS "banned_at" timestamp with time zone;
ALTER TABLE "users" ADD COLUMN IF NOT EXISTS "ban_reason" text;
