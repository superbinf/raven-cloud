CREATE TABLE IF NOT EXISTS captcha_challenges (
  token_hash TEXT PRIMARY KEY,
  answer_hash TEXT NOT NULL,
  expires_at TIMESTAMPTZ NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS captcha_challenges_expires_idx ON captcha_challenges(expires_at);
