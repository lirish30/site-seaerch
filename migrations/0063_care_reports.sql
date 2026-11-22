-- Care reports (Plan 13): a monthly report per client, built from facts the system already holds, with a short summary Claude drafts and Logan approves.
-- Times are UTC ISO strings with milliseconds. A report is reached by an unguessable token; no secret is stored here.

-- A task Logan marks as a change the client asked for; the report counts these as edit requests.
ALTER TABLE tasks ADD COLUMN edit_request INTEGER NOT NULL DEFAULT 0 CHECK (edit_request IN (0, 1));

-- One row per site per day: how many uptime checks ran and how many passed. `day` is the local date (YYYY-MM-DD) in the booking zone.
CREATE TABLE site_uptime_days (
  site_id TEXT NOT NULL,
  day TEXT NOT NULL,
  checks INTEGER NOT NULL,
  ok_checks INTEGER NOT NULL,
  PRIMARY KEY (site_id, day)
);

-- One report per client per period (YYYY-MM). `facts` is a JSON snapshot taken when the report is made; the summary and recommendation are the words around it.
CREATE TABLE care_reports (
  id TEXT PRIMARY KEY,
  business_id TEXT NOT NULL REFERENCES businesses(id),
  period TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('collecting', 'ready', 'sent', 'revoked', 'cancelled')),
  token TEXT NOT NULL UNIQUE,
  facts TEXT NOT NULL,
  summary TEXT NOT NULL DEFAULT '',
  recommendation TEXT NOT NULL DEFAULT '',
  summary_source TEXT NOT NULL DEFAULT 'none' CHECK (summary_source IN ('none', 'claude', 'plain', 'logan')),
  claude_task_id TEXT,
  approval_id TEXT,
  test INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  ready_at TEXT,
  sent_at TEXT,
  first_viewed_at TEXT,
  view_count INTEGER NOT NULL DEFAULT 0,
  revoked_at TEXT,
  UNIQUE (business_id, period)
);
