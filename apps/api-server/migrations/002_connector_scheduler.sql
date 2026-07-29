ALTER TABLE api_connections ADD COLUMN IF NOT EXISTS provider_type TEXT NOT NULL DEFAULT 'generic_json';
ALTER TABLE api_connections ADD COLUMN IF NOT EXISTS config_json TEXT NOT NULL DEFAULT '{}';
ALTER TABLE api_connections ADD COLUMN IF NOT EXISTS enabled INTEGER NOT NULL DEFAULT 1;
ALTER TABLE api_connections ADD COLUMN IF NOT EXISTS consecutive_failures INTEGER NOT NULL DEFAULT 0;
ALTER TABLE api_connections ADD COLUMN IF NOT EXISTS last_sync_at TEXT;

UPDATE api_connections SET provider_type='darkweb_subscription' WHERE category='凭据泄露' AND provider_type='generic_json';

CREATE TABLE IF NOT EXISTS collection_jobs (
  id TEXT PRIMARY KEY,
  connection_id TEXT NOT NULL REFERENCES api_connections(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  enabled INTEGER NOT NULL DEFAULT 0,
  interval_minutes INTEGER NOT NULL DEFAULT 60 CHECK (interval_minutes BETWEEN 5 AND 10080),
  timeout_seconds INTEGER NOT NULL DEFAULT 60 CHECK (timeout_seconds BETWEEN 5 AND 600),
  retry_limit INTEGER NOT NULL DEFAULT 2 CHECK (retry_limit BETWEEN 0 AND 10),
  next_run_at TEXT,
  last_run_at TEXT,
  last_status TEXT NOT NULL DEFAULT '从未运行',
  last_message TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE(connection_id)
);

CREATE TABLE IF NOT EXISTS collection_runs (
  id TEXT PRIMARY KEY,
  job_id TEXT NOT NULL REFERENCES collection_jobs(id) ON DELETE CASCADE,
  connection_id TEXT NOT NULL REFERENCES api_connections(id) ON DELETE CASCADE,
  trigger_type TEXT NOT NULL,
  status TEXT NOT NULL,
  attempt INTEGER NOT NULL DEFAULT 1,
  started_at TEXT NOT NULL,
  finished_at TEXT,
  message TEXT,
  result_json TEXT
);

CREATE INDEX IF NOT EXISTS collection_jobs_due_idx ON collection_jobs(enabled, next_run_at);
CREATE INDEX IF NOT EXISTS collection_runs_job_idx ON collection_runs(job_id, started_at DESC);
