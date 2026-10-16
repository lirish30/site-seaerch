-- Settings > Mailing footer and Google: which new drafts carry the mailing footer, and whether Gmail drafts attach the audit PDF by default.
-- The footer defaults match what drafts already did (freelance pitches carry it, full-time notes don't); the PDF default matches the old always-on checkbox.
ALTER TABLE settings ADD COLUMN footer_freelance INTEGER NOT NULL DEFAULT 1;
ALTER TABLE settings ADD COLUMN footer_full_time INTEGER NOT NULL DEFAULT 0;
ALTER TABLE settings ADD COLUMN attach_audit_pdf INTEGER NOT NULL DEFAULT 1;
