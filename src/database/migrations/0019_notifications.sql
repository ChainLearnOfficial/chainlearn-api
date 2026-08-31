-- In-app user notifications (reward claims, credential mints, system
-- announcements). Rows older than 30 days are purged by the
-- cleanup-notifications job.
CREATE TABLE IF NOT EXISTS "notifications" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "user_id" uuid NOT NULL REFERENCES "users"("id") ON DELETE CASCADE,
  "type" varchar(50) NOT NULL,
  "title" varchar(255) NOT NULL,
  "message" text NOT NULL,
  "read" boolean NOT NULL DEFAULT false,
  "created_at" timestamp with time zone NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS "idx_notifications_user_created"
  ON "notifications" ("user_id", "created_at" DESC);
CREATE INDEX IF NOT EXISTS "idx_notifications_user_read"
  ON "notifications" ("user_id", "read");
