-- Audit v2: Site Health alongside the opportunity score (kept in audits.score), niche, AI review, screenshots, links.
ALTER TABLE audits ADD COLUMN health_score INTEGER;
ALTER TABLE audits ADD COLUMN niche TEXT;
ALTER TABLE audits ADD COLUMN category_scores TEXT NOT NULL DEFAULT '{}';
ALTER TABLE audits ADD COLUMN ai_review TEXT;
ALTER TABLE audits ADD COLUMN screenshots TEXT NOT NULL DEFAULT '{}';
ALTER TABLE audits ADD COLUMN site_links TEXT NOT NULL DEFAULT '{}';
