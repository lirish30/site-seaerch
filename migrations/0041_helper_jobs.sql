-- The Mac helper: paired devices and the jobs it works through.
-- `helper_devices.token_hash` is the SHA-256 (hex) of the `hlp_...` bearer token; the token itself is shown once at creation and never stored.
CREATE TABLE helper_devices (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  token_hash TEXT NOT NULL UNIQUE,
  created_at TEXT NOT NULL,
  last_seen_at TEXT,
  revoked_at TEXT
);

-- `kind` is a free string (helper/kinds.ts gives one a meaning). `payload` and `result` are JSON. `claimed_by` is the device holding the claim;
-- a claim older than 20 minutes may be handed out again, and `attempts` counts claims.
CREATE TABLE helper_jobs (
  id TEXT PRIMARY KEY,
  kind TEXT NOT NULL,
  video_id TEXT,
  payload TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','claimed','done','failed','expired')),
  dedupe_key TEXT,
  attempts INTEGER NOT NULL DEFAULT 0,
  claimed_at TEXT,
  claimed_by TEXT,
  result TEXT,
  error TEXT,
  created_at TEXT NOT NULL,
  done_at TEXT
);
-- One open job per (kind, dedupe key): a finished one frees the key.
CREATE UNIQUE INDEX uq_helper_jobs_open ON helper_jobs(kind, dedupe_key) WHERE dedupe_key IS NOT NULL AND status IN ('pending','claimed');
CREATE INDEX idx_helper_jobs_status ON helper_jobs(status, created_at);
CREATE INDEX idx_helper_jobs_video ON helper_jobs(video_id);

-- The agent-actions feed gains a third actor, the helper. SQLite cannot change a CHECK, so the table is rebuilt (same columns, same index).
CREATE TABLE agent_actions_v2 (id TEXT PRIMARY KEY, actor TEXT NOT NULL CHECK (actor IN ('mcp','job','helper')), tool TEXT NOT NULL,
  summary TEXT NOT NULL, record_type TEXT, record_id TEXT, cost_usd REAL NOT NULL DEFAULT 0, created_at TEXT NOT NULL);
INSERT INTO agent_actions_v2 (id, actor, tool, summary, record_type, record_id, cost_usd, created_at)
  SELECT id, actor, tool, summary, record_type, record_id, cost_usd, created_at FROM agent_actions;
DROP TABLE agent_actions;
ALTER TABLE agent_actions_v2 RENAME TO agent_actions;
CREATE INDEX idx_agent_actions_record ON agent_actions(record_type, record_id, created_at);
