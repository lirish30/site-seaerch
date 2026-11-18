-- Where a lead hires: the public job board found on its careers page, and the roles seen on it.
-- status: active = a board we poll; none = no readable board (rechecked monthly); error = discovery failed (retried daily).
-- last_ok_at is the last time the board answered with valid JSON; NULL means the next sync is the first look (a baseline).
CREATE TABLE career_sources (
  business_id TEXT PRIMARY KEY,
  status TEXT NOT NULL,
  ats TEXT,
  token TEXT,
  careers_url TEXT,
  checked_at TEXT,
  last_ok_at TEXT,
  next_check_at TEXT NOT NULL,
  empty_streak INTEGER NOT NULL DEFAULT 0,
  last_error TEXT,
  created_at TEXT NOT NULL
);
CREATE INDEX idx_career_sources_due ON career_sources(status, next_check_at);

-- baseline = found on the first successful look at the board, so "first seen" says nothing about how old the role is.
CREATE TABLE job_postings (
  id TEXT PRIMARY KEY,
  business_id TEXT NOT NULL,
  external_id TEXT NOT NULL,
  title TEXT NOT NULL,
  url TEXT NOT NULL,
  location TEXT,
  department TEXT,
  role_kind TEXT,
  posted_at TEXT,
  first_seen_at TEXT NOT NULL,
  last_seen_at TEXT NOT NULL,
  closed_at TEXT,
  baseline INTEGER NOT NULL DEFAULT 0,
  UNIQUE (business_id, external_id)
);
CREATE INDEX idx_job_postings_business ON job_postings(business_id, closed_at);
-- Only open roles in our field are ever listed, so only they are indexed.
CREATE INDEX idx_job_postings_open_relevant ON job_postings(business_id) WHERE closed_at IS NULL AND role_kind IS NOT NULL;
