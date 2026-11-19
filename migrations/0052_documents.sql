-- A proposal and statement of work sent to a lead for e-signature (Plan 5). One row per version of the document for a deal.
-- content is JSON (the proposal as built); it is frozen when the document is sent, and content_sha256 is the hash the client signs against.
-- Times are UTC ISO strings with milliseconds, so comparing them as text compares them in time. Money inside content is integer cents.
-- token is the secret in the client's link (32 random bytes, base64url). It is null while a draft.
-- No ON DELETE CASCADE on business_id or deal_id: a signed document is a record the app never deletes, so a lead or deal that has one cannot be removed (the app refuses first).
CREATE TABLE documents (
  id TEXT PRIMARY KEY,
  deal_id TEXT NOT NULL REFERENCES deals(id),
  business_id TEXT NOT NULL REFERENCES businesses(id),
  version INTEGER NOT NULL CHECK (version >= 1),
  status TEXT NOT NULL CHECK (status IN ('draft', 'sent', 'viewed', 'signed', 'void', 'expired')),
  test INTEGER NOT NULL DEFAULT 0 CHECK (test IN (0, 1)),
  option_id TEXT NOT NULL CHECK (option_id IN ('a', 'b', 'c')),
  content TEXT NOT NULL,
  content_sha256 TEXT,
  token TEXT,
  sent_at TEXT,
  expires_at TEXT,
  first_viewed_at TEXT,
  signed_at TEXT,
  paid_at TEXT,
  void_reason TEXT,
  pdf_key TEXT,
  pdf_sha256 TEXT,
  pdf_error TEXT,
  approval_id TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE (deal_id, version)
);
-- A deal has one open document at a time; a signed, void or expired one does not block the next.
CREATE UNIQUE INDEX uq_documents_open ON documents(deal_id) WHERE status IN ('draft', 'sent', 'viewed');
-- Several drafts have no token yet; SQLite treats nulls as distinct in a unique index.
CREATE UNIQUE INDEX uq_documents_token ON documents(token);
CREATE INDEX idx_documents_business ON documents(business_id);

-- The provider signs when the document is sent, the client when they sign; one of each. Text from the signer (name, email, user agent) is untrusted and capped by the caller.
CREATE TABLE document_signatures (
  id TEXT PRIMARY KEY,
  document_id TEXT NOT NULL REFERENCES documents(id),
  role TEXT NOT NULL CHECK (role IN ('provider', 'client')),
  signer_name TEXT NOT NULL,
  signer_email TEXT NOT NULL,
  signed_at TEXT NOT NULL,
  ip TEXT,
  user_agent TEXT,
  consent_text TEXT NOT NULL,
  consent_version INTEGER NOT NULL,
  content_sha256 TEXT NOT NULL,
  UNIQUE (document_id, role)
);

-- One row per visit, at most one every ten minutes per document (the rate limit is in the insert).
CREATE TABLE document_views (
  id TEXT PRIMARY KEY,
  document_id TEXT NOT NULL REFERENCES documents(id),
  viewed_at TEXT NOT NULL,
  user_agent TEXT
);
CREATE INDEX idx_document_views_doc ON document_views(document_id, viewed_at);
