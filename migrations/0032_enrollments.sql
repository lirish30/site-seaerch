-- One sequence run per lead. `next_step_index`/`next_due_at` say which step is next and when it may be proposed (an approval
-- is created, never a send). `next_due_at` stays NULL until step 0 is actually sent: the due time is computed from the send.
-- `last_sent_step` is the highest step whose email was recorded as sent; it makes the after-send advance idempotent.
CREATE TABLE enrollments (
  id TEXT PRIMARY KEY,
  business_id TEXT NOT NULL,
  campaign_id TEXT NOT NULL,
  mailbox_key TEXT NOT NULL CHECK (mailbox_key IN ('outreach','main')),
  to_email TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('active','nurture','replied','stopped','bounced','completed')),
  next_step_index INTEGER NOT NULL,
  next_due_at TEXT,
  started_at TEXT NOT NULL,
  last_sent_at TEXT,
  last_error TEXT,
  stopped_reason TEXT,
  last_sent_step INTEGER
);
-- A lead is in at most one live sequence.
CREATE UNIQUE INDEX uq_enroll_business ON enrollments(business_id) WHERE status IN ('active','nurture');
CREATE INDEX idx_enroll_due ON enrollments(status, next_due_at);
