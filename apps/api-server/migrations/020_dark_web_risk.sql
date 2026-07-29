ALTER TABLE dark_web_events ADD COLUMN risk TEXT NOT NULL DEFAULT 'low';

ALTER TABLE dark_web_events
  ADD CONSTRAINT dark_web_events_risk_check
  CHECK (risk IN ('critical', 'high', 'medium', 'low'));
