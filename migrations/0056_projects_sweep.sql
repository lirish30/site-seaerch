-- The daily project sweep starts projects for signed, paid proposals that have none (a start that failed once is never replayed by the payment itself).
-- It takes the least recently looked-at documents first, so a document that can never get a project (a Local SEO sale with no template yet, or one that keeps failing)
-- takes its turn and then waits behind the rest instead of filling the sweep's window for good.
ALTER TABLE documents ADD COLUMN projects_checked_at TEXT;
