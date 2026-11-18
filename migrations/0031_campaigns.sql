CREATE TABLE campaigns (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  niche TEXT NOT NULL,
  region TEXT NOT NULL,
  towns TEXT NOT NULL DEFAULT '[]', -- JSON string[]
  status TEXT NOT NULL DEFAULT 'testing' CHECK (status IN ('testing','active','archived')),
  est_job_value_usd REAL CHECK (est_job_value_usd IS NULL OR est_job_value_usd >= 0),
  created_at TEXT NOT NULL
);

CREATE TABLE sequence_steps (
  id TEXT PRIMARY KEY,
  campaign_id TEXT NOT NULL REFERENCES campaigns(id) ON DELETE CASCADE,
  idx INTEGER NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('email','call','checkin')),
  offset_days INTEGER NOT NULL CHECK (offset_days >= 0),
  offset_kind TEXT NOT NULL CHECK (offset_kind IN ('business','calendar')),
  subject TEXT NOT NULL DEFAULT '',
  variants TEXT NOT NULL DEFAULT '[]', -- JSON string[] of bodies; each may use {Business}, {Name}, {link}, {problem_one}
  body_source TEXT NOT NULL DEFAULT 'variants' CHECK (body_source IN ('variants','draft')), -- 'draft': written per lead from its draft, variants stay empty
  UNIQUE (campaign_id, idx)
);

ALTER TABLE searches ADD COLUMN campaign_id TEXT;
CREATE INDEX idx_searches_campaign ON searches(campaign_id);
