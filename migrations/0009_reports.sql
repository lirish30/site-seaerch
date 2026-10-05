CREATE TABLE audit_reports (
  token TEXT PRIMARY KEY,
  business_id TEXT NOT NULL,
  audit_id TEXT NOT NULL,
  created_at TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  revoked INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX idx_audit_reports_business ON audit_reports(business_id);

ALTER TABLE settings ADD COLUMN logo_url TEXT NOT NULL DEFAULT '';
