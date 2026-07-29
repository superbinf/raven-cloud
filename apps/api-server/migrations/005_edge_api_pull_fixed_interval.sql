UPDATE edge_deployments SET sync_mode='api_pull', poll_interval_seconds=300;

ALTER TABLE edge_deployments ALTER COLUMN sync_mode SET DEFAULT 'api_pull';
ALTER TABLE edge_deployments ALTER COLUMN poll_interval_seconds SET DEFAULT 300;
ALTER TABLE edge_deployments DROP CONSTRAINT IF EXISTS edge_deployments_sync_mode_check;
ALTER TABLE edge_deployments DROP CONSTRAINT IF EXISTS edge_deployments_poll_interval_seconds_check;
ALTER TABLE edge_deployments ADD CONSTRAINT edge_deployments_sync_mode_check CHECK (sync_mode='api_pull');
ALTER TABLE edge_deployments ADD CONSTRAINT edge_deployments_poll_interval_seconds_check CHECK (poll_interval_seconds=300);
