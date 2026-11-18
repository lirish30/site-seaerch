CREATE TABLE approvals (
  id TEXT PRIMARY KEY, kind TEXT NOT NULL, title TEXT NOT NULL, preview TEXT NOT NULL, payload TEXT NOT NULL,
  record_type TEXT, record_id TEXT, drafted_by TEXT NOT NULL CHECK (drafted_by IN ('job','mcp','logan')),
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','approved','rejected')),
  error TEXT, decision_note TEXT, created_at TEXT NOT NULL, decided_at TEXT);
CREATE INDEX idx_approvals_status ON approvals(status, created_at);
CREATE INDEX idx_approvals_record ON approvals(record_type, record_id);
