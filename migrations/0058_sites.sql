-- Client sites and the access we need to work on them (Plan 9): one lead can have several sites, and each site carries a six-line access checklist.
-- Times are UTC ISO strings with milliseconds, so comparing them as text compares them in time.
-- NO SECRET IS EVER STORED HERE. An access item holds item names only, never a login: vault_item is the NAME of the password-manager item that holds the credentials, nothing more.
-- No ON DELETE CASCADE on business_id or site_id, like onboardings: a client with sites is archived, never deleted (the app refuses first).
-- seed_key marks a site the app made for a lead ('primary'), so making it again returns the same one; hand-added sites have no seed_key and any number are allowed.
-- The domain is unique per business among live sites only: archiving a site frees its domain.
CREATE TABLE sites (
  id TEXT PRIMARY KEY,
  business_id TEXT NOT NULL REFERENCES businesses(id),
  seed_key TEXT CHECK (seed_key IS NULL OR seed_key IN ('primary')),
  url TEXT,
  domain TEXT,
  cms TEXT NOT NULL DEFAULT 'unknown' CHECK (cms IN ('wordpress', 'webflow', 'wix', 'squarespace', 'shopify', 'custom', 'unknown')),
  host_provider TEXT,
  registrar TEXT,
  dns_provider TEXT,
  admin_url TEXT,
  hosting_tier TEXT NOT NULL DEFAULT 'unknown' CHECK (hosting_tier IN ('logan_hosted', 'client_hosted', 'unknown')),
  access_method TEXT NOT NULL DEFAULT 'unknown' CHECK (access_method IN ('ssh_wpcli', 'mainwp', 'none', 'unknown')),
  notes TEXT,
  test INTEGER NOT NULL DEFAULT 0 CHECK (test IN (0, 1)),
  archived_at TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE UNIQUE INDEX uq_sites_seed ON sites(business_id, seed_key) WHERE seed_key IS NOT NULL;
CREATE UNIQUE INDEX uq_sites_domain ON sites(business_id, domain) WHERE domain IS NOT NULL AND archived_at IS NULL;
CREATE INDEX idx_sites_business ON sites(business_id);

-- Exactly six rows per site, one per kind of access. vault_item is the name of a password-manager item (never the password); note is free text for us.
CREATE TABLE site_access_items (
  site_id TEXT NOT NULL REFERENCES sites(id),
  key TEXT NOT NULL CHECK (key IN ('hosting', 'dns', 'registrar', 'admin', 'gbp', 'analytics')),
  status TEXT NOT NULL DEFAULT 'needed' CHECK (status IN ('needed', 'requested', 'received', 'verified', 'not_applicable')),
  vault_item TEXT,
  note TEXT,
  requested_at TEXT,
  received_at TEXT,
  verified_at TEXT,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (site_id, key)
);
