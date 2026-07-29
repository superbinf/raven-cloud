UPDATE sensitive_records
SET import_status = CASE WHEN import_count > 1 THEN '已存在' ELSE '新增' END
WHERE import_status NOT IN ('新增','已存在');

UPDATE asset_records
SET import_status = CASE WHEN import_count > 1 THEN '已存在' ELSE '新增' END
WHERE import_status NOT IN ('新增','已存在');
