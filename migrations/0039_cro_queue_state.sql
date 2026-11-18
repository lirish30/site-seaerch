-- The CRO audit's Claude stages now run through the Claude queue, so an audit can sit `waiting` (a status, not a new column: `status` has no CHECK).
-- `pending_pages` is the JSON list of page indexes still awaiting a review, so the audit knows when the last one is in. `stages_at` is when the
-- queued stages were last started (a rebuild or retry sets it again): a task queued before it belongs to a superseded run and is discarded as stale.
ALTER TABLE cro_audits ADD COLUMN pending_pages TEXT NOT NULL DEFAULT '[]';
ALTER TABLE cro_audits ADD COLUMN stages_at TEXT;
