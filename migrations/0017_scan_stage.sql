-- Two-stage audit spending: 'quick' leads were crawled and scored but not rendered, PageSpeed-tested, AI-reviewed or drafted.
-- Existing leads and searches keep the old all-at-once behavior ('full' / 0).
ALTER TABLE businesses ADD COLUMN scan_stage TEXT NOT NULL DEFAULT 'full';
ALTER TABLE searches ADD COLUMN quick_scan INTEGER NOT NULL DEFAULT 0;
