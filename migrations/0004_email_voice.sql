-- Email voice: account-wide presets applied to every draft (tone_notes stays as free-text notes).
ALTER TABLE settings ADD COLUMN tone_preset TEXT NOT NULL DEFAULT 'friendly_local';
ALTER TABLE settings ADD COLUMN email_length TEXT NOT NULL DEFAULT 'short';
ALTER TABLE settings ADD COLUMN cta_style TEXT NOT NULL DEFAULT 'mini_audit';
