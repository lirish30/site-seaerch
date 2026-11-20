-- Billing (Plan 8): the invoice model grows from the single Stripe deposit to every kind of invoice, and holds, reminders and subscriptions get their tables.
-- Money is integer cents. Times are UTC ISO strings; due_on, first_charge_on and term_ends_on are calendar dates (YYYY-MM-DD) in the booking time zone. No Stripe secret is ever stored: they are Worker secrets.
-- No ON DELETE CASCADE on business_id, deal_id or document_id (nor on the new project, change order, subscription or invoice links): an invoice, a hold and a subscription are financial records the app never deletes.

-- A subscription starts planned (made when the proposal is signed), is proposed to the client, gets a Checkout link, and runs until it is cancelled or its term ends.
-- One per (document, package). token is the client's link to its page; both token and stripe_subscription_id are unique once set.
CREATE TABLE subscriptions (
  id TEXT PRIMARY KEY,
  business_id TEXT NOT NULL REFERENCES businesses(id),
  document_id TEXT NOT NULL REFERENCES documents(id),
  project_id TEXT REFERENCES projects(id),
  package_key TEXT NOT NULL,
  package_version INTEGER NOT NULL,
  monthly_cents INTEGER NOT NULL CHECK (monthly_cents > 0 AND typeof(monthly_cents) = 'integer'),
  starts_when TEXT NOT NULL CHECK (starts_when IN ('signing', 'launch', 'kickoff')),
  first_charge_on TEXT,
  term_months INTEGER,
  term_ends_on TEXT,
  end_action TEXT NOT NULL DEFAULT 'none' CHECK (end_action IN ('convert_to_care', 'none')),
  status TEXT NOT NULL DEFAULT 'planned' CHECK (status IN ('planned', 'proposed', 'link_sent', 'active', 'past_due', 'cancelled', 'ended')),
  token TEXT,
  stripe_customer_id TEXT,
  stripe_subscription_id TEXT,
  stripe_checkout_session_id TEXT,
  term_notice_sent_at TEXT,
  test INTEGER NOT NULL DEFAULT 0 CHECK (test IN (0, 1)),
  created_at TEXT NOT NULL,
  activated_at TEXT,
  cancelled_at TEXT
);
CREATE UNIQUE INDEX uq_subscriptions_document_package ON subscriptions(document_id, package_key);
CREATE UNIQUE INDEX uq_subscriptions_token ON subscriptions(token) WHERE token IS NOT NULL;
CREATE UNIQUE INDEX uq_subscriptions_stripe ON subscriptions(stripe_subscription_id) WHERE stripe_subscription_id IS NOT NULL;
CREATE INDEX idx_subscriptions_business ON subscriptions(business_id);
CREATE INDEX idx_subscriptions_status ON subscriptions(status);

-- Rebuild of invoices (SQLite cannot loosen a NOT NULL or a CHECK in place): create the new table, copy, drop the old, rename, recreate the indexes.
-- A draft is an invoice Logan has not approved yet: it has no Stripe customer, invoice or link, and its status is 'draft' (the CHECK keeps a draft from carrying a Stripe id).
-- ref is the invoice's own idempotency key (deposit:<document>, milestone:..., hourly:..., and so on): one row per ref, and it keys every Stripe call made for the invoice.
-- lines is a JSON array of {description, amountCents}; amount_cents is their sum. failed_on is the date a payment attempt failed, due_on the date it falls due.
CREATE TABLE invoices_new (
  id TEXT PRIMARY KEY,
  business_id TEXT NOT NULL REFERENCES businesses(id),
  deal_id TEXT REFERENCES deals(id),
  document_id TEXT REFERENCES documents(id),
  project_id TEXT REFERENCES projects(id),
  change_order_id TEXT REFERENCES change_orders(id),
  subscription_id TEXT REFERENCES subscriptions(id),
  kind TEXT NOT NULL CHECK (kind IN ('deposit', 'milestone', 'change_order', 'hourly', 'subscription', 'early_exit')),
  ref TEXT NOT NULL UNIQUE,
  test INTEGER NOT NULL DEFAULT 0 CHECK (test IN (0, 1)),
  description TEXT NOT NULL DEFAULT '',
  lines TEXT NOT NULL DEFAULT '[]',
  stripe_customer_id TEXT,
  stripe_invoice_id TEXT UNIQUE,
  amount_cents INTEGER NOT NULL CHECK (amount_cents > 0 AND typeof(amount_cents) = 'integer'),
  status TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('draft', 'open', 'paid', 'void', 'uncollectible', 'failed')),
  hosted_url TEXT,
  due_on TEXT,
  sent_at TEXT,
  failed_on TEXT,
  mismatch TEXT,
  created_at TEXT NOT NULL,
  paid_at TEXT,
  CHECK (status <> 'draft' OR stripe_invoice_id IS NULL)
);
-- Every existing row is a Plan 5 deposit: it was sent when it was made, and it is a test row when its document is.
INSERT INTO invoices_new (id, business_id, deal_id, document_id, kind, ref, test, description, lines, stripe_customer_id, stripe_invoice_id, amount_cents, status, hosted_url, sent_at, mismatch, created_at, paid_at)
SELECT i.id, i.business_id, i.deal_id, i.document_id, i.kind, 'deposit:' || i.document_id, COALESCE((SELECT d.test FROM documents d WHERE d.id = i.document_id), 0), 'Deposit',
       json_array(json_object('description', 'Deposit', 'amountCents', i.amount_cents)), i.stripe_customer_id, i.stripe_invoice_id, i.amount_cents, i.status, i.hosted_url,
       i.created_at, i.mismatch, i.created_at, i.paid_at
FROM invoices i;
DROP TABLE invoices;
ALTER TABLE invoices_new RENAME TO invoices;
-- One deposit invoice per document; any other kind repeats (several milestones, hourly invoices).
CREATE UNIQUE INDEX uq_invoices_deposit_document ON invoices(document_id, kind) WHERE kind = 'deposit';
CREATE INDEX idx_invoices_deal ON invoices(deal_id);
CREATE INDEX idx_invoices_project ON invoices(project_id);
CREATE INDEX idx_invoices_status ON invoices(status);

-- One row per reminder already raised for an invoice (step says which: r1 to r6, or pause), so a reminder is raised once. approval_id is the approval it opened.
CREATE TABLE invoice_nudges (
  invoice_id TEXT NOT NULL REFERENCES invoices(id),
  step TEXT NOT NULL CHECK (step IN ('r1', 'r2', 'r3', 'r4', 'r5', 'r6', 'pause')),
  approval_id TEXT,
  created_at TEXT NOT NULL,
  PRIMARY KEY (invoice_id, step)
);

-- A hold stops Logan's and Claude's tasks for a business whose invoice went unpaid. At most one per invoice, ever (a lifted hold is not placed again).
CREATE TABLE billing_holds (
  id TEXT PRIMARY KEY,
  business_id TEXT NOT NULL REFERENCES businesses(id),
  invoice_id TEXT NOT NULL UNIQUE REFERENCES invoices(id),
  placed_at TEXT NOT NULL,
  lifted_at TEXT,
  lifted_by TEXT CHECK (lifted_by IN ('payment', 'void', 'manual'))
);
CREATE INDEX idx_billing_holds_business ON billing_holds(business_id);

-- The Stripe product made for a package (one per package key, made on first use).
CREATE TABLE stripe_products (
  package_key TEXT PRIMARY KEY,
  stripe_product_id TEXT NOT NULL
);

-- JSON of a BillingConfig (net days, reminder offsets, pause and term-notice days), or '{}' for the defaults.
ALTER TABLE settings ADD COLUMN billing_config TEXT NOT NULL DEFAULT '{}';
