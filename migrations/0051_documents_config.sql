-- Proposal and SOW settings: the legal-review record, the late fee and how long a proposal stays open, as one JSON document. '{}' means "use the defaults" (no review recorded, so no real send).
ALTER TABLE settings ADD COLUMN documents_config TEXT NOT NULL DEFAULT '{}';
