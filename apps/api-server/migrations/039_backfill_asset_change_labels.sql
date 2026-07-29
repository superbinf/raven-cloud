UPDATE asset_records
SET change_type = 'missing',
    last_changed_at = COALESCE(last_changed_at, missing_since, last_seen_at)
WHERE change_type = 'baseline'
  AND (import_status = '已消失' OR present_in_latest_batch = FALSE);

UPDATE asset_records
SET change_type = 'changed',
    last_changed_at = COALESCE(last_changed_at, last_seen_at)
WHERE change_type = 'baseline'
  AND (
    import_status = '状态变化'
    OR (
      previous_fields_json IS NOT NULL
      AND BTRIM(previous_fields_json) <> ''
      AND previous_fields_json::jsonb IS DISTINCT FROM fields_json::jsonb
    )
  );

UPDATE asset_records
SET change_type = 'reappeared',
    last_changed_at = COALESCE(last_changed_at, last_seen_at)
WHERE change_type = 'baseline'
  AND import_status = '重新出现';

UPDATE asset_records
SET change_type = 'unchanged'
WHERE change_type = 'baseline'
  AND import_count > 1;
