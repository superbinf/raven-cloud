DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM tenants
    WHERE id = 'TENANT-CHANGAN'
      AND name = '重庆长安汽车股份有限公司'
  )
  AND NOT EXISTS (SELECT 1 FROM monitoring_targets WHERE tenant_id = 'TENANT-CHANGAN')
  AND NOT EXISTS (SELECT 1 FROM api_connections WHERE tenant_id = 'TENANT-CHANGAN')
  AND NOT EXISTS (SELECT 1 FROM credential_subscriptions WHERE tenant_id = 'TENANT-CHANGAN')
  AND NOT EXISTS (SELECT 1 FROM ingestion_batches WHERE tenant_id = 'TENANT-CHANGAN')
  AND NOT EXISTS (SELECT 1 FROM sensitive_records WHERE tenant_id = 'TENANT-CHANGAN')
  AND NOT EXISTS (SELECT 1 FROM asset_records WHERE tenant_id = 'TENANT-CHANGAN')
  AND NOT EXISTS (SELECT 1 FROM asset_reports WHERE tenant_id = 'TENANT-CHANGAN')
  AND NOT EXISTS (SELECT 1 FROM dark_web_events WHERE tenant_id = 'TENANT-CHANGAN')
  AND NOT EXISTS (SELECT 1 FROM vulnerability_records WHERE tenant_id = 'TENANT-CHANGAN')
  AND NOT EXISTS (SELECT 1 FROM vulnerability_alerts WHERE tenant_id = 'TENANT-CHANGAN')
  AND NOT EXISTS (SELECT 1 FROM vulnerability_suppressions WHERE tenant_id = 'TENANT-CHANGAN')
  AND NOT EXISTS (SELECT 1 FROM edge_deployments WHERE tenant_id = 'TENANT-CHANGAN')
  AND NOT EXISTS (SELECT 1 FROM edge_snapshots WHERE tenant_id = 'TENANT-CHANGAN')
  AND NOT EXISTS (SELECT 1 FROM edge_licenses WHERE tenant_id = 'TENANT-CHANGAN')
  AND NOT EXISTS (
    SELECT 1 FROM fingerprint_watch_groups
    WHERE tenant_id = 'TENANT-CHANGAN' AND is_default = FALSE
  ) THEN
    DELETE FROM fingerprint_watch_groups
    WHERE tenant_id = 'TENANT-CHANGAN' AND is_default = TRUE;

    DELETE FROM tenants
    WHERE id = 'TENANT-CHANGAN'
      AND name = '重庆长安汽车股份有限公司';
  END IF;
END $$;
