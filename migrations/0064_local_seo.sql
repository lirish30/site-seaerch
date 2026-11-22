-- Local SEO (Plan 14): the profile, keywords, weekly rank checks, Google Business Profile snapshots, reviews, monthly content, citations and monthly reports of a local client.
-- Times are UTC ISO strings with milliseconds (`created_at`, `updated_at`). Every `*_on` and `taken_on` column is a local date (YYYY-MM-DD) in the booking zone, given by the caller. No secret is stored here.

-- One row per client: who the business is as the world should see it (name, address, phone), where it is, and how the watch runs.
CREATE TABLE seo_profiles (
  business_id TEXT PRIMARY KEY REFERENCES businesses(id),
  site_id TEXT,
  place_id TEXT,
  maps_url TEXT,
  nap_name TEXT NOT NULL DEFAULT '',
  nap_address TEXT NOT NULL DEFAULT '',
  nap_phone TEXT NOT NULL DEFAULT '',
  lat REAL,
  lng REAL,
  trade TEXT NOT NULL DEFAULT '',
  towns TEXT NOT NULL DEFAULT '[]',
  grid_km REAL NOT NULL DEFAULT 3,
  status TEXT NOT NULL DEFAULT 'setup' CHECK (status IN ('setup', 'active', 'paused')),
  last_watch_on TEXT,
  nap_result TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

-- The searches a client wants to be found for: a term, and the town it is searched in ('' for none).
CREATE TABLE seo_keywords (
  id TEXT PRIMARY KEY,
  business_id TEXT NOT NULL REFERENCES businesses(id),
  term TEXT NOT NULL,
  town TEXT NOT NULL DEFAULT '',
  active INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL,
  UNIQUE (business_id, term, town)
);

-- One check per keyword per day. `points` is a JSON array of 9 grid points: { lat, lng, pos (null when not found), ok }.
CREATE TABLE seo_rank_checks (
  id TEXT PRIMARY KEY,
  business_id TEXT NOT NULL REFERENCES businesses(id),
  keyword_id TEXT NOT NULL REFERENCES seo_keywords(id),
  taken_on TEXT NOT NULL,
  points TEXT NOT NULL,
  created_at TEXT NOT NULL,
  UNIQUE (keyword_id, taken_on)
);
CREATE INDEX seo_rank_checks_business ON seo_rank_checks (business_id, taken_on);

-- One snapshot of the Google Business Profile per client per day.
CREATE TABLE seo_gbp_snapshots (
  business_id TEXT NOT NULL REFERENCES businesses(id),
  taken_on TEXT NOT NULL,
  rating REAL,
  review_count INTEGER,
  category TEXT,
  photo_count INTEGER,
  has_hours INTEGER,
  created_at TEXT NOT NULL,
  PRIMARY KEY (business_id, taken_on)
);

-- Reviews the watch has seen, once each (by the platform's id), and where each stands on getting a reply.
CREATE TABLE seo_reviews (
  id TEXT PRIMARY KEY,
  business_id TEXT NOT NULL REFERENCES businesses(id),
  external_id TEXT NOT NULL,
  rating INTEGER NOT NULL,
  author TEXT NOT NULL,
  body TEXT NOT NULL,
  published_at TEXT,
  first_seen_on TEXT NOT NULL,
  reply_status TEXT NOT NULL DEFAULT 'new' CHECK (reply_status IN ('new', 'drafting', 'drafted', 'posted', 'skipped')),
  reply_draft TEXT NOT NULL DEFAULT '',
  flagged INTEGER NOT NULL DEFAULT 0,
  claude_task_id TEXT,
  created_at TEXT NOT NULL,
  UNIQUE (business_id, external_id)
);

-- The month's planned pages and posts: one row per (client, period YYYY-MM, kind, slot).
CREATE TABLE seo_content (
  id TEXT PRIMARY KEY,
  business_id TEXT NOT NULL REFERENCES businesses(id),
  period TEXT NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('page', 'post', 'gbp_post')),
  slot INTEGER NOT NULL,
  keyword_id TEXT,
  brief TEXT NOT NULL,
  title TEXT NOT NULL DEFAULT '',
  meta_title TEXT NOT NULL DEFAULT '',
  meta_description TEXT NOT NULL DEFAULT '',
  body TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL DEFAULT 'planned' CHECK (status IN ('planned', 'drafting', 'drafted', 'approved', 'published', 'rejected')),
  claude_task_id TEXT,
  url TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE (business_id, period, kind, slot)
);

-- The directories a client should be listed in, and whether each one is.
CREATE TABLE seo_citations (
  id TEXT PRIMARY KEY,
  business_id TEXT NOT NULL REFERENCES businesses(id),
  directory TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'todo' CHECK (status IN ('todo', 'listed', 'needs_fix', 'not_applicable')),
  url TEXT,
  note TEXT NOT NULL DEFAULT '',
  checked_on TEXT,
  created_at TEXT NOT NULL,
  UNIQUE (business_id, directory)
);

-- One report per client per period (YYYY-MM), the same shape as care_reports plus up to three priorities (a JSON array of strings) for the month ahead.
CREATE TABLE seo_reports (
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
  priorities TEXT NOT NULL DEFAULT '[]',
  UNIQUE (business_id, period)
);
