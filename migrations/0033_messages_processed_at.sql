-- Inbound mail is stored first and its effects (stop, bounce, activity) applied second. `processed_at` is stamped once the effects are
-- done, so a sync that crashed in between finds the row with NULL here on its next run and finishes the job instead of skipping it.
ALTER TABLE messages ADD COLUMN processed_at TEXT;
