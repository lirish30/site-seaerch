-- The daily project sweep starts projects for signed, paid proposals that have none (a start that failed once is never replayed by the payment itself).
-- It takes the least recently looked-at documents first, so a document that can never get a project (a Local SEO sale with no template yet, or one that keeps failing)
-- takes its turn and then waits behind the rest instead of filling the sweep's window for good.
ALTER TABLE documents ADD COLUMN projects_checked_at TEXT;
-- Today's capped count, `failedJobCount` and the in-flight count look jobs up by the step they are about (target_id, with or without target_type), and `cancelTasksFor` by (target_type, target_id).
-- Nothing indexed those columns. target_id leads, so all of those can use it.
CREATE INDEX idx_claude_tasks_target ON claude_tasks(target_id, target_type);
