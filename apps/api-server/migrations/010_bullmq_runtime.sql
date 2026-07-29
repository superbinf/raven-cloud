DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema=current_schema() AND table_name='collection_runs' AND column_name='graphile_job_id') THEN
    ALTER TABLE collection_runs RENAME COLUMN graphile_job_id TO bullmq_job_id;
  END IF;
  IF EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema=current_schema() AND table_name='edge_snapshot_jobs' AND column_name='graphile_job_id') THEN
    ALTER TABLE edge_snapshot_jobs RENAME COLUMN graphile_job_id TO bullmq_job_id;
  END IF;
END $$;

UPDATE background_task_schedules
SET identifier='cleanup_bullmq_history',
    task_identifier='cleanup_bullmq_history',
    label='BullMQ 队列历史清理',
    updated_at=NOW()::TEXT
WHERE identifier='cleanup_graphile_catalog';

CREATE TABLE background_task_outbox (
  id BIGSERIAL PRIMARY KEY,
  job_key TEXT NOT NULL UNIQUE,
  queue_role TEXT NOT NULL CHECK (queue_role IN ('scheduler','snapshot','io','maintenance')),
  task_identifier TEXT NOT NULL,
  payload_json TEXT NOT NULL,
  max_attempts INTEGER NOT NULL DEFAULT 3 CHECK (max_attempts BETWEEN 1 AND 100),
  aggregate_type TEXT,
  aggregate_id TEXT,
  status TEXT NOT NULL CHECK (status IN ('pending','published')),
  bullmq_job_id TEXT,
  available_at TEXT NOT NULL,
  published_at TEXT,
  last_error TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE INDEX background_task_outbox_pending_idx
  ON background_task_outbox(status,available_at);

CREATE TABLE background_task_runs (
  id BIGSERIAL PRIMARY KEY,
  bullmq_job_id TEXT NOT NULL,
  queue_role TEXT NOT NULL,
  task_identifier TEXT NOT NULL,
  trigger_type TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('running','succeeded','failed')),
  attempt INTEGER NOT NULL,
  started_at TEXT NOT NULL,
  finished_at TEXT,
  error_message TEXT
);

CREATE INDEX background_task_runs_job_idx
  ON background_task_runs(bullmq_job_id,started_at DESC);
CREATE INDEX background_task_runs_status_idx
  ON background_task_runs(status,started_at DESC);

CREATE TABLE worker_instances (
  instance_id TEXT PRIMARY KEY,
  role TEXT NOT NULL,
  process_id INTEGER NOT NULL,
  started_at TEXT NOT NULL,
  last_heartbeat_at TEXT NOT NULL,
  stopped_at TEXT,
  status TEXT NOT NULL CHECK (status IN ('running','stopped'))
);

CREATE INDEX worker_instances_health_idx
  ON worker_instances(status,last_heartbeat_at);

INSERT INTO background_task_outbox
  (job_key,queue_role,task_identifier,payload_json,max_attempts,aggregate_type,aggregate_id,status,available_at,created_at,updated_at)
SELECT 'execute_collection_job:'||id,'io','execute_collection_job',json_build_object('runId',id)::TEXT,3,
       'collection_run',id,'pending',NOW()::TEXT,NOW()::TEXT,NOW()::TEXT
FROM collection_runs
WHERE status IN ('排队中','运行中','重试中')
ON CONFLICT(job_key) DO NOTHING;

INSERT INTO background_task_outbox
  (job_key,queue_role,task_identifier,payload_json,max_attempts,aggregate_type,aggregate_id,status,available_at,created_at,updated_at)
SELECT 'build_edge_snapshot:'||id,'snapshot','build_edge_snapshot',json_build_object('operationId',id)::TEXT,5,
       'snapshot_job',id,'pending',NOW()::TEXT,NOW()::TEXT,NOW()::TEXT
FROM edge_snapshot_jobs
WHERE status IN ('queued','running','retrying')
ON CONFLICT(job_key) DO NOTHING;

DROP VIEW IF EXISTS jobs;
DROP FUNCTION IF EXISTS add_job CASCADE;
DROP FUNCTION IF EXISTS add_jobs CASCADE;
DROP FUNCTION IF EXISTS complete_jobs CASCADE;
DROP FUNCTION IF EXISTS force_unlock_workers CASCADE;
DROP FUNCTION IF EXISTS permanently_fail_jobs CASCADE;
DROP FUNCTION IF EXISTS remove_job CASCADE;
DROP FUNCTION IF EXISTS reschedule_jobs CASCADE;
DROP TABLE IF EXISTS _private_jobs CASCADE;
DROP TABLE IF EXISTS _private_job_queues CASCADE;
DROP TABLE IF EXISTS _private_tasks CASCADE;
DROP TABLE IF EXISTS _private_known_crontabs CASCADE;
DROP TABLE IF EXISTS migrations CASCADE;
DROP TYPE IF EXISTS job_spec CASCADE;
