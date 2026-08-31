-- Create webhooks table for webhook system (issue #320)
CREATE TABLE webhooks (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  url VARCHAR(2048) NOT NULL,
  events JSONB NOT NULL,
  secret VARCHAR(256) NOT NULL,
  active BOOLEAN NOT NULL DEFAULT true,
  created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_webhooks_active ON webhooks(active);

-- Create webhook_attempts table for retry tracking
CREATE TABLE webhook_attempts (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  webhook_id UUID NOT NULL REFERENCES webhooks(id) ON DELETE CASCADE,
  event VARCHAR(100) NOT NULL,
  payload JSONB NOT NULL,
  status_code INTEGER,
  response_body TEXT,
  error_message TEXT,
  retry_count INTEGER NOT NULL DEFAULT 0,
  next_retry_at TIMESTAMP WITH TIME ZONE,
  succeeded_at TIMESTAMP WITH TIME ZONE,
  failed_at TIMESTAMP WITH TIME ZONE,
  created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_webhook_attempts_webhook_id ON webhook_attempts(webhook_id);
CREATE INDEX idx_webhook_attempts_event ON webhook_attempts(event);
CREATE INDEX idx_webhook_attempts_next_retry ON webhook_attempts(next_retry_at);
CREATE INDEX idx_webhook_attempts_succeeded ON webhook_attempts(succeeded_at);
