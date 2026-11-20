-- Projects, SOP templates, tasks, time and change orders (Plan 7). A signed proposal with a paid deposit becomes projects; a project's steps come from an SOP template and are copied into `tasks`.
-- Times are UTC ISO strings with milliseconds, so comparing them as text compares them in time. Money is integer cents; time is integer minutes. `due_on` is a calendar date (YYYY-MM-DD) in the booking timezone.
-- JSON columns (applies_to, requires, checklist, content) hold what the app writes; the app reads them defensively and falls back to an empty value.
-- Text that came from a client (change-order names, signer fields) or from Claude (task comments, results) is untrusted: the callers clean and cap it, this layer stores it as given.
-- No ON DELETE CASCADE on business_id, deal_id or document_id: a project, a time entry and a change order are records the app never deletes (a lead that has a project is archived, never deleted; the app refuses first).

-- A template says which steps a job has. kind 'project' templates are copied into a project when a package is sold; kind 'recurring' templates are copied into one checklist task per period.
-- applies_to is a JSON array of package keys. version goes up each time the steps are saved; an existing project keeps the steps it was started with.
-- cadence_day is the ISO weekday (1 = Monday ... 7 = Sunday) for a weekly cadence and the day of the month (1 to 28) for the others.
CREATE TABLE sop_templates (
  id TEXT PRIMARY KEY,
  key TEXT NOT NULL UNIQUE,
  name TEXT NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('project', 'recurring')),
  cadence TEXT CHECK (cadence IN ('weekly', 'monthly', 'quarterly', 'annual')),
  cadence_day INTEGER CHECK (cadence_day IS NULL OR (cadence_day BETWEEN 1 AND 28)),
  applies_to TEXT NOT NULL DEFAULT '[]',
  version INTEGER NOT NULL DEFAULT 1 CHECK (version >= 1),
  active INTEGER NOT NULL DEFAULT 1 CHECK (active IN (0, 1)),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  CHECK ((kind = 'recurring') = (cadence IS NOT NULL))
);

-- One row per step. position is the order within the template (it only has to increase). requires is a JSON array of step keys in the same template.
-- milestone marks the step whose completion reaches a project milestone.
CREATE TABLE sop_template_steps (
  template_id TEXT NOT NULL REFERENCES sop_templates(id) ON DELETE CASCADE,
  key TEXT NOT NULL,
  phase_key TEXT NOT NULL,
  phase_title TEXT NOT NULL,
  position INTEGER NOT NULL,
  title TEXT NOT NULL,
  owner TEXT NOT NULL CHECK (owner IN ('claude', 'logan', 'claude_drafts')),
  est_minutes INTEGER NOT NULL DEFAULT 0 CHECK (est_minutes >= 0 AND typeof(est_minutes) = 'integer'),
  done_when TEXT NOT NULL DEFAULT '',
  doc_template TEXT,
  email_template TEXT,
  requires TEXT NOT NULL DEFAULT '[]',
  milestone TEXT CHECK (milestone IN ('design_approved', 'site_finished')),
  client_summary TEXT,
  skippable INTEGER NOT NULL DEFAULT 0 CHECK (skippable IN (0, 1)),
  PRIMARY KEY (template_id, key)
);
CREATE INDEX idx_sop_template_steps_order ON sop_template_steps(template_id, position);

-- A project is one sold job for one business. deal_id, document_id and onboarding_id are null for a project Logan starts by hand.
-- Starting from a document is idempotent: one project per (document, template). A null never conflicts, so hand-made projects are not limited.
-- test = 1 marks a rehearsal: it mails only the owner and never dispatches Claude on its own.
-- care_deferred = 1 is a Care onboarding project waiting for the site build to finish before it starts.
CREATE TABLE projects (
  id TEXT PRIMARY KEY,
  business_id TEXT NOT NULL REFERENCES businesses(id),
  deal_id TEXT REFERENCES deals(id),
  document_id TEXT REFERENCES documents(id),
  onboarding_id TEXT REFERENCES onboardings(id),
  kind TEXT NOT NULL CHECK (kind IN ('build', 'quick_fix', 'care_onboarding', 'custom')),
  name TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'paused', 'done', 'cancelled')),
  paused_reason TEXT,
  test INTEGER NOT NULL DEFAULT 0 CHECK (test IN (0, 1)),
  template_key TEXT,
  template_version INTEGER,
  care_deferred INTEGER NOT NULL DEFAULT 0 CHECK (care_deferred IN (0, 1)),
  started_at TEXT NOT NULL,
  completed_at TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE UNIQUE INDEX uq_projects_document_template ON projects(document_id, template_key);
CREATE INDEX idx_projects_business ON projects(business_id);
CREATE INDEX idx_projects_status ON projects(status);

-- A milestone is reached once per project (the primary key is the guard).
CREATE TABLE project_milestones (
  project_id TEXT NOT NULL REFERENCES projects(id),
  milestone TEXT NOT NULL CHECK (milestone IN ('design_approved', 'site_finished')),
  reached_at TEXT NOT NULL,
  PRIMARY KEY (project_id, milestone)
);

-- A recurring template attached to a project (for example Care weekly): one checklist task is made per period.
CREATE TABLE project_cadences (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects(id),
  template_key TEXT NOT NULL,
  created_at TEXT NOT NULL,
  UNIQUE (project_id, template_key)
);

-- A change order is a small extra job the client signs and pays for before its tasks unlock. content is JSON, frozen when sent; content_sha256 is the hash the client signs against.
-- token is the secret in the client's link (32 random bytes, base64url), null while a draft. seq numbers the change orders of a project from 1.
-- paid_via says how the money arrived: 'stripe' (Plan 8's webhook) or 'manual' (Logan, outside Stripe). origin_approval_id is the approval that drafted it, so running that approval twice makes one draft.
-- The signer fields (name, email, ip, user agent, consent text) came from the client and are untrusted; the callers clean and cap them.
CREATE TABLE change_orders (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects(id),
  business_id TEXT NOT NULL REFERENCES businesses(id),
  deal_id TEXT REFERENCES deals(id),
  seq INTEGER NOT NULL CHECK (seq >= 1),
  test INTEGER NOT NULL DEFAULT 0 CHECK (test IN (0, 1)),
  status TEXT NOT NULL DEFAULT 'draft' CHECK (status IN ('draft', 'sent', 'viewed', 'signed', 'declined', 'void', 'expired')),
  content TEXT NOT NULL,
  content_sha256 TEXT,
  token TEXT,
  source_type TEXT NOT NULL CHECK (source_type IN ('logan', 'claude', 'email', 'meeting')),
  origin_approval_id TEXT,
  approval_id TEXT,
  sent_at TEXT,
  expires_at TEXT,
  first_viewed_at TEXT,
  signed_at TEXT,
  signer_name TEXT,
  signer_email TEXT,
  signer_ip TEXT,
  signer_user_agent TEXT,
  consent_text TEXT,
  consent_version INTEGER,
  declined_reason TEXT,
  paid_at TEXT,
  paid_via TEXT CHECK (paid_via IN ('stripe', 'manual')),
  void_reason TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE (project_id, seq),
  CHECK ((paid_at IS NULL) = (paid_via IS NULL))
);
-- Several drafts have no token yet; SQLite treats nulls as distinct in a unique index. A draft approval makes one change order, however many times it runs.
CREATE UNIQUE INDEX uq_change_orders_token ON change_orders(token);
CREATE UNIQUE INDEX uq_change_orders_origin_approval ON change_orders(origin_approval_id);
CREATE INDEX idx_change_orders_project ON change_orders(project_id);
CREATE INDEX idx_change_orders_business ON change_orders(business_id);

-- One row per visit to a change-order link, at most one every ten minutes per change order (the rate limit is in the insert).
CREATE TABLE change_order_views (
  id TEXT PRIMARY KEY,
  change_order_id TEXT NOT NULL REFERENCES change_orders(id),
  viewed_at TEXT NOT NULL,
  user_agent TEXT
);
CREATE INDEX idx_change_order_views_order ON change_order_views(change_order_id, viewed_at);

-- A task is one unit of work. is_step = 1 for a task copied from a template step (step_key is its key there, and `requires` names other step keys in the same project).
-- A task from a recurring cadence has cadence_key (the template) and period_key (for example 2026-11 or 2026-W47), one per period. A change-order task is locked until its change order is signed and paid.
-- status: todo, in_progress, in_review, waiting_client, done, skipped, locked. due_on is a calendar date. checklist is a JSON array of { text, done }.
-- claude_task_id and review_approval_id point at the Claude queue job and the approval a Claude step opened; they are soft links (no foreign key) so those rows can be pruned.
CREATE TABLE tasks (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects(id),
  business_id TEXT NOT NULL REFERENCES businesses(id),
  is_step INTEGER NOT NULL DEFAULT 1 CHECK (is_step IN (0, 1)),
  step_key TEXT,
  phase_key TEXT NOT NULL DEFAULT '',
  phase_title TEXT NOT NULL DEFAULT '',
  position INTEGER NOT NULL,
  title TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  owner TEXT NOT NULL CHECK (owner IN ('claude', 'logan', 'claude_drafts')),
  status TEXT NOT NULL DEFAULT 'todo' CHECK (status IN ('todo', 'in_progress', 'in_review', 'waiting_client', 'done', 'skipped', 'locked')),
  done_when TEXT NOT NULL DEFAULT '',
  est_minutes INTEGER NOT NULL DEFAULT 0 CHECK (est_minutes >= 0 AND typeof(est_minutes) = 'integer'),
  due_on TEXT,
  billable INTEGER NOT NULL DEFAULT 0 CHECK (billable IN (0, 1)),
  skippable INTEGER NOT NULL DEFAULT 0 CHECK (skippable IN (0, 1)),
  requires TEXT NOT NULL DEFAULT '[]',
  milestone TEXT CHECK (milestone IN ('design_approved', 'site_finished')),
  client_summary TEXT,
  doc_template TEXT,
  email_template TEXT,
  checklist TEXT NOT NULL DEFAULT '[]',
  change_order_id TEXT REFERENCES change_orders(id),
  cadence_key TEXT,
  period_key TEXT,
  claude_task_id TEXT,
  review_approval_id TEXT,
  started_at TEXT,
  done_at TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX idx_tasks_project ON tasks(project_id, position);
CREATE INDEX idx_tasks_open ON tasks(owner, status);
CREATE INDEX idx_tasks_change_order ON tasks(change_order_id) WHERE change_order_id IS NOT NULL;
-- A step key names one task in a project (the requires lists resolve by it).
CREATE UNIQUE INDEX uq_tasks_step ON tasks(project_id, step_key) WHERE step_key IS NOT NULL;
-- A cadence makes one task per project per period, however many times the sweep runs.
CREATE UNIQUE INDEX uq_tasks_cadence_period ON tasks(project_id, cadence_key, period_key) WHERE cadence_key IS NOT NULL;

-- Notes on a task. author 'claude' is text Claude returned (untrusted); 'system' is a line the app wrote.
CREATE TABLE task_comments (
  id TEXT PRIMARY KEY,
  task_id TEXT NOT NULL REFERENCES tasks(id),
  author TEXT NOT NULL CHECK (author IN ('logan', 'claude', 'system')),
  body TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE INDEX idx_task_comments_task ON task_comments(task_id, created_at);

-- Time on a task. source 'timer' has started_at and (once stopped) ended_at; 'manual' is an entry typed in. minutes is whole minutes (0 while a timer runs).
-- Only one timer can run: the unique index below allows a single row with no ended_at. invoiced_ref names the invoice that billed the entry; a billed entry is not edited or deleted.
CREATE TABLE time_entries (
  id TEXT PRIMARY KEY,
  task_id TEXT NOT NULL REFERENCES tasks(id),
  project_id TEXT NOT NULL REFERENCES projects(id),
  business_id TEXT NOT NULL REFERENCES businesses(id),
  started_at TEXT NOT NULL,
  ended_at TEXT,
  minutes INTEGER NOT NULL DEFAULT 0 CHECK (minutes >= 0 AND typeof(minutes) = 'integer'),
  billable INTEGER NOT NULL DEFAULT 0 CHECK (billable IN (0, 1)),
  note TEXT NOT NULL DEFAULT '',
  source TEXT NOT NULL CHECK (source IN ('timer', 'manual')),
  invoiced_ref TEXT,
  created_at TEXT NOT NULL
);
CREATE UNIQUE INDEX uq_time_running ON time_entries(source) WHERE ended_at IS NULL;
CREATE INDEX idx_time_entries_task ON time_entries(task_id);
CREATE INDEX idx_time_entries_project ON time_entries(project_id);
CREATE INDEX idx_time_entries_started ON time_entries(started_at);

-- Work settings: a JSON document (cost rate, week start, timer cap). Empty means the defaults.
ALTER TABLE settings ADD COLUMN work_config TEXT NOT NULL DEFAULT '{}';
