-- Measure and show (Plan 16): the Google properties linked to a client's site, the monthly traffic facts pulled from them, the yearly strategy memo, and a short video for a report.
-- Times are UTC ISO strings with milliseconds. `period` is a booking-zone month (YYYY-MM). `facts` and `body` are JSON. No secret is stored here: the Google refresh token lives in the Worker's secrets, never in a table.

-- Which Google properties belong to a site. A column left null is a source that is not linked (a report leaves that section out; it never shows 0).
-- `last_error` is the plain-words reason the last read failed; empty when it worked. No ON DELETE CASCADE, like sites: a site with history is archived, never deleted.
CREATE TABLE site_analytics (
  site_id TEXT PRIMARY KEY REFERENCES sites(id),
  gsc_property TEXT,
  ga4_property TEXT,
  gbp_location TEXT,
  linked_at TEXT NOT NULL,
  checked_at TEXT,
  last_error TEXT NOT NULL DEFAULT ''
);

-- One row per site per month: what Google reported for it. `ok` is a complete pull and is never replaced by a worse one; `partial` read only some sources; `failed` read none (`attempts` counts the tries).
CREATE TABLE traffic_months (
  site_id TEXT NOT NULL,
  period TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('ok', 'partial', 'failed')),
  facts TEXT NOT NULL,
  pulled_at TEXT NOT NULL,
  attempts INTEGER NOT NULL DEFAULT 1,
  error TEXT NOT NULL DEFAULT '',
  PRIMARY KEY (site_id, period)
);

-- The strategy memo of a client: numbered per client (`version`), reached by an unguessable token, with `facts` taken when it is made and `body` Claude's words around them.
-- A client has at most one open memo (`collecting` or `ready`) at a time.
CREATE TABLE strategy_memos (
  id TEXT PRIMARY KEY,
  business_id TEXT NOT NULL REFERENCES businesses(id),
  version INTEGER NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('collecting', 'ready', 'sent', 'revoked', 'cancelled')),
  token TEXT NOT NULL UNIQUE,
  facts TEXT NOT NULL,
  body TEXT NOT NULL DEFAULT '{}',
  claude_task_id TEXT,
  approval_id TEXT,
  test INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  ready_at TEXT,
  sent_at TEXT,
  first_viewed_at TEXT,
  view_count INTEGER NOT NULL DEFAULT 0,
  revoked_at TEXT,
  UNIQUE (business_id, version)
);
CREATE UNIQUE INDEX uq_strategy_memos_open ON strategy_memos (business_id) WHERE status IN ('collecting', 'ready');

-- A short video that goes with a Care or Local SEO report: one per report. The video and its poster are keys in the files bucket.
CREATE TABLE report_videos (
  id TEXT PRIMARY KEY,
  report_kind TEXT NOT NULL CHECK (report_kind IN ('care', 'seo')),
  report_id TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('queued', 'rendered', 'failed', 'discarded')),
  video_key TEXT,
  poster_key TEXT,
  duration_ms INTEGER,
  error TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL,
  UNIQUE (report_kind, report_id)
);
