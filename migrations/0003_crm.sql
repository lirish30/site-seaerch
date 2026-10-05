-- CRM: archive, follow-up, deal value, people (points of contact) and an activity log per lead.
ALTER TABLE businesses ADD COLUMN archived_at TEXT;
ALTER TABLE businesses ADD COLUMN follow_up_at TEXT;
ALTER TABLE businesses ADD COLUMN deal_value REAL;
CREATE INDEX idx_businesses_archived ON businesses(archived_at);

CREATE TABLE people (
  id TEXT PRIMARY KEY,
  business_id TEXT NOT NULL,
  name TEXT NOT NULL,
  role TEXT,
  email TEXT,
  phone TEXT,
  linkedin TEXT,
  source TEXT NOT NULL DEFAULT 'manual',
  is_poc INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL
);
CREATE INDEX idx_people_business ON people(business_id);

CREATE TABLE activity (
  id TEXT PRIMARY KEY,
  business_id TEXT NOT NULL,
  kind TEXT NOT NULL,
  detail TEXT,
  created_at TEXT NOT NULL
);
CREATE INDEX idx_activity_business ON activity(business_id, created_at);
