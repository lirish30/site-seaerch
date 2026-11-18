CREATE TABLE agent_actions (id TEXT PRIMARY KEY, actor TEXT NOT NULL CHECK (actor IN ('mcp','job')), tool TEXT NOT NULL,
  summary TEXT NOT NULL, record_type TEXT, record_id TEXT, cost_usd REAL NOT NULL DEFAULT 0, created_at TEXT NOT NULL);
CREATE INDEX idx_agent_actions_record ON agent_actions(record_type, record_id, created_at);
