-- A draft now knows why it was written, which angle it takes, and whether it carries the mailing footer.
-- Existing drafts stay freelance pitches with the footer they already contain.
ALTER TABLE drafts ADD COLUMN purpose TEXT NOT NULL DEFAULT 'freelance';
ALTER TABLE drafts ADD COLUMN angle TEXT NOT NULL DEFAULT '';
ALTER TABLE drafts ADD COLUMN include_footer INTEGER NOT NULL DEFAULT 1;
-- Variants written in one go share a group; variant_index orders them (0 is the one shown first).
ALTER TABLE drafts ADD COLUMN variant_group TEXT;
ALTER TABLE drafts ADD COLUMN variant_index INTEGER NOT NULL DEFAULT 0;
CREATE INDEX idx_drafts_variant_group ON drafts(variant_group) WHERE variant_group IS NOT NULL;
