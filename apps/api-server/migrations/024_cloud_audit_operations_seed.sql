INSERT INTO audit_logs (id,occurred_at,context,actor_account,actor_name,actor_role,action,resource_type,resource_id,method,path,status_code,result,ip_address,request_id,detail_json)
VALUES ('AUDIT-SYSTEM-OPERATIONS-INITIAL',NOW()::TEXT,'operations','system','系统','系统','启用运营审计','audit','operations-audit','MIGRATION','024_cloud_audit_operations_seed.sql',200,'success','','migration-024','{}')
ON CONFLICT(id) DO NOTHING;
