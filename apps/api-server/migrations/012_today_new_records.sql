ALTER TABLE credential_records ADD COLUMN IF NOT EXISTS first_seen_at TEXT;

UPDATE credential_records
SET first_seen_at = COALESCE(NULLIF(first_seen_at, ''), NULLIF(leaked_at, ''), TO_CHAR(CURRENT_TIMESTAMP AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'))
WHERE first_seen_at IS NULL OR first_seen_at = '';

ALTER TABLE credential_records ALTER COLUMN first_seen_at SET DEFAULT TO_CHAR(CURRENT_TIMESTAMP AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"');
CREATE INDEX IF NOT EXISTS credential_records_first_seen_idx ON credential_records(first_seen_at DESC);
