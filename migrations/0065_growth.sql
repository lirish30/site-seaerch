-- Growth and retain (Plan 15): a client grade, the retention ladder, auto-approve rules and their log, and the Studio's posts.
-- Times are UTC ISO strings with milliseconds (`created_at`, `updated_at`, `done_at`, `decided_at`). Every `*_on` column is a local date (YYYY-MM-DD) in the booking zone, given by the caller. No secret is stored here.

-- How a client is graded by the owner: A, B or C, with a note. Null when not graded.
ALTER TABLE businesses ADD COLUMN client_grade TEXT CHECK (client_grade IN ('A', 'B', 'C'));
ALTER TABLE businesses ADD COLUMN client_grade_note TEXT NOT NULL DEFAULT '';
ALTER TABLE businesses ADD COLUMN client_grade_set_at TEXT;

-- The steps of the retention ladder for a client: one row per step per due day, worked from `waiting` to `done` or `skipped`.
CREATE TABLE ladder_steps (
  id TEXT PRIMARY KEY,
  business_id TEXT NOT NULL REFERENCES businesses(id),
  project_id TEXT,
  step TEXT NOT NULL CHECK (step IN ('review_request', 'testimonial', 'thank_you', 'check_in', 'case_study', 'december_letter')),
  due_on TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'waiting' CHECK (status IN ('waiting', 'drafted', 'due', 'done', 'skipped')),
  approval_id TEXT,
  link TEXT,
  note TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL,
  done_at TEXT,
  UNIQUE (business_id, step, due_on)
);
CREATE INDEX ladder_steps_due ON ladder_steps (status, due_on);
CREATE INDEX ladder_steps_business ON ladder_steps (business_id, due_on);

-- Which kinds of approval the owner lets go through without a click. Off until switched on; `enabled_at` is when it was last switched on.
CREATE TABLE auto_approve_rules (
  kind TEXT PRIMARY KEY,
  enabled INTEGER NOT NULL DEFAULT 0,
  enabled_at TEXT,
  updated_at TEXT NOT NULL
);

-- What was approved without a click: one row per approval, the outcome of sending it.
CREATE TABLE auto_approvals (
  approval_id TEXT PRIMARY KEY,
  kind TEXT NOT NULL,
  business_id TEXT,
  decided_at TEXT NOT NULL,
  decided_on TEXT NOT NULL,
  outcome TEXT NOT NULL CHECK (outcome IN ('sent', 'failed')),
  error TEXT
);
CREATE INDEX auto_approvals_day ON auto_approvals (decided_on);

-- The Studio's posts (before and after, audit tip, case study). `source`, `copy` and `image_keys` are JSON.
CREATE TABLE studio_posts (
  id TEXT PRIMARY KEY,
  kind TEXT NOT NULL CHECK (kind IN ('before_after', 'audit_tip', 'case_study')),
  status TEXT NOT NULL DEFAULT 'draft' CHECK (status IN ('draft', 'writing', 'review', 'approved', 'posted', 'discarded')),
  business_id TEXT,
  source TEXT NOT NULL DEFAULT '{}',
  anonymize INTEGER NOT NULL DEFAULT 1,
  agreed_at TEXT,
  copy TEXT NOT NULL DEFAULT '{}',
  image_keys TEXT NOT NULL DEFAULT '[]',
  claude_task_id TEXT,
  approval_id TEXT,
  posted_on TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX studio_posts_status ON studio_posts (status, created_at);
