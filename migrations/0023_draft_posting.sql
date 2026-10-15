-- A draft remembers which job posting it was written to cite, so a claim like "I saw you're hiring for X" can be rechecked
-- (composer, export, Today) after X closes. No foreign key: a posting that is gone counts as closed. Older drafts claim none.
ALTER TABLE drafts ADD COLUMN posting_id TEXT;
-- Role kinds best first; which open role a draft and Today name when a lead has several. Web development leads, then CRO and SEO.
ALTER TABLE settings ADD COLUMN role_kind_order TEXT NOT NULL DEFAULT 'web_dev,cro,seo,design,marketing';
