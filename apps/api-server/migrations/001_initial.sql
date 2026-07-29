CREATE TABLE IF NOT EXISTS monitoring_targets (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  target_type TEXT NOT NULL,
  owner TEXT NOT NULL,
  domains_json TEXT NOT NULL,
  ips_json TEXT NOT NULL,
  keywords_json TEXT NOT NULL,
  enabled INTEGER NOT NULL DEFAULT 1,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS api_connections (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  category TEXT NOT NULL,
  endpoint TEXT NOT NULL,
  method TEXT NOT NULL DEFAULT 'POST',
  auth_mode TEXT NOT NULL DEFAULT 'API Key',
  api_key_enc TEXT,
  target_id TEXT REFERENCES monitoring_targets(id),
  status TEXT NOT NULL DEFAULT '未配置',
  success_rate DOUBLE PRECISION NOT NULL DEFAULT 0,
  quota TEXT NOT NULL DEFAULT '--',
  last_called TEXT NOT NULL DEFAULT '--',
  last_test_message TEXT,
  last_test_at TEXT
);

CREATE TABLE IF NOT EXISTS credential_subscriptions (
  id INTEGER PRIMARY KEY,
  target_id TEXT NOT NULL REFERENCES monitoring_targets(id),
  sub_type TEXT NOT NULL,
  sub_category TEXT NOT NULL,
  user_permission_id TEXT,
  value TEXT NOT NULL,
  expire_time TEXT NOT NULL,
  count INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS credential_records (
  id TEXT PRIMARY KEY,
  sub_id INTEGER NOT NULL REFERENCES credential_subscriptions(id),
  url TEXT NOT NULL,
  system_name TEXT NOT NULL,
  account TEXT NOT NULL,
  password TEXT NOT NULL,
  leaked_at TEXT NOT NULL,
  source TEXT NOT NULL,
  raw_json TEXT
);

CREATE TABLE IF NOT EXISTS users (
  account TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  role TEXT NOT NULL,
  password_salt TEXT NOT NULL,
  password_hash TEXT NOT NULL,
  enabled INTEGER NOT NULL DEFAULT 1,
  workspace TEXT NOT NULL DEFAULT 'portal',
  role_key TEXT NOT NULL DEFAULT 'portal-viewer',
  last_login_at TEXT,
  created_at TEXT,
  updated_at TEXT
);

CREATE TABLE IF NOT EXISTS sessions (
  token_hash TEXT PRIMARY KEY,
  account TEXT NOT NULL REFERENCES users(account),
  expires_at TEXT NOT NULL,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS ingestion_batches (
  id TEXT PRIMARY KEY,
  file_name TEXT NOT NULL,
  target_id TEXT,
  status TEXT NOT NULL,
  total_rows INTEGER NOT NULL DEFAULT 0,
  new_rows INTEGER NOT NULL DEFAULT 0,
  duplicate_rows INTEGER NOT NULL DEFAULT 0,
  sheet_summary_json TEXT NOT NULL,
  created_at TEXT NOT NULL,
  ingestion_type TEXT NOT NULL DEFAULT 'sensitive'
);

CREATE TABLE IF NOT EXISTS sensitive_records (
  id TEXT PRIMARY KEY,
  category TEXT NOT NULL,
  target_id TEXT,
  title TEXT NOT NULL,
  risk TEXT NOT NULL,
  fields_json TEXT NOT NULL,
  record_hash TEXT NOT NULL UNIQUE,
  first_seen_at TEXT NOT NULL,
  last_seen_at TEXT NOT NULL,
  import_status TEXT NOT NULL,
  import_count INTEGER NOT NULL DEFAULT 1,
  batch_id TEXT,
  status TEXT NOT NULL DEFAULT '待处置'
);

CREATE TABLE IF NOT EXISTS asset_records (
  id TEXT PRIMARY KEY,
  category TEXT NOT NULL,
  target_id TEXT,
  title TEXT NOT NULL,
  risk TEXT NOT NULL,
  fields_json TEXT NOT NULL,
  record_hash TEXT NOT NULL UNIQUE,
  first_seen_at TEXT NOT NULL,
  last_seen_at TEXT NOT NULL,
  import_status TEXT NOT NULL,
  import_count INTEGER NOT NULL DEFAULT 1,
  batch_id TEXT,
  status TEXT NOT NULL DEFAULT '待处置'
);

CREATE TABLE IF NOT EXISTS asset_reports (
  id TEXT PRIMARY KEY,
  target_id TEXT REFERENCES monitoring_targets(id),
  file_name TEXT NOT NULL,
  file_path TEXT NOT NULL,
  data_path TEXT,
  size_bytes INTEGER NOT NULL,
  dns_count INTEGER NOT NULL DEFAULT 0,
  port_count INTEGER NOT NULL DEFAULT 0,
  web_count INTEGER NOT NULL DEFAULT 0,
  fingerprint_count INTEGER NOT NULL DEFAULT 0,
  icon_count INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS dark_web_events (
  id TEXT PRIMARY KEY,
  target_id TEXT NOT NULL REFERENCES monitoring_targets(id),
  latest_batch_id TEXT NOT NULL REFERENCES ingestion_batches(id),
  title TEXT NOT NULL,
  report_date TEXT NOT NULL,
  source_group_name TEXT NOT NULL,
  source_group_id TEXT NOT NULL,
  source_group_url TEXT NOT NULL,
  message_url TEXT NOT NULL,
  leak_data_types TEXT NOT NULL,
  leak_count TEXT NOT NULL,
  transaction_count TEXT NOT NULL,
  transaction_price TEXT NOT NULL,
  published_at TEXT NOT NULL,
  publisher_id TEXT NOT NULL,
  intel_note TEXT NOT NULL,
  event_hash TEXT NOT NULL UNIQUE,
  first_seen_at TEXT NOT NULL,
  last_seen_at TEXT NOT NULL,
  import_count INTEGER NOT NULL DEFAULT 1
);

CREATE TABLE IF NOT EXISTS dark_web_blobs (
  sha256 TEXT PRIMARY KEY,
  stored_name TEXT NOT NULL,
  size_bytes INTEGER NOT NULL,
  media_type TEXT NOT NULL,
  iv_b64 TEXT NOT NULL,
  auth_tag_b64 TEXT NOT NULL,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS dark_web_files (
  id TEXT PRIMARY KEY,
  batch_id TEXT NOT NULL REFERENCES ingestion_batches(id),
  event_id TEXT REFERENCES dark_web_events(id),
  blob_sha256 TEXT NOT NULL REFERENCES dark_web_blobs(sha256),
  kind TEXT NOT NULL,
  original_name TEXT NOT NULL,
  sheet_count INTEGER NOT NULL DEFAULT 0,
  row_count INTEGER NOT NULL DEFAULT 0,
  column_count INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  UNIQUE(batch_id, event_id, blob_sha256, kind)
);

CREATE INDEX IF NOT EXISTS sensitive_records_target_idx ON sensitive_records(target_id);
CREATE INDEX IF NOT EXISTS sensitive_records_last_seen_idx ON sensitive_records(last_seen_at DESC);
CREATE INDEX IF NOT EXISTS asset_records_target_idx ON asset_records(target_id);
CREATE INDEX IF NOT EXISTS asset_records_last_seen_idx ON asset_records(last_seen_at DESC);
CREATE INDEX IF NOT EXISTS dark_web_events_target_idx ON dark_web_events(target_id);
CREATE INDEX IF NOT EXISTS credential_records_sub_idx ON credential_records(sub_id);
