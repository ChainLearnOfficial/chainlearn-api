-- Platform-wide announcements admins broadcast to all users (#353).
CREATE TABLE IF NOT EXISTS "announcements" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "title" varchar(255) NOT NULL,
  "message" text NOT NULL,
  "priority" varchar(20) NOT NULL DEFAULT 'normal',
  "active" boolean NOT NULL DEFAULT true,
  "created_at" timestamp with time zone NOT NULL DEFAULT now(),
  "expires_at" timestamp with time zone
);

CREATE INDEX IF NOT EXISTS "idx_announcements_active_created"
  ON "announcements" ("active", "created_at" DESC);
