-- Suppression and ownership list: domains and place IDs the user never wants searched, drafted for or exported
-- (existing clients, opt-outs, competitors, deals in flight). Values are stored normalized (domains via domainOf).
CREATE TABLE suppressions (
  id TEXT PRIMARY KEY,
  kind TEXT NOT NULL CHECK (kind IN ('domain','place_id')),
  value TEXT NOT NULL,
  reason TEXT NOT NULL,
  note TEXT,
  created_at TEXT NOT NULL,
  UNIQUE(kind, value)
);
