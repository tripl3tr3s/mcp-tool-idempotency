-- Idempotency keys table used by PostgresBackend.
-- created_at / expires_at are epoch milliseconds (BIGINT).

CREATE TABLE IF NOT EXISTS idempotency_keys (
  key         TEXT PRIMARY KEY,
  tool_name   TEXT   NOT NULL,
  request     TEXT   NOT NULL,
  response    TEXT,
  status      TEXT   NOT NULL CHECK (status IN ('pending', 'completed', 'failed')),
  created_at  BIGINT NOT NULL,
  expires_at  BIGINT NOT NULL
);

CREATE INDEX IF NOT EXISTS idempotency_keys_expires_at_idx
  ON idempotency_keys (expires_at);
