-- The Claude task queue. Work that needs Claude's judgement (classify a reply and draft the answer, for now) is queued here and picked up
-- by Claude Code over MCP, so it runs on the subscription and never the paid API. A row is the unit of work; `kind` names the work and is
-- deliberately NOT constrained, so a later kind needs no migration. `payload` is JSON whose shape the kind defines.
-- Lifecycle: pending -> claimed -> done | failed. A claim older than 30 minutes is reclaimed (`attempts` counts claims); `expired` is for the
-- sweeper that gives up on work nobody picked up.
CREATE TABLE claude_tasks (
  id TEXT PRIMARY KEY,
  kind TEXT NOT NULL,
  payload TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('pending','claimed','done','failed','expired')),
  dedupe_key TEXT,
  attempts INTEGER NOT NULL DEFAULT 0,
  result TEXT,
  error TEXT,
  created_at TEXT NOT NULL,
  claimed_at TEXT,
  done_at TEXT
);
-- At most one open task per (kind, dedupe_key): enqueueing the same work twice returns the first. A finished task frees the key.
CREATE UNIQUE INDEX uq_claude_tasks_open ON claude_tasks(kind, dedupe_key) WHERE dedupe_key IS NOT NULL AND status IN ('pending','claimed');
CREATE INDEX idx_claude_tasks_status ON claude_tasks(status, created_at);
