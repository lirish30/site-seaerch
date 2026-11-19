-- Stripe billing records (Plan 5): the Stripe customer for a business, the deposit invoice for a signed proposal, and the webhook events already handled.
-- Money is integer cents. Every Stripe ID is stored (spec 9.7). No Stripe secret is ever stored here: they are Worker secrets.
-- No ON DELETE CASCADE on business_id, deal_id or document_id: an invoice is a financial record the app never deletes (a lead or deal that has one cannot be removed).
CREATE TABLE stripe_customers (
  business_id TEXT PRIMARY KEY REFERENCES businesses(id),
  stripe_customer_id TEXT NOT NULL,
  created_at TEXT NOT NULL
);

-- status: open until Stripe says otherwise; failed is a payment attempt that did not go through (it can still be paid later).
-- mismatch is a short note set when Stripe reported a payment that does not match the amount, currency or document we invoiced; the row stays open.
CREATE TABLE invoices (
  id TEXT PRIMARY KEY,
  business_id TEXT NOT NULL REFERENCES businesses(id),
  deal_id TEXT NOT NULL REFERENCES deals(id),
  document_id TEXT NOT NULL REFERENCES documents(id),
  kind TEXT NOT NULL CHECK (kind IN ('deposit')),
  stripe_customer_id TEXT NOT NULL,
  stripe_invoice_id TEXT NOT NULL UNIQUE,
  amount_cents INTEGER NOT NULL CHECK (amount_cents > 0 AND typeof(amount_cents) = 'integer'),
  status TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'paid', 'void', 'uncollectible', 'failed')),
  hosted_url TEXT NOT NULL,
  mismatch TEXT,
  created_at TEXT NOT NULL,
  paid_at TEXT
);
-- One deposit invoice per document.
CREATE UNIQUE INDEX uq_invoices_document_kind ON invoices(document_id, kind);
CREATE INDEX idx_invoices_deal ON invoices(deal_id);

-- A webhook event id is inserted before the event is handled, so a repeat delivery (Stripe retries, or two at once) is seen as a duplicate.
CREATE TABLE stripe_events (
  id TEXT PRIMARY KEY,
  type TEXT NOT NULL,
  received_at TEXT NOT NULL
);
