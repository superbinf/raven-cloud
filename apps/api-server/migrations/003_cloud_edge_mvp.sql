CREATE TABLE tenants (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'disabled')),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

INSERT INTO tenants (id, name, status, created_at, updated_at)
SELECT 'TENANT-HISTORICAL', '历史数据迁移租户', 'active', NOW()::TEXT, NOW()::TEXT
WHERE EXISTS (
  SELECT 1 FROM monitoring_targets
  UNION ALL SELECT 1 FROM api_connections
  UNION ALL SELECT 1 FROM credential_subscriptions
  UNION ALL SELECT 1 FROM ingestion_batches
  UNION ALL SELECT 1 FROM sensitive_records
  UNION ALL SELECT 1 FROM asset_records
  UNION ALL SELECT 1 FROM asset_reports
  UNION ALL SELECT 1 FROM dark_web_events
)
ON CONFLICT (id) DO NOTHING;

ALTER TABLE monitoring_targets ADD COLUMN tenant_id TEXT;
ALTER TABLE api_connections ADD COLUMN tenant_id TEXT;
ALTER TABLE credential_subscriptions ADD COLUMN tenant_id TEXT;
ALTER TABLE ingestion_batches ADD COLUMN tenant_id TEXT;
ALTER TABLE sensitive_records ADD COLUMN tenant_id TEXT;
ALTER TABLE asset_records ADD COLUMN tenant_id TEXT;
ALTER TABLE asset_reports ADD COLUMN tenant_id TEXT;
ALTER TABLE dark_web_events ADD COLUMN tenant_id TEXT;

UPDATE monitoring_targets SET tenant_id = 'TENANT-HISTORICAL' WHERE tenant_id IS NULL;
UPDATE api_connections SET tenant_id = 'TENANT-HISTORICAL' WHERE tenant_id IS NULL;
UPDATE credential_subscriptions SET tenant_id = 'TENANT-HISTORICAL' WHERE tenant_id IS NULL;
UPDATE ingestion_batches SET tenant_id = 'TENANT-HISTORICAL' WHERE tenant_id IS NULL;
UPDATE sensitive_records SET tenant_id = 'TENANT-HISTORICAL' WHERE tenant_id IS NULL;
UPDATE asset_records SET tenant_id = 'TENANT-HISTORICAL' WHERE tenant_id IS NULL;
UPDATE asset_reports SET tenant_id = 'TENANT-HISTORICAL' WHERE tenant_id IS NULL;
UPDATE dark_web_events SET tenant_id = 'TENANT-HISTORICAL' WHERE tenant_id IS NULL;

ALTER TABLE monitoring_targets ALTER COLUMN tenant_id SET NOT NULL;
ALTER TABLE api_connections ALTER COLUMN tenant_id SET NOT NULL;
ALTER TABLE credential_subscriptions ALTER COLUMN tenant_id SET NOT NULL;
ALTER TABLE ingestion_batches ALTER COLUMN tenant_id SET NOT NULL;
ALTER TABLE sensitive_records ALTER COLUMN tenant_id SET NOT NULL;
ALTER TABLE asset_records ALTER COLUMN tenant_id SET NOT NULL;
ALTER TABLE asset_reports ALTER COLUMN tenant_id SET NOT NULL;
ALTER TABLE dark_web_events ALTER COLUMN tenant_id SET NOT NULL;

ALTER TABLE monitoring_targets ADD CONSTRAINT monitoring_targets_tenant_fk FOREIGN KEY (tenant_id) REFERENCES tenants(id);
ALTER TABLE api_connections ADD CONSTRAINT api_connections_tenant_fk FOREIGN KEY (tenant_id) REFERENCES tenants(id);
ALTER TABLE credential_subscriptions ADD CONSTRAINT credential_subscriptions_tenant_fk FOREIGN KEY (tenant_id) REFERENCES tenants(id);
ALTER TABLE ingestion_batches ADD CONSTRAINT ingestion_batches_tenant_fk FOREIGN KEY (tenant_id) REFERENCES tenants(id);
ALTER TABLE sensitive_records ADD CONSTRAINT sensitive_records_tenant_fk FOREIGN KEY (tenant_id) REFERENCES tenants(id);
ALTER TABLE asset_records ADD CONSTRAINT asset_records_tenant_fk FOREIGN KEY (tenant_id) REFERENCES tenants(id);
ALTER TABLE asset_reports ADD CONSTRAINT asset_reports_tenant_fk FOREIGN KEY (tenant_id) REFERENCES tenants(id);
ALTER TABLE dark_web_events ADD CONSTRAINT dark_web_events_tenant_fk FOREIGN KEY (tenant_id) REFERENCES tenants(id);

ALTER TABLE sensitive_records DROP CONSTRAINT sensitive_records_record_hash_key;
ALTER TABLE asset_records DROP CONSTRAINT asset_records_record_hash_key;
ALTER TABLE dark_web_events DROP CONSTRAINT dark_web_events_event_hash_key;
CREATE UNIQUE INDEX sensitive_records_tenant_record_hash_uq ON sensitive_records(tenant_id, record_hash);
CREATE UNIQUE INDEX asset_records_tenant_record_hash_uq ON asset_records(tenant_id, record_hash);
CREATE UNIQUE INDEX dark_web_events_tenant_event_hash_uq ON dark_web_events(tenant_id, event_hash);

CREATE INDEX monitoring_targets_tenant_idx ON monitoring_targets(tenant_id, updated_at DESC);
CREATE INDEX api_connections_tenant_idx ON api_connections(tenant_id, id);
CREATE INDEX credential_subscriptions_tenant_idx ON credential_subscriptions(tenant_id, id);
CREATE INDEX ingestion_batches_tenant_idx ON ingestion_batches(tenant_id, created_at DESC);
CREATE INDEX sensitive_records_tenant_idx ON sensitive_records(tenant_id, last_seen_at DESC);
CREATE INDEX asset_records_tenant_idx ON asset_records(tenant_id, last_seen_at DESC);
CREATE INDEX asset_reports_tenant_idx ON asset_reports(tenant_id, created_at DESC);
CREATE INDEX dark_web_events_tenant_idx ON dark_web_events(tenant_id, last_seen_at DESC);

CREATE TABLE edge_deployments (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL REFERENCES tenants(id),
  name TEXT NOT NULL,
  enabled INTEGER NOT NULL DEFAULT 1 CHECK (enabled IN (0, 1)),
  sync_mode TEXT NOT NULL CHECK (sync_mode IN ('api_pull', 'object_storage_pull')),
  poll_interval_seconds INTEGER NOT NULL DEFAULT 300 CHECK (poll_interval_seconds BETWEEN 30 AND 86400),
  config_version INTEGER NOT NULL DEFAULT 1,
  deployment_secret_hash TEXT NOT NULL,
  deployment_secret_enc TEXT NOT NULL,
  last_seen_at TEXT,
  last_applied_snapshot_version BIGINT,
  last_sync_status TEXT,
  last_sync_message TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE INDEX edge_deployments_tenant_idx ON edge_deployments(tenant_id, created_at DESC);

CREATE TABLE edge_snapshots (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL REFERENCES tenants(id),
  deployment_id TEXT NOT NULL REFERENCES edge_deployments(id) ON DELETE CASCADE,
  version BIGINT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('building', 'published', 'failed', 'expired')),
  manifest_json TEXT,
  content_path TEXT,
  object_key TEXT,
  source_hash TEXT,
  sha256 TEXT,
  size_bytes BIGINT,
  created_at TEXT NOT NULL,
  expires_at TEXT,
  UNIQUE(deployment_id, version)
);

CREATE INDEX edge_snapshots_latest_idx ON edge_snapshots(deployment_id, status, version DESC);
