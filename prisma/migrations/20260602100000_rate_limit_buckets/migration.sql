CREATE UNLOGGED TABLE rate_limit_buckets (
  id         UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  key        TEXT NOT NULL,
  expires_at TIMESTAMPTZ NOT NULL DEFAULT (NOW() + INTERVAL '60 seconds')
);

CREATE INDEX idx_rate_limit_buckets_key_expires
  ON rate_limit_buckets (key, expires_at);
