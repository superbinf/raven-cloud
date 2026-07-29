ALTER TABLE fingerprint_watch_groups
  ADD COLUMN is_default BOOLEAN NOT NULL DEFAULT FALSE;

CREATE UNIQUE INDEX fingerprint_watch_groups_default_tenant_uq
  ON fingerprint_watch_groups(tenant_id)
  WHERE is_default=TRUE;

ALTER TABLE vulnerability_alerts
  ALTER COLUMN asset_record_id DROP NOT NULL;

CREATE UNIQUE INDEX vulnerability_alerts_unmatched_uq
  ON vulnerability_alerts(vulnerability_id,watch_item_id)
  WHERE asset_record_id IS NULL;
