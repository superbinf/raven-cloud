ALTER TABLE collection_runs ALTER COLUMN started_at DROP NOT NULL;
ALTER TABLE collection_jobs ADD COLUMN IF NOT EXISTS system_managed INTEGER NOT NULL DEFAULT 0;
ALTER TABLE collection_runs ADD COLUMN IF NOT EXISTS bullmq_job_id TEXT;
ALTER TABLE collection_runs ADD COLUMN IF NOT EXISTS scheduled_for TEXT;
ALTER TABLE collection_runs ADD COLUMN IF NOT EXISTS requested_at TEXT;
ALTER TABLE collection_runs ADD COLUMN IF NOT EXISTS updated_at TEXT;

UPDATE collection_runs
SET requested_at=COALESCE(requested_at,started_at,finished_at,NOW()::TEXT),
    updated_at=COALESCE(updated_at,finished_at,started_at,NOW()::TEXT);

CREATE UNIQUE INDEX IF NOT EXISTS collection_runs_active_uq
  ON collection_runs(job_id)
  WHERE status IN ('排队中','运行中','重试中');
CREATE INDEX IF NOT EXISTS collection_runs_status_updated_idx
  ON collection_runs(status,updated_at);
CREATE INDEX IF NOT EXISTS sessions_expires_at_idx ON sessions(expires_at);
CREATE INDEX IF NOT EXISTS edge_snapshots_expiration_idx
  ON edge_snapshots(status,expires_at);
CREATE INDEX IF NOT EXISTS edge_snapshot_jobs_status_updated_idx
  ON edge_snapshot_jobs(status,updated_at);
