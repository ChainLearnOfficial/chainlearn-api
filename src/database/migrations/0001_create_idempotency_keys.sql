CREATE TABLE IF NOT EXISTS idempotency_keys (
  key VARCHAR(64) PRIMARY KEY,
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  endpoint VARCHAR(255) NOT NULL,
  request_hash VARCHAR(64) NOT NULL,
  response_status INTEGER,
  response_body JSONB,
  tx_hash VARCHAR(64),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  expires_at TIMESTAMPTZ NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_idempotency_expires ON idempotency_keys(expires_at);
CREATE INDEX IF NOT EXISTS idx_idempotency_user_endpoint ON idempotency_keys(user_id, endpoint);