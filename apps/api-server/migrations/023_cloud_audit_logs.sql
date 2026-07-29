CREATE TABLE IF NOT EXISTS audit_logs (
  id TEXT PRIMARY KEY,
  occurred_at TEXT NOT NULL,
  context TEXT NOT NULL CHECK (context IN ('operations','management')),
  actor_account TEXT NOT NULL DEFAULT '',
  actor_name TEXT NOT NULL DEFAULT '',
  actor_role TEXT NOT NULL DEFAULT '',
  action TEXT NOT NULL,
  resource_type TEXT NOT NULL,
  resource_id TEXT NOT NULL DEFAULT '',
  method TEXT NOT NULL,
  path TEXT NOT NULL,
  status_code INTEGER NOT NULL,
  result TEXT NOT NULL CHECK (result IN ('success','failed')),
  ip_address TEXT NOT NULL DEFAULT '',
  request_id TEXT NOT NULL,
  detail_json TEXT NOT NULL DEFAULT '{}'
);

CREATE INDEX IF NOT EXISTS audit_logs_context_time_idx ON audit_logs(context,occurred_at DESC,id DESC);
CREATE INDEX IF NOT EXISTS audit_logs_actor_time_idx ON audit_logs(actor_account,occurred_at DESC);
CREATE INDEX IF NOT EXISTS audit_logs_resource_idx ON audit_logs(resource_type,resource_id,occurred_at DESC);

INSERT INTO audit_logs (id,occurred_at,context,actor_account,actor_name,actor_role,action,resource_type,resource_id,method,path,status_code,result,ip_address,request_id,detail_json)
VALUES ('AUDIT-SYSTEM-INITIAL',NOW()::TEXT,'management','system','系统','系统','启用云端审计','audit','cloud-audit','MIGRATION','023_cloud_audit_logs.sql',200,'success','','migration-023','{}')
ON CONFLICT(id) DO NOTHING;

INSERT INTO audit_logs (id,occurred_at,context,actor_account,actor_name,actor_role,action,resource_type,resource_id,method,path,status_code,result,ip_address,request_id,detail_json)
VALUES ('AUDIT-SYSTEM-OPERATIONS-INITIAL',NOW()::TEXT,'operations','system','系统','系统','启用运营审计','audit','operations-audit','MIGRATION','023_cloud_audit_logs.sql',200,'success','','migration-023-operations','{}')
ON CONFLICT(id) DO NOTHING;
