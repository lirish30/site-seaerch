-- The do-not-contact list: emails, domains and company names that outreach must never write to. Entered by hand; nothing is seeded.
CREATE TABLE do_not_contact (
  id TEXT PRIMARY KEY,
  kind TEXT NOT NULL CHECK (kind IN ('email','domain','name')),
  value TEXT NOT NULL,
  reason TEXT NOT NULL CHECK (reason IN ('client','opt_out','competitor','active_deal','bounced','webfor','other')),
  note TEXT,
  created_at TEXT NOT NULL,
  UNIQUE (kind, value)
);
