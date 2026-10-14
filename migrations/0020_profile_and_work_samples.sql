-- Who the sender is when writing for a job or contract: a short profile, a structured signature, and the work
-- the drafter is allowed to cite. Nothing outside these fields may be claimed in an email.
ALTER TABLE settings ADD COLUMN role_title TEXT NOT NULL DEFAULT '';
ALTER TABLE settings ADD COLUMN bio TEXT NOT NULL DEFAULT '';
ALTER TABLE settings ADD COLUMN availability TEXT NOT NULL DEFAULT '';
ALTER TABLE settings ADD COLUMN resume_url TEXT NOT NULL DEFAULT '';
ALTER TABLE settings ADD COLUMN goal_line TEXT NOT NULL DEFAULT '';
-- JSON of the signature builder; '' falls back to the plain-text `signature` field.
ALTER TABLE settings ADD COLUMN signature_json TEXT NOT NULL DEFAULT '';
-- What an automatic draft (scan, re-audit) is written for. Full-time is the main goal.
ALTER TABLE settings ADD COLUMN default_purpose TEXT NOT NULL DEFAULT 'full_time';

CREATE TABLE work_samples (
  id TEXT PRIMARY KEY,
  title TEXT NOT NULL,
  url TEXT NOT NULL,
  result_line TEXT NOT NULL DEFAULT '',
  tags TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL
);
