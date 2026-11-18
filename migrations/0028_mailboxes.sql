CREATE TABLE mailboxes (
  key TEXT PRIMARY KEY CHECK (key IN ('outreach','main')),
  enabled INTEGER NOT NULL DEFAULT 0 CHECK (enabled IN (0,1)),
  smtp_host TEXT NOT NULL DEFAULT '', smtp_port INTEGER NOT NULL DEFAULT 465,
  imap_host TEXT NOT NULL DEFAULT '', imap_port INTEGER NOT NULL DEFAULT 993,
  username TEXT NOT NULL DEFAULT '', from_email TEXT NOT NULL DEFAULT '', from_name TEXT NOT NULL DEFAULT '',
  warmup_started_at TEXT, imap_uid_validity INTEGER, imap_last_uid INTEGER, last_sync_at TEXT, last_sync_error TEXT
);
INSERT INTO mailboxes (key) VALUES ('outreach'), ('main');
