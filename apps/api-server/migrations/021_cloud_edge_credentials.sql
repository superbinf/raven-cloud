ALTER TABLE edge_deployments ADD COLUMN IF NOT EXISTS api_key_status TEXT NOT NULL DEFAULT 'active';
ALTER TABLE edge_deployments ADD COLUMN IF NOT EXISTS api_key_version INTEGER NOT NULL DEFAULT 1;
ALTER TABLE edge_deployments ADD COLUMN IF NOT EXISTS api_key_last_rotated_at TEXT;

UPDATE edge_deployments SET api_key_last_rotated_at=COALESCE(api_key_last_rotated_at,created_at);

CREATE TABLE IF NOT EXISTS edge_licenses (
  id TEXT PRIMARY KEY,
  deployment_id TEXT NOT NULL UNIQUE REFERENCES edge_deployments(id) ON DELETE CASCADE,
  tenant_id TEXT NOT NULL REFERENCES tenants(id),
  license_secret_hash TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','revoked')),
  issued_at TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  last_validated_at TEXT,
  updated_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS edge_licenses_status_expiry_idx ON edge_licenses(status,expires_at);
