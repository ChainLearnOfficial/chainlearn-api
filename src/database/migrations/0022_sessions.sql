-- Authenticated-session tracking: one row per distinct JWT (keyed by its
-- jti), upserted on every authGuard-protected request so `last_active`
-- stays current. Lets a user see where they're logged in and revoke a
-- session they don't recognize.
CREATE TABLE IF NOT EXISTS "sessions" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "user_id" uuid NOT NULL REFERENCES "users"("id") ON DELETE CASCADE,
  "token_id" varchar(64) NOT NULL,
  "device_info" text,
  "ip_address" varchar(45),
  "last_active" timestamp with time zone NOT NULL DEFAULT now(),
  "revoked_at" timestamp with time zone,
  "created_at" timestamp with time zone NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS "idx_sessions_token_id"
  ON "sessions" ("token_id");
CREATE INDEX IF NOT EXISTS "idx_sessions_user_revoked"
  ON "sessions" ("user_id", "revoked_at");
