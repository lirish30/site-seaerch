-- Care monitoring (Plan 11): is each Care client's site up, and is its domain about to lapse. A probe records one row per check; an incident is one stretch of trouble on a site.
-- Times are UTC ISO strings with milliseconds, so comparing them as text compares them in time. domain_expires_on is a plain YYYY-MM-DD date.
-- NO SECRET IS EVER STORED HERE: a check keeps the status, the time and a short error word, never a response body or a header.
-- No ON DELETE CASCADE on site_id or business_id, like sites: a site with history is archived, never deleted.
-- monitoring = 1 turns monitoring on for a site that has no Care subscription; a live Care subscription turns it on by itself (see db/monitoring.ts).
ALTER TABLE sites ADD COLUMN monitoring INTEGER NOT NULL DEFAULT 0 CHECK (monitoring IN (0, 1));
ALTER TABLE sites ADD COLUMN domain_expires_on TEXT;
ALTER TABLE sites ADD COLUMN domain_checked_at TEXT;

-- One row per probe of a site. status is the HTTP status when there was one; ms how long it took; error a short word when it failed (timeout, dns, tls...). Old rows are pruned.
CREATE TABLE site_checks (
  id TEXT PRIMARY KEY,
  site_id TEXT NOT NULL REFERENCES sites(id),
  checked_at TEXT NOT NULL,
  ok INTEGER NOT NULL CHECK (ok IN (0, 1)),
  status INTEGER,
  ms INTEGER,
  error TEXT
);
CREATE INDEX idx_site_checks_site ON site_checks(site_id, checked_at);

-- One stretch of trouble: the site is down, or its domain is about to expire. closed_at stays NULL while it lasts.
-- At most one open incident per site and kind, so a second probe failure never opens a second one.
CREATE TABLE site_incidents (
  id TEXT PRIMARY KEY,
  site_id TEXT NOT NULL REFERENCES sites(id),
  business_id TEXT NOT NULL REFERENCES businesses(id),
  kind TEXT NOT NULL CHECK (kind IN ('down', 'domain_expiring')),
  opened_at TEXT NOT NULL,
  closed_at TEXT,
  detail TEXT NOT NULL
);
CREATE UNIQUE INDEX uq_site_incident_open ON site_incidents(site_id, kind) WHERE closed_at IS NULL;
CREATE INDEX idx_site_incidents_business ON site_incidents(business_id, opened_at);
