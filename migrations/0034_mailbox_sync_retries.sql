-- A message that cannot be applied holds the sync cursor so it is retried. These two columns bound that: how many runs in a row failed
-- while the cursor sat at `imap_fail_cursor`. After the limit the sync moves past the window instead of starving the mailbox forever.
ALTER TABLE mailboxes ADD COLUMN imap_fail_count INTEGER NOT NULL DEFAULT 0;
ALTER TABLE mailboxes ADD COLUMN imap_fail_cursor INTEGER;
