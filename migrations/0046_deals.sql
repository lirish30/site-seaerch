-- A deal is one sales conversation with a lead, from a booked call to won or lost (spec section 7). The stages are fixed here so later plans need no migration.
-- JSON columns: options (the three options, null until drafted), price_snapshot (the packages and prices the deal was built on), notes, call_prep, recap.
CREATE TABLE deals (
  id TEXT PRIMARY KEY,
  business_id TEXT NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
  stage TEXT NOT NULL CHECK (stage IN ('booked', 'discovery_done', 'recommendation_booked', 'recommended', 'proposal_sent', 'won', 'lost')),
  source TEXT NOT NULL CHECK (source IN ('booking', 'manual')),
  skip_call INTEGER NOT NULL DEFAULT 0 CHECK (skip_call IN (0, 1)),
  options TEXT,
  recommended_option_id TEXT CHECK (recommended_option_id IS NULL OR recommended_option_id IN ('a', 'b', 'c')),
  price_snapshot TEXT NOT NULL DEFAULT '[]',
  value_cents INTEGER CHECK (value_cents IS NULL OR value_cents >= 0),
  notes TEXT,
  call_prep TEXT,
  recap TEXT,
  deck_frozen_at TEXT,
  lost_reason TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  closed_at TEXT
);
-- One open deal per lead; a won or lost deal does not block the next one.
CREATE UNIQUE INDEX uq_deals_open ON deals(business_id) WHERE stage NOT IN ('won', 'lost');
CREATE INDEX idx_deals_business ON deals(business_id, created_at);
