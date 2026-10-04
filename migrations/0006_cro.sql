-- On-demand CRO audits: evidence ledger, AI stage outputs, and the ranked roadmap items.
CREATE TABLE cro_audits (
  id TEXT PRIMARY KEY,
  business_id TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'running',
  step TEXT NOT NULL DEFAULT 'capture',
  error TEXT,
  warning TEXT,
  partial INTEGER NOT NULL DEFAULT 0,
  pages TEXT NOT NULL DEFAULT '[]',
  evidence TEXT NOT NULL DEFAULT '[]',
  business_model TEXT,
  model_overrides TEXT NOT NULL DEFAULT '{}',
  reviewed_as TEXT,
  page_reviews TEXT NOT NULL DEFAULT '[]',
  strengths TEXT NOT NULL DEFAULT '[]',
  positioning TEXT,
  tracking_plan TEXT NOT NULL DEFAULT '[]',
  scenario_inputs TEXT,
  models_used TEXT NOT NULL DEFAULT '{}',
  est_cost_usd REAL NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  started_at TEXT NOT NULL,
  completed_at TEXT
);
CREATE INDEX idx_cro_audits_business ON cro_audits(business_id, created_at);

CREATE TABLE cro_items (
  id TEXT PRIMARY KEY,
  cro_audit_id TEXT NOT NULL,
  rank INTEGER NOT NULL,
  horizon INTEGER NOT NULL,
  title TEXT NOT NULL,
  observation TEXT NOT NULL,
  change TEXT NOT NULL,
  why TEXT NOT NULL,
  area TEXT NOT NULL,
  mode TEXT NOT NULL,
  impact TEXT NOT NULL,
  effort TEXT NOT NULL,
  evidence_ids TEXT NOT NULL DEFAULT '[]',
  catalog_id TEXT,
  we_can_do_it TEXT NOT NULL DEFAULT '',
  pxl_score INTEGER NOT NULL DEFAULT 0,
  included INTEGER NOT NULL DEFAULT 1,
  edited INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL
);
CREATE INDEX idx_cro_items_audit ON cro_items(cro_audit_id, rank);
