ALTER TABLE background_task_runs ADD COLUMN IF NOT EXISTS aggregate_type TEXT;
ALTER TABLE background_task_runs ADD COLUMN IF NOT EXISTS aggregate_id TEXT;
ALTER TABLE background_task_runs ADD COLUMN IF NOT EXISTS worker_instance_id TEXT;
ALTER TABLE background_task_runs ADD COLUMN IF NOT EXISTS max_attempts INTEGER NOT NULL DEFAULT 1;
ALTER TABLE background_task_runs ADD COLUMN IF NOT EXISTS queued_at TEXT;
ALTER TABLE background_task_runs ADD COLUMN IF NOT EXISTS queue_latency_ms INTEGER;
ALTER TABLE background_task_runs ADD COLUMN IF NOT EXISTS duration_ms INTEGER;
ALTER TABLE background_task_runs ADD COLUMN IF NOT EXISTS will_retry BOOLEAN;
ALTER TABLE background_task_runs ADD COLUMN IF NOT EXISTS next_retry_at TEXT;
ALTER TABLE background_task_runs ADD COLUMN IF NOT EXISTS error_type TEXT;
ALTER TABLE background_task_runs ADD COLUMN IF NOT EXISTS error_code TEXT;
ALTER TABLE background_task_runs ADD COLUMN IF NOT EXISTS upstream_method TEXT;
ALTER TABLE background_task_runs ADD COLUMN IF NOT EXISTS upstream_status INTEGER;
ALTER TABLE background_task_runs ADD COLUMN IF NOT EXISTS upstream_content_type TEXT;
ALTER TABLE background_task_runs ADD COLUMN IF NOT EXISTS upstream_origin TEXT;
ALTER TABLE background_task_runs ADD COLUMN IF NOT EXISTS upstream_path TEXT;

UPDATE background_task_runs
SET max_attempts=GREATEST(attempt,1),
    duration_ms=CASE
      WHEN finished_at IS NOT NULL THEN GREATEST(0,(EXTRACT(EPOCH FROM (finished_at::timestamptz-started_at::timestamptz))*1000)::INTEGER)
      ELSE NULL
    END
WHERE duration_ms IS NULL;

CREATE INDEX IF NOT EXISTS background_task_runs_aggregate_idx
  ON background_task_runs(aggregate_type,aggregate_id,started_at DESC);
CREATE INDEX IF NOT EXISTS background_task_runs_task_started_idx
  ON background_task_runs(task_identifier,started_at DESC);
