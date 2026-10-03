CREATE TABLE searches (
  id TEXT PRIMARY KEY,
  location TEXT NOT NULL,
  business_type TEXT NOT NULL,
  radius_km REAL NOT NULL DEFAULT 15,
  max_results INTEGER NOT NULL DEFAULT 50,
  status TEXT NOT NULL DEFAULT 'running',
  error TEXT,
  found_count INTEGER NOT NULL DEFAULT 0,
  processed_count INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL
);

CREATE TABLE businesses (
  id TEXT PRIMARY KEY,
  place_id TEXT UNIQUE,
  domain TEXT,
  name TEXT NOT NULL,
  category TEXT,
  address TEXT,
  phone TEXT,
  website_url TEXT,
  maps_url TEXT,
  rating REAL,
  review_count INTEGER,
  first_seen_search_id TEXT,
  lead_status TEXT NOT NULL DEFAULT 'new',
  notes TEXT,
  contacted_at TEXT,
  last_error TEXT,
  created_at TEXT NOT NULL
);
CREATE INDEX idx_businesses_domain ON businesses(domain);
CREATE INDEX idx_businesses_status ON businesses(lead_status);

CREATE TABLE search_results (
  search_id TEXT NOT NULL,
  business_id TEXT NOT NULL,
  PRIMARY KEY (search_id, business_id)
);

CREATE TABLE audits (
  id TEXT PRIMARY KEY,
  business_id TEXT NOT NULL,
  created_at TEXT NOT NULL,
  site_status TEXT NOT NULL,
  partial INTEGER NOT NULL DEFAULT 0,
  pagespeed_mobile INTEGER,
  lcp_ms INTEGER,
  cls REAL,
  mobile_friendly INTEGER,
  https INTEGER,
  has_title INTEGER,
  has_meta_description INTEGER,
  has_contact_form INTEGER,
  copyright_year INTEGER,
  latest_content_date TEXT,
  broken_link_count INTEGER,
  score INTEGER NOT NULL,
  offer TEXT NOT NULL,
  findings TEXT NOT NULL,
  raw_r2_key TEXT
);
CREATE INDEX idx_audits_business ON audits(business_id, created_at);

CREATE TABLE contacts (
  id TEXT PRIMARY KEY,
  business_id TEXT NOT NULL,
  type TEXT NOT NULL,
  value TEXT NOT NULL,
  source_url TEXT,
  person_name TEXT,
  role TEXT,
  confidence REAL NOT NULL DEFAULT 0.5
);
CREATE INDEX idx_contacts_business ON contacts(business_id);

CREATE TABLE drafts (
  id TEXT PRIMARY KEY,
  business_id TEXT NOT NULL,
  audit_id TEXT,
  to_contact_id TEXT,
  recipient_reason TEXT NOT NULL,
  subject TEXT NOT NULL,
  body TEXT NOT NULL,
  offer TEXT NOT NULL,
  steering_note TEXT,
  edited INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL
);
CREATE INDEX idx_drafts_business ON drafts(business_id, created_at);

CREATE TABLE settings (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  your_name TEXT NOT NULL DEFAULT '',
  business_name TEXT NOT NULL DEFAULT '',
  contact_email TEXT NOT NULL DEFAULT '',
  services_blurb TEXT NOT NULL DEFAULT '',
  signature TEXT NOT NULL DEFAULT '',
  physical_address TEXT NOT NULL DEFAULT '',
  opt_out_line TEXT NOT NULL DEFAULT 'If you''d rather not hear from me, just reply "no thanks" and I won''t follow up.',
  tone_notes TEXT NOT NULL DEFAULT '',
  monthly_spend_limit_usd REAL NOT NULL DEFAULT 25
);
INSERT INTO settings (id) VALUES (1);

CREATE TABLE usage (
  id TEXT PRIMARY KEY,
  month TEXT NOT NULL,
  service TEXT NOT NULL,
  units INTEGER NOT NULL,
  est_cost_usd REAL NOT NULL,
  created_at TEXT NOT NULL
);
CREATE INDEX idx_usage_month ON usage(month);
