CREATE TABLE edge_snapshot_jobs (
  id TEXT PRIMARY KEY,
  deployment_id TEXT NOT NULL REFERENCES edge_deployments(id) ON DELETE CASCADE,
  force_build INTEGER NOT NULL DEFAULT 0 CHECK (force_build IN (0, 1)),
  trigger_type TEXT NOT NULL CHECK (trigger_type IN ('create', 'manual', 'schedule')),
  status TEXT NOT NULL CHECK (status IN ('queued', 'running', 'retrying', 'succeeded', 'failed')),
  bullmq_job_id TEXT,
  snapshot_id TEXT REFERENCES edge_snapshots(id) ON DELETE SET NULL,
  reused INTEGER CHECK (reused IN (0, 1)),
  attempts INTEGER NOT NULL DEFAULT 0,
  error_message TEXT,
  requested_at TEXT NOT NULL,
  started_at TEXT,
  finished_at TEXT,
  updated_at TEXT NOT NULL
);

CREATE INDEX edge_snapshot_jobs_deployment_idx
  ON edge_snapshot_jobs(deployment_id, requested_at DESC);

CREATE UNIQUE INDEX edge_snapshot_jobs_active_uq
  ON edge_snapshot_jobs(deployment_id)
  WHERE status IN ('queued', 'running', 'retrying');
