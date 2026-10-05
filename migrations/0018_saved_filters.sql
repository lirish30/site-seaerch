-- Batch triage: free-form lead tags (JSON array of lowercase strings), saved list filters, and short-lived undo snapshots for bulk actions.
ALTER TABLE businesses ADD COLUMN tags TEXT NOT NULL DEFAULT '[]';
CREATE TABLE saved_filters (id TEXT PRIMARY KEY, name TEXT NOT NULL, query TEXT NOT NULL, created_at TEXT NOT NULL);
-- Names are unique ignoring case, so two requests racing past the route's check cannot both land.
CREATE UNIQUE INDEX idx_saved_filters_name ON saved_filters(name COLLATE NOCASE);
CREATE TABLE bulk_undo (token TEXT PRIMARY KEY, snapshot TEXT NOT NULL, created_at TEXT NOT NULL);
CREATE INDEX idx_bulk_undo_created ON bulk_undo(created_at);
