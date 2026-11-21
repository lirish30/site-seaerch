-- Care updates (Plan 12): a weekly WordPress update batch, run by the Mac helper over SSH + WP-CLI.
-- Times are UTC ISO strings with milliseconds. NO SECRET IS EVER STORED HERE: a site keeps only the NAME of an ssh host alias and the WordPress folder; keys live on the Mac.
-- Everything a client site returns (plugin names, versions, page text) is untrusted data and is stored trimmed.
ALTER TABLE sites ADD COLUMN wp_ssh_alias TEXT;
ALTER TABLE sites ADD COLUMN wp_path TEXT;
-- A JSON array of 1 to 5 page paths the helper screenshots before and after an update.
ALTER TABLE sites ADD COLUMN care_paths TEXT NOT NULL DEFAULT '["/"]';
ALTER TABLE sites ADD COLUMN cert_expires_on TEXT;
ALTER TABLE sites ADD COLUMN cert_checked_at TEXT;

-- site_incidents gains two kinds. SQLite cannot alter a CHECK, so the table is rebuilt: same columns, rows copied, the index recreated.
CREATE TABLE site_incidents_new (
  id TEXT PRIMARY KEY,
  site_id TEXT NOT NULL REFERENCES sites(id),
  business_id TEXT NOT NULL REFERENCES businesses(id),
  kind TEXT NOT NULL CHECK (kind IN ('down', 'domain_expiring', 'update_failed', 'cert_expiring')),
  opened_at TEXT NOT NULL,
  closed_at TEXT,
  detail TEXT NOT NULL
);
INSERT INTO site_incidents_new (id, site_id, business_id, kind, opened_at, closed_at, detail)
  SELECT id, site_id, business_id, kind, opened_at, closed_at, detail FROM site_incidents;
DROP TABLE site_incidents;
ALTER TABLE site_incidents_new RENAME TO site_incidents;
CREATE UNIQUE INDEX uq_site_incident_open ON site_incidents(site_id, kind) WHERE closed_at IS NULL;
CREATE INDEX idx_site_incidents_business ON site_incidents(business_id, opened_at);

-- One batch of updates: the weekly one (one per period) or a single-site run by hand.
CREATE TABLE care_batches (
  id TEXT PRIMARY KEY,
  period TEXT NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('weekly', 'single')),
  site_id TEXT,
  status TEXT NOT NULL CHECK (status IN ('inventory', 'wave1', 'wave2', 'done', 'cancelled')),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE UNIQUE INDEX uq_care_batch_week ON care_batches(period) WHERE kind = 'weekly';

-- One update a site could take. A newer to_version is a new row; the older one goes `gone`. security and held are set by hand and survive a re-read.
CREATE TABLE care_updates (
  id TEXT PRIMARY KEY,
  site_id TEXT NOT NULL REFERENCES sites(id),
  type TEXT NOT NULL CHECK (type IN ('core', 'plugin', 'theme')),
  slug TEXT NOT NULL,
  name TEXT NOT NULL,
  from_version TEXT NOT NULL,
  to_version TEXT NOT NULL,
  risk TEXT NOT NULL CHECK (risk IN ('security', 'major', 'mild', 'minor')),
  rollbackable INTEGER NOT NULL DEFAULT 1 CHECK (rollbackable IN (0, 1)),
  security INTEGER NOT NULL DEFAULT 0 CHECK (security IN (0, 1)),
  held INTEGER NOT NULL DEFAULT 0 CHECK (held IN (0, 1)),
  first_seen_at TEXT NOT NULL,
  last_seen_at TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'available' CHECK (status IN ('available', 'queued', 'applied', 'failed', 'rolled_back', 'gone')),
  -- When a run last marked this update failed or rolled back. Kept when the next inventory makes it available again, so it needs Logan's tick (and the board says so).
  last_failed_at TEXT,
  UNIQUE (site_id, type, slug, to_version)
);
CREATE INDEX idx_care_updates_site ON care_updates(site_id, status);

-- One helper job for one site in one batch. wave 0 is a single-site run.
CREATE TABLE care_runs (
  id TEXT PRIMARY KEY,
  batch_id TEXT NOT NULL REFERENCES care_batches(id),
  site_id TEXT NOT NULL REFERENCES sites(id),
  wave INTEGER NOT NULL CHECK (wave IN (0, 1, 2)),
  approval_id TEXT,
  helper_job_id TEXT,
  status TEXT NOT NULL CHECK (status IN ('queued', 'running', 'ok', 'changed', 'rolled_back', 'failed', 'dropped')),
  backup_file TEXT,
  summary TEXT,
  created_at TEXT NOT NULL,
  finished_at TEXT
);
CREATE INDEX idx_care_runs_batch ON care_runs(batch_id);

-- One page screenshotted before and after. before_key, after_key and diff_key are R2 keys.
CREATE TABLE care_page_checks (
  id TEXT PRIMARY KEY,
  run_id TEXT NOT NULL REFERENCES care_runs(id),
  path TEXT NOT NULL,
  before_key TEXT,
  after_key TEXT,
  diff_key TEXT,
  status_before INTEGER,
  status_after INTEGER,
  forms_before INTEGER,
  forms_after INTEGER,
  ssim REAL,
  verdict TEXT NOT NULL CHECK (verdict IN ('ok', 'changed', 'broken')),
  review TEXT NOT NULL DEFAULT 'none' CHECK (review IN ('none', 'pending', 'fine', 'broken', 'unsure', 'logan_ok'))
);
CREATE INDEX idx_care_page_checks_run ON care_page_checks(run_id);

-- What the helper last read from a site: versions, the kind of site it is, the active plugin slugs (JSON, at most 200).
CREATE TABLE site_inventories (
  site_id TEXT PRIMARY KEY REFERENCES sites(id),
  wp_version TEXT,
  php_version TEXT,
  group_key TEXT NOT NULL CHECK (group_key IN ('woocommerce', 'booking', 'builder', 'brochure')),
  plugins TEXT NOT NULL DEFAULT '[]',
  read_at TEXT NOT NULL
);
