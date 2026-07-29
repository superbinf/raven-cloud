ALTER TABLE edge_deployments DROP CONSTRAINT IF EXISTS edge_deployments_poll_interval_seconds_check;
ALTER TABLE edge_deployments ALTER COLUMN poll_interval_seconds SET DEFAULT 3600;
ALTER TABLE edge_deployments ADD CONSTRAINT edge_deployments_poll_interval_seconds_check CHECK (poll_interval_seconds BETWEEN 30 AND 86400);

UPDATE edge_deployments
SET poll_interval_seconds=3600,
    config_version=config_version+1,
    updated_at=NOW()
WHERE poll_interval_seconds=300;
