-- The mail log: every message sent from or received into a mailbox. `approval_id` is UNIQUE so an
-- approved email can only ever have one outbound row, which is what makes the send once-only.
-- `business_id` is NULL for test messages (they are excluded from the daily send count).
CREATE TABLE messages (
  id TEXT PRIMARY KEY,
  direction TEXT NOT NULL CHECK (direction IN ('out','in')),
  mailbox_key TEXT NOT NULL CHECK (mailbox_key IN ('outreach','main')),
  business_id TEXT,
  enrollment_id TEXT,
  step_index INTEGER,
  approval_id TEXT UNIQUE,
  message_id TEXT,
  in_reply_to TEXT,
  counterpart TEXT NOT NULL,
  subject TEXT NOT NULL DEFAULT '',
  text TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL CHECK (status IN ('sending','sent','failed','received')),
  kind TEXT,
  imap_uid INTEGER,
  created_at TEXT NOT NULL,
  sent_at TEXT
);
CREATE UNIQUE INDEX messages_imap_uid ON messages (mailbox_key, imap_uid) WHERE imap_uid IS NOT NULL;
CREATE INDEX messages_message_id ON messages (message_id);
CREATE INDEX messages_sent ON messages (mailbox_key, direction, status, sent_at);
