INSERT INTO tenants (id,name,status,created_at,updated_at)
SELECT 'TENANT-XINGHAI','星海科技','active',NOW()::TEXT,NOW()::TEXT
WHERE EXISTS (
  SELECT 1 FROM monitoring_targets
  WHERE id='OBJ-001' AND tenant_id='TENANT-CHANGAN' AND name='星海科技'
)
ON CONFLICT(id) DO NOTHING;

UPDATE api_connections SET tenant_id='TENANT-XINGHAI'
WHERE target_id='OBJ-001' AND tenant_id='TENANT-CHANGAN'
  AND EXISTS (SELECT 1 FROM monitoring_targets WHERE id='OBJ-001' AND tenant_id='TENANT-CHANGAN' AND name='星海科技');
UPDATE asset_records SET tenant_id='TENANT-XINGHAI'
WHERE target_id='OBJ-001' AND tenant_id='TENANT-CHANGAN'
  AND EXISTS (SELECT 1 FROM monitoring_targets WHERE id='OBJ-001' AND tenant_id='TENANT-CHANGAN' AND name='星海科技');
UPDATE asset_reports SET tenant_id='TENANT-XINGHAI'
WHERE target_id='OBJ-001' AND tenant_id='TENANT-CHANGAN'
  AND EXISTS (SELECT 1 FROM monitoring_targets WHERE id='OBJ-001' AND tenant_id='TENANT-CHANGAN' AND name='星海科技');
UPDATE credential_subscriptions SET tenant_id='TENANT-XINGHAI'
WHERE target_id='OBJ-001' AND tenant_id='TENANT-CHANGAN'
  AND EXISTS (SELECT 1 FROM monitoring_targets WHERE id='OBJ-001' AND tenant_id='TENANT-CHANGAN' AND name='星海科技');
UPDATE dark_web_events SET tenant_id='TENANT-XINGHAI'
WHERE target_id='OBJ-001' AND tenant_id='TENANT-CHANGAN'
  AND EXISTS (SELECT 1 FROM monitoring_targets WHERE id='OBJ-001' AND tenant_id='TENANT-CHANGAN' AND name='星海科技');
UPDATE ingestion_batches SET tenant_id='TENANT-XINGHAI'
WHERE target_id='OBJ-001' AND tenant_id='TENANT-CHANGAN'
  AND EXISTS (SELECT 1 FROM monitoring_targets WHERE id='OBJ-001' AND tenant_id='TENANT-CHANGAN' AND name='星海科技');
UPDATE sensitive_records SET tenant_id='TENANT-XINGHAI'
WHERE target_id='OBJ-001' AND tenant_id='TENANT-CHANGAN'
  AND EXISTS (SELECT 1 FROM monitoring_targets WHERE id='OBJ-001' AND tenant_id='TENANT-CHANGAN' AND name='星海科技');
UPDATE vulnerability_alerts SET tenant_id='TENANT-XINGHAI'
WHERE target_id='OBJ-001' AND tenant_id='TENANT-CHANGAN'
  AND EXISTS (SELECT 1 FROM monitoring_targets WHERE id='OBJ-001' AND tenant_id='TENANT-CHANGAN' AND name='星海科技');
UPDATE vulnerability_records SET tenant_id='TENANT-XINGHAI'
WHERE target_id='OBJ-001' AND tenant_id='TENANT-CHANGAN'
  AND EXISTS (SELECT 1 FROM monitoring_targets WHERE id='OBJ-001' AND tenant_id='TENANT-CHANGAN' AND name='星海科技');

UPDATE monitoring_targets SET tenant_id='TENANT-XINGHAI',updated_at=NOW()::TEXT
WHERE id='OBJ-001' AND tenant_id='TENANT-CHANGAN' AND name='星海科技';
