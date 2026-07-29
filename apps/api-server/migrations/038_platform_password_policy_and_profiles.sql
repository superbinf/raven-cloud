ALTER TABLE users
  ADD COLUMN IF NOT EXISTS email TEXT NOT NULL DEFAULT '',
  ADD COLUMN IF NOT EXISTS phone TEXT NOT NULL DEFAULT '',
  ADD COLUMN IF NOT EXISTS department TEXT NOT NULL DEFAULT '',
  ADD COLUMN IF NOT EXISTS password_changed_at TEXT;

UPDATE users
SET password_changed_at=COALESCE(password_changed_at,updated_at,created_at,NOW()::TEXT)
WHERE password_changed_at IS NULL;

CREATE TABLE IF NOT EXISTS platform_password_policy (
  id SMALLINT PRIMARY KEY CHECK (id=1),
  min_length INTEGER NOT NULL CHECK (min_length BETWEEN 8 AND 64),
  max_length INTEGER NOT NULL CHECK (max_length BETWEEN min_length AND 128),
  require_uppercase BOOLEAN NOT NULL,
  require_lowercase BOOLEAN NOT NULL,
  require_number BOOLEAN NOT NULL,
  require_special BOOLEAN NOT NULL,
  history_count INTEGER NOT NULL CHECK (history_count BETWEEN 0 AND 20),
  updated_at TEXT NOT NULL
);

INSERT INTO platform_password_policy
  (id,min_length,max_length,require_uppercase,require_lowercase,require_number,require_special,history_count,updated_at)
VALUES (1,12,128,TRUE,TRUE,TRUE,TRUE,5,NOW()::TEXT)
ON CONFLICT (id) DO NOTHING;

CREATE TABLE IF NOT EXISTS password_history (
  id BIGSERIAL PRIMARY KEY,
  account TEXT NOT NULL REFERENCES users(account) ON DELETE CASCADE,
  password_salt TEXT NOT NULL,
  password_hash TEXT NOT NULL,
  changed_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS password_history_account_idx
  ON password_history(account,changed_at DESC,id DESC);
