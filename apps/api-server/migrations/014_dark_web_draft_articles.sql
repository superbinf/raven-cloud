ALTER TABLE dark_web_events ADD COLUMN is_published BOOLEAN NOT NULL DEFAULT TRUE;
ALTER TABLE dark_web_events ADD COLUMN reviewed_at TEXT;
ALTER TABLE dark_web_events ADD COLUMN article_markdown TEXT NOT NULL DEFAULT '';

CREATE INDEX IF NOT EXISTS dark_web_events_public_idx
  ON dark_web_events(tenant_id, is_published, published_at DESC);
