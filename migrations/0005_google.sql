-- Single connected Google account (Gmail drafts + Drive). The refresh token is AES-GCM encrypted.
CREATE TABLE google_auth (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  email TEXT,
  refresh_token_enc TEXT NOT NULL,
  folder_id TEXT,
  connected_at TEXT NOT NULL
);
