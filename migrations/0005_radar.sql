CREATE TABLE radars (
  id TEXT PRIMARY KEY,
  location TEXT NOT NULL,
  business_type TEXT NOT NULL,
  radius_km REAL NOT NULL,
  max_results INTEGER NOT NULL,
  interval_days INTEGER NOT NULL DEFAULT 30,
  enabled INTEGER NOT NULL DEFAULT 1,
  next_run_at TEXT NOT NULL,
  last_run_at TEXT,
  last_search_id TEXT,
  last_error TEXT,
  created_at TEXT NOT NULL
);
-- Two radars for the same market would run (and bill) the same search twice.
CREATE UNIQUE INDEX idx_radars_market ON radars(location COLLATE NOCASE, business_type COLLATE NOCASE);
CREATE INDEX idx_radars_due ON radars(enabled, next_run_at);
