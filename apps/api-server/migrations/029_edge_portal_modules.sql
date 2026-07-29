ALTER TABLE edge_deployments
  ADD COLUMN IF NOT EXISTS enabled_modules_json TEXT NOT NULL
  DEFAULT '["overview","dashboard","search","dark-web","sensitive","exposure","vulnerabilities"]';
