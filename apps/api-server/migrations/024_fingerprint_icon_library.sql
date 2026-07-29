CREATE TABLE IF NOT EXISTS fingerprint_icon_library (
  id TEXT PRIMARY KEY,
  fingerprint_name TEXT NOT NULL,
  aliases_json JSONB NOT NULL DEFAULT '[]'::jsonb,
  source TEXT NOT NULL DEFAULT 'upload',
  source_url TEXT,
  media_type TEXT NOT NULL,
  icon_data TEXT NOT NULL,
  icon_sha256 TEXT NOT NULL,
  active BOOLEAN NOT NULL DEFAULT TRUE,
  created_by TEXT,
  updated_by TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT fingerprint_icon_library_source_check CHECK (source IN ('upload', 'favicon', 'iconify', 'simple-icons', 'custom')),
  CONSTRAINT fingerprint_icon_library_name_check CHECK (char_length(trim(fingerprint_name)) BETWEEN 1 AND 160)
);

CREATE UNIQUE INDEX IF NOT EXISTS fingerprint_icon_library_name_uq ON fingerprint_icon_library (lower(trim(fingerprint_name)));
CREATE INDEX IF NOT EXISTS fingerprint_icon_library_aliases_idx ON fingerprint_icon_library USING GIN (aliases_json);
CREATE INDEX IF NOT EXISTS fingerprint_icon_library_updated_idx ON fingerprint_icon_library (updated_at DESC);
