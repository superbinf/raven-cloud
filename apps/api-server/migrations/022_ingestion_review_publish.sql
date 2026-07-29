ALTER TABLE sensitive_records
  ADD COLUMN IF NOT EXISTS is_published BOOLEAN NOT NULL DEFAULT TRUE,
  ADD COLUMN IF NOT EXISTS reviewed_at TEXT;

ALTER TABLE asset_records
  ADD COLUMN IF NOT EXISTS is_published BOOLEAN NOT NULL DEFAULT TRUE,
  ADD COLUMN IF NOT EXISTS reviewed_at TEXT;

ALTER TABLE vulnerability_records
  ADD COLUMN IF NOT EXISTS is_published BOOLEAN NOT NULL DEFAULT TRUE,
  ADD COLUMN IF NOT EXISTS reviewed_at TEXT;

ALTER TABLE asset_reports
  ADD COLUMN IF NOT EXISTS is_published BOOLEAN NOT NULL DEFAULT TRUE,
  ADD COLUMN IF NOT EXISTS batch_id TEXT REFERENCES ingestion_batches(id) ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS sensitive_records_publish_idx
  ON sensitive_records(tenant_id,is_published,last_seen_at DESC);
CREATE INDEX IF NOT EXISTS asset_records_publish_idx
  ON asset_records(tenant_id,is_published,last_seen_at DESC);
CREATE INDEX IF NOT EXISTS vulnerability_records_publish_idx
  ON vulnerability_records(tenant_id,is_published,source_updated_at DESC);
