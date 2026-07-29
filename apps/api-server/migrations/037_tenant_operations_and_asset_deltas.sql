CREATE TABLE IF NOT EXISTS tenant_publication_policies (
  tenant_id TEXT NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  module TEXT NOT NULL CHECK (module IN ('sensitive','asset','dark-web','credentials','vulnerabilities')),
  mode TEXT NOT NULL CHECK (mode IN ('auto','approval')),
  updated_at TEXT NOT NULL,
  PRIMARY KEY (tenant_id,module)
);

INSERT INTO tenant_publication_policies (tenant_id,module,mode,updated_at)
SELECT tenant.id,defaults.module,defaults.mode,NOW()::TEXT
FROM tenants tenant
CROSS JOIN (VALUES
  ('sensitive','approval'),
  ('asset','approval'),
  ('dark-web','approval'),
  ('credentials','auto'),
  ('vulnerabilities','auto')
) AS defaults(module,mode)
ON CONFLICT (tenant_id,module) DO NOTHING;

ALTER TABLE credential_records
  ADD COLUMN IF NOT EXISTS is_published BOOLEAN NOT NULL DEFAULT TRUE,
  ADD COLUMN IF NOT EXISTS reviewed_at TEXT;

ALTER TABLE asset_records
  ADD COLUMN IF NOT EXISTS change_type TEXT NOT NULL DEFAULT 'baseline'
    CHECK (change_type IN ('baseline','new','changed','reappeared','missing','unchanged')),
  ADD COLUMN IF NOT EXISTS previous_fields_json TEXT,
  ADD COLUMN IF NOT EXISTS present_in_latest_batch BOOLEAN NOT NULL DEFAULT TRUE,
  ADD COLUMN IF NOT EXISTS previously_published BOOLEAN NOT NULL DEFAULT FALSE,
  ADD COLUMN IF NOT EXISTS last_changed_at TEXT,
  ADD COLUMN IF NOT EXISTS missing_since TEXT;

ALTER TABLE ingestion_batches
  ADD COLUMN IF NOT EXISTS changed_rows INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS missing_rows INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS unchanged_rows INTEGER NOT NULL DEFAULT 0;

DROP INDEX IF EXISTS asset_records_tenant_record_hash_uq;
CREATE UNIQUE INDEX IF NOT EXISTS asset_records_tenant_target_record_hash_uq
  ON asset_records(tenant_id,target_id,record_hash);

CREATE INDEX IF NOT EXISTS asset_records_tenant_change_idx
  ON asset_records(tenant_id,target_id,change_type,last_changed_at DESC);
CREATE INDEX IF NOT EXISTS credential_records_publish_idx
  ON credential_records(is_published,first_seen_at DESC);
