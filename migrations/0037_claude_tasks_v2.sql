-- The Claude task queue, second version. Two changes to `claude_tasks` (0036):
--   * `status` also allows 'stale': the work was valid when queued but its target changed or went away before Claude finished, so nothing was applied.
--   * `target_type` / `target_id` say what a task is about (for example a lead), so the app can close a target's open tasks when the target goes away.
-- SQLite cannot alter a CHECK constraint, so the table is rebuilt: copy the rows across, swap the table in, and recreate both indexes.
CREATE TABLE claude_tasks_v2 (
  id TEXT PRIMARY KEY,
  kind TEXT NOT NULL,
  payload TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('pending','claimed','done','failed','expired','stale')),
  dedupe_key TEXT,
  attempts INTEGER NOT NULL DEFAULT 0,
  result TEXT,
  error TEXT,
  created_at TEXT NOT NULL,
  claimed_at TEXT,
  done_at TEXT,
  target_type TEXT,
  target_id TEXT
);
INSERT INTO claude_tasks_v2 (id, kind, payload, status, dedupe_key, attempts, result, error, created_at, claimed_at, done_at)
  SELECT id, kind, payload, status, dedupe_key, attempts, result, error, created_at, claimed_at, done_at FROM claude_tasks;
DROP TABLE claude_tasks;
ALTER TABLE claude_tasks_v2 RENAME TO claude_tasks;
-- At most one open task per (kind, dedupe_key): enqueueing the same work twice returns the first. A finished task frees the key.
CREATE UNIQUE INDEX uq_claude_tasks_open ON claude_tasks(kind, dedupe_key) WHERE dedupe_key IS NOT NULL AND status IN ('pending','claimed');
CREATE INDEX idx_claude_tasks_status ON claude_tasks(status, created_at);
