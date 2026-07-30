ALTER TABLE audit_logs
  ADD COLUMN IF NOT EXISTS tenant_id TEXT REFERENCES tenants(id) ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS audit_logs_tenant_time_idx
  ON audit_logs(tenant_id,occurred_at DESC,id DESC);

ALTER TABLE credential_records
  DROP CONSTRAINT IF EXISTS credential_records_sub_id_fkey;

ALTER TABLE credential_subscriptions
  ALTER COLUMN id TYPE BIGINT USING id::BIGINT;

ALTER TABLE credential_records
  ALTER COLUMN sub_id TYPE BIGINT USING sub_id::BIGINT;

CREATE SEQUENCE IF NOT EXISTS credential_subscription_internal_id_seq
  AS BIGINT
  MINVALUE 4000000000000000
  MAXVALUE 9007199254740991
  START WITH 4000000000000000;

ALTER SEQUENCE credential_subscription_internal_id_seq
  OWNED BY credential_subscriptions.id;

ALTER TABLE credential_subscriptions
  ALTER COLUMN id SET DEFAULT nextval('credential_subscription_internal_id_seq');

ALTER TABLE credential_subscriptions
  ADD COLUMN IF NOT EXISTS source_connection_id TEXT REFERENCES api_connections(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS upstream_id TEXT;

CREATE UNIQUE INDEX IF NOT EXISTS credential_subscriptions_upstream_identity_uq
  ON credential_subscriptions(tenant_id,source_connection_id,upstream_id)
  WHERE source_connection_id IS NOT NULL AND upstream_id IS NOT NULL;

ALTER TABLE credential_records
  ADD COLUMN IF NOT EXISTS tenant_id TEXT,
  ADD COLUMN IF NOT EXISTS source_connection_id TEXT REFERENCES api_connections(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS upstream_id TEXT;

UPDATE credential_records records
SET tenant_id=subscriptions.tenant_id
FROM credential_subscriptions subscriptions
WHERE subscriptions.id=records.sub_id
  AND records.tenant_id IS NULL;

ALTER TABLE credential_records
  ALTER COLUMN tenant_id SET NOT NULL;

ALTER TABLE credential_records
  ADD CONSTRAINT credential_records_tenant_fk
  FOREIGN KEY (tenant_id) REFERENCES tenants(id);

CREATE UNIQUE INDEX IF NOT EXISTS credential_subscriptions_id_tenant_uq
  ON credential_subscriptions(id,tenant_id);

ALTER TABLE credential_records
  ADD CONSTRAINT credential_records_subscription_tenant_fk
  FOREIGN KEY (sub_id,tenant_id) REFERENCES credential_subscriptions(id,tenant_id);

CREATE INDEX IF NOT EXISTS credential_records_tenant_time_idx
  ON credential_records(tenant_id,first_seen_at DESC,id);

CREATE UNIQUE INDEX IF NOT EXISTS credential_records_upstream_identity_uq
  ON credential_records(tenant_id,source_connection_id,upstream_id)
  WHERE source_connection_id IS NOT NULL AND upstream_id IS NOT NULL;

ALTER TABLE background_task_outbox
  ADD COLUMN IF NOT EXISTS tenant_id TEXT REFERENCES tenants(id) ON DELETE SET NULL;

ALTER TABLE background_task_runs
  ADD COLUMN IF NOT EXISTS tenant_id TEXT REFERENCES tenants(id) ON DELETE SET NULL;

UPDATE background_task_outbox outbox
SET tenant_id=connections.tenant_id
FROM collection_runs runs
JOIN api_connections connections ON connections.id=runs.connection_id
WHERE outbox.aggregate_type='collection_run'
  AND outbox.aggregate_id=runs.id
  AND outbox.tenant_id IS NULL;

UPDATE background_task_outbox outbox
SET tenant_id=deployments.tenant_id
FROM edge_snapshot_jobs jobs
JOIN edge_deployments deployments ON deployments.id=jobs.deployment_id
WHERE outbox.aggregate_type='snapshot_job'
  AND outbox.aggregate_id=jobs.id
  AND outbox.tenant_id IS NULL;

UPDATE background_task_runs runs
SET tenant_id=connections.tenant_id
FROM collection_runs collection_run
JOIN api_connections connections ON connections.id=collection_run.connection_id
WHERE runs.aggregate_type='collection_run'
  AND runs.aggregate_id=collection_run.id
  AND runs.tenant_id IS NULL;

UPDATE background_task_runs runs
SET tenant_id=deployments.tenant_id
FROM edge_snapshot_jobs jobs
JOIN edge_deployments deployments ON deployments.id=jobs.deployment_id
WHERE runs.aggregate_type='snapshot_job'
  AND runs.aggregate_id=jobs.id
  AND runs.tenant_id IS NULL;

CREATE INDEX IF NOT EXISTS background_task_outbox_tenant_status_idx
  ON background_task_outbox(tenant_id,status,available_at);

CREATE INDEX IF NOT EXISTS background_task_runs_tenant_started_idx
  ON background_task_runs(tenant_id,started_at DESC,id DESC);
