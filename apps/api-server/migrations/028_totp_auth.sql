ALTER TABLE users ADD COLUMN IF NOT EXISTS totp_secret_enc TEXT;
ALTER TABLE users ADD COLUMN IF NOT EXISTS totp_enabled INTEGER NOT NULL DEFAULT 0;

CREATE TABLE IF NOT EXISTS auth_challenges (
  token_hash TEXT PRIMARY KEY,
  account TEXT NOT NULL REFERENCES users(account) ON DELETE CASCADE,
  purpose TEXT NOT NULL DEFAULT 'login',
  details_json TEXT NOT NULL DEFAULT '{}',
  expires_at TEXT NOT NULL,
  attempts INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS auth_challenges_account_idx ON auth_challenges(account);
CREATE INDEX IF NOT EXISTS auth_challenges_purpose_idx ON auth_challenges(purpose);
CREATE INDEX IF NOT EXISTS auth_challenges_expires_idx ON auth_challenges(expires_at);
