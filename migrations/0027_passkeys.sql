CREATE TABLE passkeys (id TEXT PRIMARY KEY, credential_id TEXT NOT NULL UNIQUE, public_key TEXT NOT NULL, counter INTEGER NOT NULL,
  transports TEXT, nickname TEXT, created_at TEXT NOT NULL, last_used_at TEXT);
CREATE TABLE auth_challenges (challenge TEXT PRIMARY KEY, purpose TEXT NOT NULL CHECK (purpose IN ('register','login')), expires_at TEXT NOT NULL);
