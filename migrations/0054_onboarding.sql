-- Client onboarding after a signed proposal (Plan 6): a welcome email, a questionnaire, and a list of things to collect (logo, photos, text).
-- Times are UTC ISO strings with milliseconds, so comparing them as text compares them in time.
-- Everything the client types or uploads (answers, item text, file names, content types) is untrusted: this layer stores it as given and the callers clean and cap it.
-- token is the secret in the client's link (32 random bytes, base64url). Revoking sets revoked_at; a new link replaces the token.
-- No ON DELETE CASCADE on business_id or deal_id, like documents: a lead that has an onboarding is archived, never deleted (the app refuses first).
CREATE TABLE onboardings (
  id TEXT PRIMARY KEY,
  business_id TEXT NOT NULL REFERENCES businesses(id),
  deal_id TEXT NOT NULL UNIQUE REFERENCES deals(id),
  document_id TEXT NOT NULL REFERENCES documents(id),
  kind TEXT NOT NULL CHECK (kind IN ('build', 'light')),
  test INTEGER NOT NULL DEFAULT 0 CHECK (test IN (0, 1)),
  token TEXT NOT NULL,
  revoked_at TEXT,
  welcome_video_url TEXT,
  welcome_sent_at TEXT,
  questionnaire_due_at TEXT,
  questionnaire_submitted_at TEXT,
  kickoff_at TEXT,
  last_client_activity_at TEXT,
  closed_at TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE UNIQUE INDEX uq_onboardings_token ON onboardings(token);
CREATE INDEX idx_onboardings_business ON onboardings(business_id);

-- One row per questionnaire question the client has answered; saving again replaces the answer.
CREATE TABLE onboarding_answers (
  onboarding_id TEXT NOT NULL REFERENCES onboardings(id),
  question_id TEXT NOT NULL,
  answer TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (onboarding_id, question_id)
);

-- A thing to collect from the client. phase 1 is due first, phase 2 later. custom = 1 for items the owner added by hand.
CREATE TABLE onboarding_items (
  id TEXT PRIMARY KEY,
  onboarding_id TEXT NOT NULL REFERENCES onboardings(id),
  key TEXT NOT NULL,
  label TEXT NOT NULL,
  instructions TEXT NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('text', 'files')),
  phase INTEGER NOT NULL CHECK (phase IN (1, 2)),
  due_at TEXT,
  status TEXT NOT NULL DEFAULT 'waiting' CHECK (status IN ('waiting', 'received', 'accepted', 'not_applicable')),
  text_value TEXT,
  custom INTEGER NOT NULL DEFAULT 0 CHECK (custom IN (0, 1)),
  position INTEGER NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE (onboarding_id, key)
);
CREATE INDEX idx_onboarding_items_onboarding ON onboarding_items(onboarding_id, position);

CREATE TABLE onboarding_files (
  id TEXT PRIMARY KEY,
  item_id TEXT NOT NULL REFERENCES onboarding_items(id),
  r2_key TEXT NOT NULL UNIQUE,
  file_name TEXT NOT NULL,
  content_type TEXT NOT NULL,
  size_bytes INTEGER NOT NULL CHECK (size_bytes >= 0),
  uploaded_at TEXT NOT NULL
);
CREATE INDEX idx_onboarding_files_item ON onboarding_files(item_id, uploaded_at);

-- One row per reminder already raised for an onboarding (key says which), so a reminder is raised once. approval_id is the approval it opened, if any.
CREATE TABLE onboarding_nudges (
  onboarding_id TEXT NOT NULL REFERENCES onboardings(id),
  key TEXT NOT NULL,
  approval_id TEXT,
  created_at TEXT NOT NULL,
  PRIMARY KEY (onboarding_id, key)
);
