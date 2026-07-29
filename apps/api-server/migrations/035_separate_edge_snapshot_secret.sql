ALTER TABLE edge_deployments
  ADD COLUMN IF NOT EXISTS snapshot_secret_enc TEXT;

UPDATE edge_deployments
SET snapshot_secret_enc=deployment_secret_enc
WHERE snapshot_secret_enc IS NULL OR snapshot_secret_enc='';

ALTER TABLE edge_deployments
  ALTER COLUMN snapshot_secret_enc SET NOT NULL;
