-- 0.2.0: owner token + lease for claims, and the 'uncertain' status.
-- Run after 001, once every 0.1.x process using this table has stopped (see
-- "Upgrading from 0.1.0" in the README).
--
-- Rows written by 0.1.0 get NULL owner / lease_expires_at; a NULL lease on a
-- 'pending' row is treated as expired, so those rows stay recoverable.
--
-- Safe to re-run. lock_timeout makes the ALTERs give up instead of queueing
-- behind a long transaction and blocking all traffic on the table; if it times
-- out, just run the file again.

BEGIN;

SET LOCAL lock_timeout = '5s';

-- Metadata-only (no default, no rewrite): needs a brief ACCESS EXCLUSIVE lock.
ALTER TABLE idempotency_keys ADD COLUMN IF NOT EXISTS owner TEXT;
ALTER TABLE idempotency_keys ADD COLUMN IF NOT EXISTS lease_expires_at BIGINT;

-- Drop every CHECK constraint on "status", whatever it is named (001 creates an
-- inline one that Postgres names idempotency_keys_status_check; ORMs may differ).
DO $$
DECLARE
  constraint_name TEXT;
BEGIN
  FOR constraint_name IN
    SELECT c.conname
    FROM pg_constraint c
    JOIN pg_attribute a ON a.attrelid = c.conrelid AND a.attnum = ANY (c.conkey)
    WHERE c.conrelid = 'idempotency_keys'::regclass
      AND c.contype = 'c'
      AND a.attname = 'status'
  LOOP
    EXECUTE format('ALTER TABLE idempotency_keys DROP CONSTRAINT %I', constraint_name);
  END LOOP;
END
$$;

-- NOT VALID skips the full-table scan while holding the exclusive lock.
ALTER TABLE idempotency_keys ADD CONSTRAINT idempotency_keys_status_check
  CHECK (status IN ('pending', 'completed', 'failed', 'uncertain')) NOT VALID;

COMMIT;

-- Validates existing rows under a SHARE UPDATE EXCLUSIVE lock (reads and writes continue).
ALTER TABLE idempotency_keys VALIDATE CONSTRAINT idempotency_keys_status_check;
