-- Fit profiles: the kinds of client the user wants per service. Only set criteria count toward fit.
-- Industries/geos start empty for the user to fill in; ids of seeded rows are stable.
CREATE TABLE fit_profiles (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  service_key TEXT NOT NULL,
  industries TEXT NOT NULL DEFAULT '[]',
  geos TEXT NOT NULL DEFAULT '[]',
  platforms TEXT NOT NULL DEFAULT '[]',
  min_reviews INTEGER,
  min_rating REAL,
  active INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL
);

INSERT INTO fit_profiles (id, name, service_key, platforms, min_reviews, min_rating, created_at) VALUES
  ('fit-wordpress-care', 'WordPress care', 'hosting-maintenance', '["wordpress"]', NULL, NULL, '2026-10-04T00:00:00.000Z'),
  ('fit-cro', 'CRO', 'conversion-rate-optimization', '[]', 10, 4.0, '2026-10-04T00:00:01.000Z'),
  ('fit-redesign', 'Redesign', 'web-design-development', '["wix","squarespace","godaddy","weebly"]', NULL, NULL, '2026-10-04T00:00:02.000Z');
