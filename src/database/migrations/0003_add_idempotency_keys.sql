CREATE TABLE IF NOT EXISTS "idempotency_keys" (
  "key" varchar(64) PRIMARY KEY,
  "user_id" uuid NOT NULL REFERENCES "users"("id") ON DELETE CASCADE,
  "endpoint" varchar(255) NOT NULL,
  "request_hash" varchar(64) NOT NULL,
  "response_status" integer,
  "response_body" jsonb,
  "tx_hash" varchar(64),
  "created_at" timestamp with time zone NOT NULL DEFAULT now(),
  "expires_at" timestamp with time zone NOT NULL
);

CREATE INDEX IF NOT EXISTS "idx_idempotency_expires" ON "idempotency_keys" ("expires_at");
