-- How many times the listing fetch has failed and is being retried, so the progress card can say so. While a search is
-- still 'running', `error` holds the last of those failures; it is cleared when a fetch succeeds.
ALTER TABLE searches ADD COLUMN fetch_attempts INTEGER NOT NULL DEFAULT 0;
