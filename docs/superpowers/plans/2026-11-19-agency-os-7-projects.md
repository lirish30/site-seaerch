# Agency OS — Plan 7: Projects, SOP Engine, Tasks, Time, Change Orders Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** When a client's deposit is paid, turn the signed proposal into projects whose steps come from SOP templates. Steps become tasks that Logan or Claude work through, with hard gates, a timer and timesheet, recurring cadences, and small change orders the client signs before extra work unlocks.

**Architecture:** `onInvoicePaid` (Plans 5 and 6) calls `startProjects`, which picks SOP templates from the signed document's package keys and copies each into a project as `tasks` rows (the SOP *instance* is the project's tasks, so editing a client's SOP is editing its tasks). Readiness, blocking and "waiting on client" are derived by pure functions, never stored. `Claude` steps become Claude-queue jobs (`sop.step`) dispatched only when ready; their results either finish the task or land as a `sop.review` approval. A change order is its own record with its own client link; it is signed in this plan and paid through Plan 8's invoice, and only signed **and** paid unlocks its tasks.

**Tech Stack:** Existing stack (Workers, Hono, D1, `RAW` R2, zod, vitest Workers pool, React SPA, the Claude task queue from Plan 2.5). No new npm packages and no direct Claude API calls.

**Spec:** `docs/superpowers/specs/2026-11-17-agency-os-design.md` (source: `/Users/loganirish/Project Sites/agency/docs/specs/2026-11-17-agency-os-design.md`). Implemented: §9.6 (SOP templates with owner tags, estimates, done-when, linked templates, cadence; SOP instances; steps→tasks; Claude steps as agent jobs and `Claude drafts → Logan approves` as approvals; recurring cadence tasks; time with timer, manual entry, weekly grid, estimate vs actual, billable flag; profit per project; change orders; seed SOPs BUILD, QUICKFIX, CARE-0, CARE-1, CARE-4); §9.5 (project moves to *Waiting on client* after 14 days of silence; the "done / next" half of the Friday email that Plan 6 deferred); §7 (Project, SOP template/instance/step, Task, Time entry); §12 Phase 2 line "Projects, SOP engine, tasks, time, change orders". **Not in this plan:** capacity warnings and batch views (spec §12 puts both in Phase 3), the Care edit-time ledger, the other seed SOPs (PROSPECT, CARE-2/3/5/6/7, SEO-0…3, REVIEWS, OFFBOARD; Logan or a Phase 3 plan adds them in the SOP editor), the Stripe invoice for a change order and for milestones (Plan 8; this plan records the milestone and the signed/paid state and exposes the hook), client/site records and the access checklist (Plan 9), Meetily scope flags (Plan 10; Claude can already propose a change order through MCP), API spend in profit (Claude runs on the subscription, so there is none to count).

**Phase 2 roadmap:** 6 Onboarding (built, PR not yet merged at time of writing) · **7 Projects, SOP engine, tasks, time, change orders (this plan)** · 8 Stripe invoices, subscriptions, reminders and pause · 9 Client and site records, access checklist · 10 Meetily, full MCP, money dashboard v1.

**Starts from:** `main` after Plan 6 merges (branch `feat/agency-os-onboarding`, HEAD 08ef0e1, 17 commits over 1ff3777; if it is still open, branch from it and rebase). Relies on: `onInvoicePaid`/`winDeal` (`documents/deposit.ts`), `Document`, `ProposalContent` (`content.packages[].key`, `content.careDeclined`, `content.schedule.milestones[].dueOn`), `legalGate`/`parseDocumentsConfig` (`documents/config.ts`), `SignFormSchema`/`consentTextFor` (`documents/public.ts`), `ESIGN_VERSION` (`documents/consent.ts`), `canonicalJson`/`sha256Hex` (`documents/hash.ts`), `newClientToken`/`isClientToken` (`documents/token.ts`), `clientBase` (`documents/mail.ts`), `PUBLIC_PAGE_PREFIXES` (`mail/send.ts:48`), `sendEmail`, `registerHandler`/`createApproval`/`toApproval`, the queue (`enqueueTask`, `registerTaskKind`, `TaskKindDef`, `TaskRefused`, `queue/kinds.ts`), `getOnboardingForDeal`, `stageOf`, `Stage` (`onboarding/schedule.ts`), `sweepOnboardings` and `renderFriday` (`onboarding/sweep.ts`, `onboarding/mail.ts`), `getPackage` (`db/packages.ts`), `getDeal`, `getBookingConfig` timezone, `logActivity`/`logActivityOnce`, `runScheduled` (`schedule.ts`), `buildToday` (`today.ts`), `clientLimited` and the public-route patterns (`routes/public.ts`), `isPublic*` regexes (`auth.ts`), `Shell` rail (`components/Shell.tsx`, `navView.ts`). Migration numbers are placeholders: take the next free after the last on `main` (0054 at time of writing).

## Global Constraints

- Branch `feat/agency-os-projects` from `main`. `npm test && npm run typecheck` pass after every task; `npm run build` after every UI task. Never edit an applied migration. Run from the worktree `../site-search-agency-os`. Subagents run on Sonnet (standing preference).
- Nothing client-bound is sent without Logan's approval (spec §2): the change-order mail is an approval (`change_order.send`), the Friday done/next is Plan 6's approval, and no SOP step mails anyone by itself. A **test** project or change order (`test = 1`) mails only `settings.contact_email`, never the contact on the document (the Plan 5/6 lesson).
- Store no password, key or login in a task, comment, checklist or result (spec §2 anti-goal); access steps record *where* the credential lives (a password-manager item name), never the value. Task comments and Claude results are scanned with `looksLikeCredential` (Plan 6, `onboarding/templates.ts`) and refused when they match.
- Text from a client (onboarding answers, change-order name) and text Claude returns are untrusted: length-capped, control and bidirectional characters stripped (`cleanText`, Plan 6), escaped wherever shown. Client answers reach Claude only inside the queue's untrusted block, never in `instructions`.
- Client pages use `CLIENT_LINK_BASE` (spec §5), never `workers.dev`, never the cold-email host. A token that is unknown, malformed or revoked answers 404 for every route; responses are `no-store`, `noindex`, `no-referrer`, `frame-ancestors 'none'`.
- Money is integer cents; hours are multiples of 0.25 and stored as integer minutes. Times are UTC ISO strings with milliseconds; "today", weeks and due dates use the booking config timezone (default America/Los_Angeles). `YYYY-MM-DD` strings are calendar dates in that zone.
- Rates and defaults come from the catalog, not from literals: the change-order rate defaults to the current `hourly` package price (`getPackage(db, "hourly")`); proposal expiry uses `documents_config.expiryDays`; the legal gate (`legalGate`) applies to a real change-order send exactly as it does to a proposal.
- Seed SOP text (titles, done-when, client summaries) is written fresh in Logan's plain voice. `research/kb/*.md` supplies structure only (phases, order, owner tags, estimates); never copy its wording, never name a course or Webfor in a seed, and never publish anything from `research/` (private resale material).
- Follow existing patterns: zod, DB helpers in `src/worker/db/*.ts`, pure view helpers in `src/client/*View.ts` tested in `test/*-view.test.ts`, one-per-key idempotence through `UNIQUE` plus `INSERT OR IGNORE`, guards written into the SQL statement.

## Scope decisions (flag to Logan)

- **A project per sold job, started by a real deposit**, from `onInvoicePaid`, idempotent per `(document, template)`. A site option gets a BUILD project; a Quick Fix a QUICKFIX project; a Care package a CARE-0 project, created now when nothing is being built and otherwise when the build project finishes (Care starts at launch, spec §8). A "Start a test project" button on a test lead rehearses it. A Local SEO sale leaves a timeline note ("no SOP for Local SEO yet") until a template exists.
- **The SOP instance is the project's tasks.** Editing a client's SOP edits that project's tasks; "push back to template" saves the instance's steps as the template's next version (explicit, confirmed, never automatic). Editing a template never touches an existing project.
- **Seed templates are inserted by code, not SQL** (`ensureSeedSops`, insert-if-missing by key, never overwrites an edit), called on first use and by the SOP editor. They are Logan's to edit in Settings > SOPs.
- **Ready means:** status `todo`, every `requires` step done (a skipped step counts only when it is marked skippable), and the step is in the project's *current phase* (the lowest phase with an unfinished step) or an earlier one. This is what stops 50 Claude jobs dispatching at once. Logan can work any step from any phase by hand; only Claude dispatch is phase-limited.
- **Claude dispatch is automatic for real projects, never for test ones** (a rehearsal must not spend subscription time unasked; "Ask Claude" works on a test task). At most 5 Claude jobs are in flight at once.
- **Waiting on client is derived**, not stored: a project whose onboarding is `waiting_on_client` (Plan 6, 14 days of silence) dispatches nothing and shows the state; a client write clears it. `paused` is stored (Plan 8 sets it for an invoice 14 days overdue).
- **Two milestones are marked by steps:** `design_approved` on BUILD 4.5 ("client OK on the design direction") and `site_finished` on 6.8 ("client OK to launch"), matching `Milestone.dueOn` in the payment schedule. Reaching one records it and runs `onMilestone` hooks; Plan 8 invoices from it. Tying `site_finished` to the client's go-ahead (before launch) is my call.
- **Change orders pay through Plan 8.** Until then a signed change order stays locked, and Logan can press "Mark paid (outside Stripe)" after the money is in his account (confirm dialog, logged). Plan 8's webhook calls the same `markChangeOrderPaid`.
- **Rate for change orders** defaults to the `hourly` price, editable per change order; the panel shows the Care client's rate (`care.altPriceCents`) as a hint. Which rate a Care client should get is Logan's to confirm.
- **Timers:** one running timer app-wide (starting another saves the first); a timer left running is saved at a cap (default 12 hours, `work_config.timerCapMinutes`) with a note. Entries under 30 seconds are dropped. Week starts Monday (setting).
- **Cut line (spec §12 six-week rule):** drop the Today item and the Friday done/next (Task 12), then recurring cadences (Task 12), then the profit card (Task 3/10). Projects, SOP engine, tasks, time, change orders and the Claude dispatch stay.

## Review Focus

1. **Client mailed who must not be, or twice; internal text leaking out.** A test change order mailing the real contact; a send approved twice; the legal gate bypassed; the Friday email listing a task title that has no client summary; a change-order page showing the project's internal tasks. Tests in Tasks 6, 7 and 12.
2. **Unlocking extra work too early.** Signed but unpaid; paid but unsigned; signed on content that changed since (hash); signed twice; paid twice (webhook replay); expired or voided after signing; a task of a void change order. Tests in Task 7.
3. **Timers and time.** Two timers; a timer left running over a weekend; a timer on a done task; a 25-hour manual entry; an entry at 23:30 Sunday Pacific landing in the wrong week; editing an invoiced entry; DST week. Tests in Task 3.
4. **Dispatch storms and stale results.** The same step queued twice; every step queued at once; dispatch while paused, waiting on client or in a test project; Logan finishing a step by hand while Claude holds it; a result with a non-https link, a password-looking line or a prompt-injection line copied from a client answer; a failed or expired job leaving the task stuck. Tests in Task 5.
5. **Gates and projects that are not what the plan assumes.** Go-live completing with a gate open; a skipped non-skippable step satisfying `requires`; a replayed webhook starting a second project; an option with build + Care + SEO; `careDeclined`; no template for a package; a template edited mid-project; deleting a step another step requires; push-back of an instance with removed steps; a lead with a project being deleted. Tests in Tasks 1, 2, 4 and 6.

---

### Task 1: Storage and SOP templates

**Files:**
- Create: `migrations/<next>_projects.sql`, `src/worker/sop/model.ts`, `src/worker/db/sops.ts`, `src/worker/sop/seeds.ts`
- Test: `test/sop-model.test.ts`, `test/sop-db.test.ts`, `test/sop-seeds.test.ts`

**Interfaces:**
- Produces (`sop/model.ts`, pure):
  - `OWNER_TAGS = ["claude", "logan", "claude_drafts"] as const`; `OwnerTag`; `OWNER_LABEL: Record<OwnerTag, string>` ("Claude", "Logan", "Claude drafts → Logan approves"); `Cadence = "weekly" | "monthly" | "quarterly" | "annual"`; `MilestoneKey = "design_approved" | "site_finished"`.
  - `SopStep { key: string; phaseKey: string; phaseTitle: string; position: number; title: string; owner: OwnerTag; estMinutes: number; doneWhen: string; docTemplate: string | null; emailTemplate: string | null; requires: string[]; milestone: MilestoneKey | null; clientSummary: string | null; skippable: boolean }`
  - `SopTemplate { id: string; key: string; name: string; kind: "project" | "recurring"; cadence: Cadence | null; cadenceDay: number | null; appliesTo: PackageKey[]; version: number; active: boolean; steps: SopStep[]; updatedAt: string }`; `SopTemplateInput = Omit<SopTemplate, "id" | "version" | "updatedAt">`.
  - `SopTemplateInputSchema` (zod): key `/^[A-Za-z0-9._-]{1,20}$/`, name ≤ 80, step title ≤ 120, doneWhen ≤ 300, `estMinutes` integer 0–600, ≤ 120 steps, `cadence` required exactly when `kind = "recurring"`, `cadenceDay` 1–7 (ISO weekday) for weekly and 1–28 for monthly, `clientSummary` ≤ 80.
  - `validateTemplate(t: SopTemplateInput): string[]` (problems as plain sentences: duplicate step key, `requires` names an unknown key or itself, a `requires` cycle, a milestone on two steps, a milestone on a recurring template, positions not strictly increasing).
  - `unmetRequirements(requires: string[], tasks: { stepKey: string | null; title: string; status: TaskStatus; skippable: boolean }[]): string[]` (titles of unmet; `done` always satisfies, `skipped` only when `skippable`, a missing key is unmet); `TaskStatus = "todo" | "in_progress" | "in_review" | "waiting_client" | "done" | "skipped" | "locked"`.
- Produces (`db/sops.ts`): `SopInputError`; `listTemplates(db, o?: { includeInactive?: boolean }): Promise<SopTemplate[]>`; `getTemplate(db, key): Promise<SopTemplate | null>`; `saveTemplate(db, input: SopTemplateInput): Promise<SopTemplate>` (insert, or replace the steps and bump `version`, in one batch; throws `SopInputError` with the `validateTemplate` problems); `setTemplateActive(db, key, on: boolean)`; `templatesForPackages(db, keys: PackageKey[]): Promise<SopTemplate[]>` (active `project` templates whose `appliesTo` intersects `keys`, in catalog order); `ensureSeedSops(db): Promise<number>` (insert-if-missing by key; returns how many it inserted; never overwrites).
- Produces (`sop/seeds.ts`): `SEED_SOPS: SopTemplateInput[]`.
  - **BUILD** ("Website build", applies to `starter_site`, `growth_site`, `website_subscription`): nine phases (Collect, Plan, Design, Initial review, Build out, QA and final review, Launch, Handoff, Care offer) and about 50 steps, from the structure of `research/kb/josh-hall-process.md` §7 with Phase 0 left out (Plans 4–5 do it) and its steps 1.1/1.3/1.4 replaced by one gate step "Onboarding collected" (Plan 6 does them). Keep the owner tags, estimates and done-when intent; keep the review rule from spec §9.6 (header, footer, home and 1–2 inner pages first, a walkthrough video of 5 minutes or less, the rest built after approval, forms tested early, final review mid-week, launch on a Friday, backup before launch). Step `7.4 Go live` `requires` every QA step in phase 6, the backup (7.2) and the client OK (6.8). `design_approved` sits on 4.5, `site_finished` on 6.8. About ten client-visible steps carry a `clientSummary` in plain words ("We're building your home page").
  - **QUICKFIX** ("Quick fix", applies to `quick_fix`): one phase, about 8 steps (confirm the list, get access, backup, make the fixes, test, show before/after, client OK, close and ask for a review).
  - **CARE-0** ("Care onboarding", applies to `care`, `care_plus`, `care_fallback`): the nine steps of `research/kb/josh-hall-maintenance-seo.md` §10.1.
  - **CARE-1** (`recurring`, weekly, `cadenceDay` 3 = Wednesday, "Care weekly update": the six steps of §10.2) and **CARE-4** (`recurring`, monthly, `cadenceDay` 5, "Care monthly report": the six steps of §10.5).
- Migration tables (header comments: UTC ISO times, integer cents and minutes, no `ON DELETE CASCADE` on `business_id`/`deal_id`/`document_id` because these are records the app never deletes, client text is untrusted): `sop_templates`, `sop_template_steps` (PK `(template_id, key)`), and the tables Tasks 2, 3 and 7 define (`projects`, `project_milestones`, `project_cadences`, `tasks`, `task_comments`, `time_entries` with `CREATE UNIQUE INDEX uq_time_running ON time_entries(source) WHERE ended_at IS NULL`, `change_orders`), plus `ALTER TABLE settings ADD COLUMN work_config TEXT NOT NULL DEFAULT '{}'`.

- [ ] **Step 1: Write the failing tests.** Model: `a requires cycle is a problem`, `requires an unknown key is a problem`, `two steps with one milestone is a problem`, `a recurring template needs a cadence and a weekly one needs a weekday 1 to 7`, `unmetRequirements counts done, counts skipped only when skippable, and names a missing key`. DB: `saveTemplate inserts then replaces steps and bumps version`, `saveTemplate with problems throws SopInputError and changes nothing`, `templatesForPackages(["starter_site","care"]) returns BUILD and CARE-0`, `quick_fix alone returns QUICKFIX`, `local_seo alone returns nothing`, `an inactive template is not returned`. Seeds: `every seed passes validateTemplate`, `BUILD has nine phases and between 45 and 60 steps`, `go live requires every QA step, the backup and the client OK`, `design_approved and site_finished are each on exactly one BUILD step`, `no seed step title or doneWhen names a course or Webfor`, `every clientSummary is 80 characters or less`, `ensureSeedSops inserts five and a second call inserts none`, `an edited seed is not overwritten by ensureSeedSops`.
- [ ] **Step 2: Run to verify failure.** Run: `npx vitest run test/sop-model.test.ts test/sop-db.test.ts test/sop-seeds.test.ts`. Expected: FAIL (modules missing).
- [ ] **Step 3: Migration** with every table named above (columns as Tasks 2, 3 and 7 define them).
- [ ] **Step 4: Implement** `sop/model.ts`, `db/sops.ts` and `sop/seeds.ts` to the signatures above.
- [ ] **Step 5: Run all.** Run: `npm test && npm run typecheck`. Expected: PASS.
- [ ] **Step 6: Commit** — `git add -A && git commit -m "feat(projects): storage and SOP templates"`

---

### Task 2: Projects, tasks and SOP instances

**Files:**
- Create: `src/worker/db/projects.ts`, `src/worker/db/tasks.ts`, `src/worker/sop/instantiate.ts`
- Modify: `src/worker/routes/leads.ts` (the lead-delete guard, beside the onboarding one), `src/worker/types.ts` (`ACTIVITY_KINDS` gains `"project_started"`, `"project_milestone"`, `"project_done"`, `"change_order_sent"`, `"change_order_signed"`, `"change_order_paid"`, `"change_order_void"`), `src/worker/today.ts` (`NOT_CONTACT` gains the same seven), `src/client/activityView.ts` (labels)
- Test: `test/projects-db.test.ts`, `test/tasks-db.test.ts`, `test/sop-instantiate.test.ts`

**Interfaces:**
- Consumes: Task 1 (`SopTemplate`, `OwnerTag`, `TaskStatus`, `MilestoneKey`).
- Produces (`db/projects.ts`):
  - `ProjectKind = "build" | "quick_fix" | "care_onboarding" | "custom"`; `ProjectStatus = "active" | "paused" | "done" | "cancelled"`.
  - `Project { id; businessId; dealId: string | null; documentId: string | null; onboardingId: string | null; kind: ProjectKind; name: string; status: ProjectStatus; pausedReason: string | null; test: boolean; templateKey: string | null; templateVersion: number | null; careDeferred: boolean; startedAt: string; completedAt: string | null; createdAt: string; updatedAt: string }`
  - `createProject(db, o: { businessId; dealId; documentId; onboardingId; kind; name; test: boolean; templateKey: string | null; templateVersion: number | null; careDeferred: boolean; startedAt: string }): Promise<{ project: Project; created: boolean }>` (idempotent per `(document_id, template_key)`; a second call returns the first with `created: false`).
  - `getProject(db, id)`, `listProjects(db, o?: { status?: ProjectStatus[]; businessId?: string }): Promise<(Project & { businessName: string; openTasks: number; doneTasks: number })[]>`, `hasProject(db, businessId): Promise<boolean>`, `setProjectStatus(db, id, status, o?: { reason?: string | null; now?: string }): Promise<Project>` (`done` stamps `completedAt`; guarded: `done` and `cancelled` never reopen).
  - `reachMilestone(db, projectId, m: MilestoneKey, now: string): Promise<boolean>` (true only the first time); `listMilestones(db, projectId): Promise<{ milestone: MilestoneKey; reachedAt: string }[]>`; `addCadence(db, projectId, templateKey: string): Promise<boolean>` (idempotent); `listCadences(db, o?: { activeProjectsOnly?: boolean }): Promise<{ id: string; projectId: string; templateKey: string }[]>`.
- Produces (`db/tasks.ts`):
  - `Task { id; projectId; businessId; isStep: boolean; stepKey: string | null; phaseKey: string; phaseTitle: string; position: number; title: string; description: string; owner: OwnerTag; status: TaskStatus; doneWhen: string; estMinutes: number; dueOn: string | null; billable: boolean; skippable: boolean; requires: string[]; milestone: MilestoneKey | null; clientSummary: string | null; docTemplate: string | null; emailTemplate: string | null; checklist: { text: string; done: boolean }[]; changeOrderId: string | null; cadenceKey: string | null; periodKey: string | null; claudeTaskId: string | null; reviewApprovalId: string | null; startedAt: string | null; doneAt: string | null; createdAt: string; updatedAt: string }`
  - `insertTasks(db, rows: NewTask[]): Promise<Task[]>` (one batch; `NewTask` = `Task` minus `id`, timestamps, `claudeTaskId`, `reviewApprovalId`); `getTask(db, id)`; `listTasks(db, projectId)` (by position); `listOpenTasksForLogan(db): Promise<(Task & { projectName: string; businessName: string })[]>`.
  - `patchTask(db, id, p: TaskPatch, now): Promise<Task>` where `TaskPatch` is any of `title`, `description`, `owner`, `doneWhen`, `estMinutes`, `dueOn`, `billable`, `skippable`, `requires`, `checklist`, `clientSummary` (caps: title 120, description 2000, checklist ≤ 40 items of ≤ 200); `setTaskStatus(db, id, to: TaskStatus, o: { from?: TaskStatus[]; now: string; claudeTaskId?: string | null; reviewApprovalId?: string | null }): Promise<boolean>` (the `from` guard is in the SQL, true only when a row changed; `done` stamps `doneAt`, the first `in_progress` stamps `startedAt`); `moveTask(db, id, toPosition: number)` (renumbers the project's tasks inside one batch); `deleteTask(db, id): Promise<boolean>` (only `todo`, never started, no time entries, no other task `requires` its `stepKey`; otherwise false).
  - `addComment(db, taskId, author: "logan" | "claude" | "system", body: string, now): Promise<void>` (body cleaned with `cleanText`, ≤ 4000); `listComments(db, taskId): Promise<{ id; author; body; createdAt }[]>`.
- Produces (`sop/instantiate.ts`): `instantiateSop(db, o: { project: Project; template: SopTemplate }): Promise<Task[]>` (every step becomes a task: tag, estimate, done-when, requires, milestone, client summary, linked templates, `skippable` copied; `isStep = true`, `status = "todo"`, `billable = false`, `dueOn = null`); `stepsFromTasks(tasks: Task[]): SopStep[]` (the inverse, used by push-back in Task 9; skips tasks with `isStep = false`).

- [ ] **Step 1: Write the failing tests.** `createProject is idempotent per document and template`, `a project for a test document is a test project`, `instantiate copies every step with tag, estimate, done-when, requires and milestone`, `a template saved after instantiation leaves the project's tasks unchanged`, `setTaskStatus with a from guard changes nothing when the status moved`, `done stamps doneAt and the first in_progress stamps startedAt once`, `reachMilestone is true once`, `addCadence twice stores one`, `deleteTask refuses a started task, a task with time, and a step another task requires`, `moveTask renumbers without gaps`, `a comment is stored as capped text with control and bidi characters removed`, `done and cancelled projects never reopen`, `the lead delete route refuses a lead that has a project`, `stepsFromTasks round-trips instantiateSop for a template`.
- [ ] **Step 2: Run to verify failure.** Run: `npx vitest run test/projects-db.test.ts test/tasks-db.test.ts test/sop-instantiate.test.ts`. Expected: FAIL.
- [ ] **Step 3: Implement** the three modules to the signatures above, the lead-delete guard (like the onboarding one) and the activity-kind edits.
- [ ] **Step 4: Run all.** Run: `npm test && npm run typecheck`. Expected: PASS.
- [ ] **Step 5: Commit** — `git add -A && git commit -m "feat(projects): projects, tasks, SOP instances"`

---

### Task 3: Time, work settings and profit

**Files:**
- Create: `src/worker/db/time.ts`, `src/worker/time/config.ts`, `src/worker/time/service.ts`, `src/worker/time/profit.ts`
- Modify: `src/worker/db/settings.ts` (`FIELDS` gains `"work_config"`), `src/worker/types.ts` (`Settings.work_config: string`), `src/worker/routes/settings.ts` (accept and validate it), `src/worker/db/invoices.ts` (new `paidTotalForDeal`)
- Test: `test/time-db.test.ts`, `test/time-service.test.ts`, `test/time-profit.test.ts`

**Interfaces:**
- Consumes: Tasks 1–2 (`Task`, `getTask`), `getBookingConfig` timezone.
- Produces (`time/config.ts`): `WorkConfig { costRateCentsPerHour: number; weekStartsOn: 0 | 1; timerCapMinutes: number }` (defaults `0`, `1`, `720`); `WorkConfigSchema` (cost 0–50000, cap 60–1440); `parseWorkConfig(raw: string): WorkConfig` (`""`/`"{}"` give defaults, a document that no longer validates gives defaults).
- Produces (`db/time.ts`): `TimeEntry { id; taskId; projectId; businessId; startedAt: string; endedAt: string | null; minutes: number; billable: boolean; note: string; source: "timer" | "manual"; invoicedRef: string | null; createdAt }`; `runningEntry(db): Promise<TimeEntry | null>`; `insertEntry`, `getEntry`, `listEntriesForTask(db, taskId)`, `listEntriesBetween(db, fromIso, toIso): Promise<(TimeEntry & { title: string; projectName: string })[]>`; `patchEntry(db, id, p: { minutes?; billable?; note?; startedAt? }): Promise<TimeEntry>` and `deleteEntry(db, id): Promise<void>` (both refuse a row with `invoicedRef`, guarded in the SQL); `timeTotals(db, o: { taskId?: string; projectId?: string }): Promise<{ actualMinutes: number; billableMinutes: number }>`.
- Produces (`time/service.ts`):
  - `startTimer(env, taskId, now: Date): Promise<{ entry: TimeEntry; stopped: TimeEntry | null }>` (stops any running timer first in the same batch, so the unique index never trips; refuses a `done`, `skipped` or `locked` task with `TimeStateError`).
  - `stopTimer(env, now: Date, o?: { note?: string }): Promise<TimeEntry | null>` (minutes = elapsed rounded to the nearest minute; under 30 seconds the entry is deleted and null returned; over `timerCapMinutes` it is saved at the cap with note "stopped at the cap"); `stopTimerFor(db, taskId, now)` (no-op unless that task's timer is the running one); `capStaleTimers(env, now): Promise<number>`.
  - `addManualEntry(env, o: { taskId; day: string; minutes: number; billable?: boolean; note?: string }, now: Date): Promise<TimeEntry>` (`minutes` integer 1–1440, `day` not after today in the zone, task not `locked`; the entry's `startedAt` is noon of `day` in the zone; billable defaults to the task's flag).
  - `weekGrid(db, o: { weekOf: string; tz: string; weekStartsOn: 0 | 1 }): Promise<{ days: string[]; rows: { taskId: string; projectId: string; projectName: string; title: string; minutes: number[]; total: number }[]; dayTotals: number[]; total: number }>` (an entry belongs to the day its `startedAt` falls on in `tz`).
- Produces (`time/profit.ts`, pure): `projectProfit(o: { soldCents: number; paidCents: number; minutes: number; costRateCentsPerHour: number }): { costCents: number; marginSoldCents: number; marginPaidCents: number; effectiveHourlyCents: number | null }` (cost = `round(minutes × rate / 60)`; effective hourly = paid per hour, null at zero minutes); `estimateVsActual(estMinutes: number, actualMinutes: number): { deltaMinutes: number; state: "none" | "under" | "near" | "over" }` (near = within 10% over; over beyond it; none when no estimate).
- Produces (`db/invoices.ts`): `paidTotalForDeal(db, dealId): Promise<number>` (sum of `paid` invoices, integer cents).

- [ ] **Step 1: Write the failing tests.** DB/service: `starting a second timer stops the first and saves both`, `the unique index allows one running entry and a second insert is refused`, `a timer under 30 seconds is dropped`, `a timer left past the cap is saved at the cap with the note`, `capStaleTimers stops a timer left over a weekend`, `a timer cannot start on a done, skipped or locked task`, `a manual entry refuses 0, 1441 minutes, a future day and a locked task`, `a manual entry on a done task is allowed`, `an invoiced entry cannot be edited or deleted`, `stopTimerFor ignores another task's timer`. Grid: `an entry at 23:30 Sunday Pacific is in that week's Sunday column`, `weekStartsOn 0 and 1 give different columns for the same entries`, `a week across the autumn clock change still has seven days`, `totals add up by row, day and week`. Profit/config: `projectProfit with a zero cost rate has zero cost`, `projectProfit with zero minutes has no effective rate`, `effective hourly is paid cents per hour rounded to a cent`, `estimateVsActual states`, `parseWorkConfig falls back on invalid JSON and out-of-range values`, `paidTotalForDeal sums paid invoices only`.
- [ ] **Step 2: Run to verify failure.** Run: `npx vitest run test/time-db.test.ts test/time-service.test.ts test/time-profit.test.ts`. Expected: FAIL.
- [ ] **Step 3: Implement** the modules and the settings plumbing (the settings route validates `work_config` with `WorkConfigSchema`, refusing a bad value with 400).
- [ ] **Step 4: Run all.** Run: `npm test && npm run typecheck`. Expected: PASS.
- [ ] **Step 5: Commit** — `git add -A && git commit -m "feat(projects): time entries, work settings, profit"`

---

### Task 4: Task lifecycle, gates and milestones

**Files:**
- Create: `src/worker/projects/hooks.ts`, `src/worker/projects/service.ts`
- Test: `test/projects-service.test.ts`, `test/projects-hooks.test.ts`

**Interfaces:**
- Consumes: Tasks 1–3 (`unmetRequirements`, `setTaskStatus`, `reachMilestone`, `stopTimerFor`, `addComment`, `addCadence`, `setProjectStatus`).
- Produces (`projects/hooks.ts`): `onProjectDone(fn: (env: Env, p: Project) => Promise<void>): void`, `onMilestone(fn: (env: Env, p: Project, m: MilestoneKey) => Promise<void>): void`, `onTasksChanged(fn: (env: Env, projectId: string) => Promise<void>): void`; `runProjectDone`, `runMilestone`, `runTasksChanged` (each runs every hook, logs and swallows a hook's error: a hook failing never undoes the change that triggered it). Registered later by Tasks 5 and 6 and by Plan 8.
- Produces (`projects/service.ts`):
  - `TaskStateError`, `TaskBlockedError { blockedBy: string[] }` (titles of unmet requirements).
  - `startTask(env, id, now): Promise<Task>` (`todo`, `waiting_client` or `in_review` → `in_progress`; refuses `done`, `skipped`, `locked`, and a task whose `requires` are unmet).
  - `completeTask(env, id, o: { by: "logan" | "claude" | "system"; now: Date }): Promise<Task>` (refuses `locked` and unmet `requires`; stops the task's running timer; sets `done`; if the task has a `milestone`, `reachMilestone` then `runMilestone` only on the first time and logs `project_milestone`; if it was the last open step of the project, `setProjectStatus(done)`, logs `project_done`, attaches `CARE-1` and `CARE-4` cadences when the project kind is `care_onboarding`, and `runProjectDone`; then `runTasksChanged`). Idempotent: completing a done task returns it and fires nothing.
  - `skipTask(env, id, reason: string, now)` (reason 3–300 characters, stored as a `system` comment); `reopenTask(env, id, now)` (`done`/`skipped` → `todo`; never un-reaches a milestone, never reopens a finished project); `setWaitingClient(env, id, on: boolean, now)`; `updateTask(env, id, p: TaskPatch, now)` (adds the credential check on text fields); `addAdhocTask(env, o: { projectId; title; owner; estMinutes?; dueOn?; billable? }, now): Promise<Task>` (`isStep = false`, never finishes the project); `postComment(env, taskId, author, body, now)` (refuses text that `looksLikeCredential`).
  - `projectIsFinished(tasks: Task[]): boolean` (pure: every `isStep` task is `done` or `skipped`; at least one step exists).

- [ ] **Step 1: Write the failing tests.** `complete refuses while a required step is open and names it in blockedBy`, `a skipped skippable step satisfies requires but a skipped non-skippable one does not`, `go live stays blocked until every QA step, the backup and the client OK are done` (BUILD seed), `completing stops that task's running timer`, `a locked task cannot start or complete`, `the milestone step reaches the milestone once, logs once and runs the milestone hook once on a replay`, `completing the last step finishes the project once, logs project_done and runs the done hooks once`, `a care_onboarding project gets the CARE-1 and CARE-4 cadences when it finishes`, `a done hook that throws leaves the project done and is logged`, `an ad-hoc task never finishes the project`, `reopening a milestone step does not un-reach the milestone`, `a finished project is not reopened by reopening a step`, `a comment that looks like a credential is refused and not echoed`, `completing a done task fires nothing`.
- [ ] **Step 2: Run to verify failure.** Run: `npx vitest run test/projects-service.test.ts test/projects-hooks.test.ts`. Expected: FAIL.
- [ ] **Step 3: Implement** both modules. Every status change goes through `setTaskStatus` with a `from` guard so two requests cannot both win.
- [ ] **Step 4: Run all.** Run: `npm test && npm run typecheck`. Expected: PASS.
- [ ] **Step 5: Commit** — `git add -A && git commit -m "feat(projects): task lifecycle, gates, milestones"`

---

### Task 5: Claude steps: dispatch, results, review

**Files:**
- Create: `src/worker/sop/ready.ts`, `src/worker/projects/waiting.ts`, `src/worker/projects/dispatch.ts`, `src/worker/queue/sopStep.ts`, `src/worker/approvals/sopReview.ts`
- Modify: `src/worker/queue/kinds.ts` (import `./sopStep`), `src/worker/index.ts` (import the approval), `src/worker/mcp/server.ts:13` (`APP_PROPOSED` gains `"sop.review"`, `"change_order.send"`)
- Test: `test/sop-ready.test.ts`, `test/projects-dispatch.test.ts`, `test/sop-step-queue.test.ts`

**Interfaces:**
- Consumes: Tasks 2 and 4; `enqueueTask`, `registerTaskKind`, `TaskKindDef`, `TaskRefused`; `getOnboarding`, `listItems`, `getAnswers`, `stageOf`; `createApproval`, `registerHandler`.
- Produces:
  - `currentPhase(tasks: Task[]): number | null` (the lowest `position`-ordered phase with a task that is not `done` or `skipped`, among `isStep` tasks); `readyClaudeTasks(tasks: Task[], o: { projectActive: boolean; waiting: boolean }): Task[]` (`sop/ready.ts`, pure: owner is `claude` or `claude_drafts`, status `todo`, `requires` met, phase at or before the current one, `changeOrderId` null or unlocked).
  - `projectWaiting(db, p: Project, now: Date): Promise<boolean>` (`projects/waiting.ts`: the linked onboarding's `stageOf` is `waiting_on_client`).
  - `SOP_STEP_KIND = "sop.step"`; `SopStepPayload = { taskId: string }`; `SopStepResult = { summary: string (1–4000); checklist?: { text: string (≤200); done: boolean }[] (≤30); links?: string[] (https URLs ≤300, ≤10); needsLogan?: string (≤500) }`; the `TaskKindDef` (`suggestedModel: "sonnet"`).
    - `build`: `{ stale }` when the task is `done`, `skipped` or `locked`, or the project is not `active`. Otherwise fixed `instructions` (trusted text the app wrote: the step title, done-when, owner mode, project name and kind, package names, Logan's own comments) and `untrusted` parts: the onboarding answers, and the text of received items, each as a separate part.
    - `apply`: stale when the task is no longer `in_progress` for this job. Refuses (`TaskRefused`) a non-https link or a summary/checklist that `looksLikeCredential`. Posts the summary as a `claude` comment and merges the checklist. Owner `claude` and no `needsLogan`: `completeTask(by "claude")`. Owner `claude_drafts`, or `needsLogan` set: status `in_review` and one `sop.review` approval. `onExpire` and `onFail`: back to `todo` with a `system` comment "Claude did not finish this step", clearing `claudeTaskId`.
  - `requestClaudeStep(env, taskId, o?: { note?: string }): Promise<{ queued: boolean }>` (marks `in_progress` and enqueues with `dedupeKey: taskId`, `targetType: "task"`, `targetId: taskId`; works on a test project's task; a note becomes a `logan` comment first); `dispatchReady(env, now: Date, o?: { limit?: number }): Promise<{ queued: number }>` (real, `active`, not-waiting projects only; at most `MAX_IN_FLIGHT = 5` queued or claimed `sop.step` tasks overall; registered as an `onTasksChanged` hook that ignores the project id and runs `dispatchReady(env, new Date())`, so a completed step dispatches the next).
  - `sop.review` handler (label "Approve Claude's step"): payload `{ taskId: string }`; preview shows the summary, links and checklist; `execute` calls `completeTask(by "logan")` (idempotent: a done task is left alone). One waiting approval per task. A rejected approval leaves the task `in_review`; `sendBack(env, taskId, note)` (route in Task 9) re-queues it with Logan's note as a comment.

- [ ] **Step 1: Write the failing tests.** Ready: `only the current phase's claude steps are ready`, `a step with an unmet requires is not ready`, `a logan step is never ready for Claude`, `a locked change-order task is not ready`. Dispatch: `a paused project dispatches nothing`, `a project waiting on client dispatches nothing and dispatches after a client write clears it`, `a test project dispatches nothing but requestClaudeStep works`, `dispatching twice queues once`, `no more than 5 are in flight`, `completing a step dispatches the next ready one`. Queue: `build is stale for a done task`, `client answers appear only in the untrusted parts`, `a claude step result completes the task and posts the summary`, `a claude_drafts result creates one review approval and the task is in_review`, `needsLogan on a claude step also goes to review`, `approving the review completes the task and approving twice completes once`, `a result after Logan finished the step by hand is stale and changes nothing`, `a non-https link is refused and the task stays claimed`, `a password-looking line in the summary is refused`, `onExpire and onFail return the task to todo with a comment and a cleared claudeTaskId`, `sop.review and change_order.send cannot be proposed through MCP`.
- [ ] **Step 2: Run to verify failure.** Run: `npx vitest run test/sop-ready.test.ts test/projects-dispatch.test.ts test/sop-step-queue.test.ts`. Expected: FAIL.
- [ ] **Step 3: Implement** the modules, the kind and approval registrations and the hook registration.
- [ ] **Step 4: Run all.** Run: `npm test && npm run typecheck`. Expected: PASS.
- [ ] **Step 5: Commit** — `git add -A && git commit -m "feat(projects): Claude steps, dispatch, review"`

---

### Task 6: Start projects on payment

**Files:**
- Create: `src/worker/projects/start.ts`
- Modify: `src/worker/documents/deposit.ts` (`onInvoicePaid`), `src/worker/index.ts`
- Test: `test/projects-start.test.ts`

**Interfaces:**
- Consumes: Tasks 1, 2, 4, 5; `Document`; `getOnboardingForDeal`; `templatesForPackages`, `ensureSeedSops`; `logActivityOnce`.
- Produces:
  - `startProjects(env, doc: Document, o?: { now?: Date }): Promise<Project[]>`: calls `ensureSeedSops`; reads the package keys from `doc.content.packages`; builds one *primary* project (BUILD when a build key is present, else QUICKFIX when `quick_fix` is, `kind` `build` or `quick_fix`) and one Care project (`care_onboarding`, CARE-0) unless `doc.content.careDeclined` or no Care key. With a primary project the Care project is *deferred* (`careDeferred = true` on the primary, nothing created yet); without one it is created now. A package with no template (Local SEO, Reviews) gets one `note` on the lead's timeline and nothing else. Name is `<client name>: <template name>`. Links `onboardingId` when the deal has one, copies `test` from the document, instantiates the SOP, logs `project_started` once per project, then `runTasksChanged` so Claude steps begin (real projects only). Idempotent per `(document, template)`; never throws into the caller for a missing template.
  - `startDeferredCare(env, primary: Project): Promise<Project | null>`: registered with `onProjectDone`; creates the CARE-0 project for the primary's document when `careDeferred`, once, and only if the primary was not cancelled.
  - `startTestProject(env, dealId): Promise<Project[]>`: for a deal whose latest signed document is a test copy (409 `TaskStateError`-style `ProjectStartError` otherwise).
- Modified `onInvoicePaid`: after `startOnboarding` and before `setPaid`, for a non-test document call `startProjects` in its own try/catch that logs and continues (the payment must always be recorded).

- [ ] **Step 1: Write the failing tests.** `a paid Starter proposal starts one build project with its onboarding linked and Claude steps queued`, `a replayed payment starts nothing new`, `a build plus Care starts the build and defers Care, and finishing the build starts CARE-0 once`, `Care alone starts CARE-0 now`, `careDeclined starts no Care project`, `Quick Fix starts QUICKFIX only`, `Local SEO alone leaves one timeline note and no project`, `an option with build, Care and Local SEO starts BUILD, defers Care and notes the SEO`, `a test document starts no project from payment`, `startTestProject makes a test project that queues nothing`, `a missing template does not break the payment`, `no onboarding for the deal still starts the project with onboardingId null`, `startDeferredCare does nothing for a cancelled primary`.
- [ ] **Step 2: Run to verify failure.** Run: `npx vitest run test/projects-start.test.ts`. Expected: FAIL.
- [ ] **Step 3: Implement** `start.ts`, the hook registrations and the `onInvoicePaid` edit.
- [ ] **Step 4: Run all.** Run: `npm test && npm run typecheck`. Expected: PASS.
- [ ] **Step 5: Commit** — `git add -A && git commit -m "feat(projects): start projects on payment"`

---

### Task 7: Change orders (server)

**Files:**
- Create: `src/worker/db/changeOrders.ts`, `src/worker/changeorders/service.ts`, `src/worker/changeorders/mail.ts`, `src/worker/approvals/changeOrderSend.ts`, `src/worker/approvals/changeOrderDraft.ts`
- Modify: `src/worker/mail/send.ts:48` (`PUBLIC_PAGE_PREFIXES` gains `"/c/"`), `src/worker/index.ts` (import both approvals). Plan 8's Stripe webhook will call `markChangeOrderPaid`; nothing in `stripe/` changes here.
- Test: `test/changeorders-db.test.ts`, `test/changeorders-service.test.ts`, `test/changeorders-approvals.test.ts`

**Interfaces:**
- Consumes: Tasks 2 and 4; `legalGate`/`parseDocumentsConfig`; `canonicalJson`/`sha256Hex`; `newClientToken`; `clientBase`; `sendEmail`; `getPackage`.
- Produces (`db/changeOrders.ts`):
  - `ChangeOrderStatus = "draft" | "sent" | "viewed" | "signed" | "declined" | "void" | "expired"`.
  - `ChangeOrderContent { reference: string; title: string; summary: string; reason: string; deliverables: string[]; notIncluded: string[]; hours: number; rateCents: number; priceCents: number; scheduleImpactDays: number | null; clientName: string; contactName: string; contactEmail: string }` and `ChangeOrderContentSchema` (title ≤ 120, summary ≤ 1500, reason ≤ 600, ≤ 10 items of ≤ 200, hours 0.25–200 in steps of 0.25, `priceCents` ≥ 1, schedule 0–180).
  - `ChangeOrder { id; projectId; businessId; dealId: string | null; seq: number; test: boolean; status; content; contentSha256: string | null; token: string | null; sourceType: "logan" | "claude" | "email" | "meeting"; originApprovalId: string | null; approvalId: string | null; sentAt; expiresAt; firstViewedAt; signedAt; signerName: string | null; signerEmail: string | null; signerIp: string | null; signerUserAgent: string | null; consentText: string | null; consentVersion: number | null; declinedReason: string | null; paidAt: string | null; paidVia: "stripe" | "manual" | null; voidReason: string | null; createdAt; updatedAt }`.
  - `createChangeOrderDraft`, `getChangeOrder(db, id)`, `getChangeOrderByToken(db, token)`, `listChangeOrders(db, projectId)`, `updateDraftContent(db, id, c)` (draft only), `markSent`, `recordView` (once per 10 minutes), `signChangeOrder(db, id, sig, now): Promise<"signed" | "already_signed" | "not_open">` (guarded in the statement: status `sent`/`viewed`, hash equals the sent hash), `declineChangeOrder`, `voidChangeOrder` (draft/sent/viewed only; a signed one is a record and is refused), `markPaid(db, id, o: { at: string; via: "stripe" | "manual" }): Promise<boolean>` (only a `signed` row; true the first time), `expireDue(db, now): Promise<ChangeOrder[]>`.
- Produces (`changeorders/service.ts`):
  - `draftChangeOrder(env, o: { projectId: string; title; summary; reason; hours: number; deliverables?: string[]; notIncluded?: string[]; scheduleImpactDays?: number | null; priceCents?: number; rateCents?: number; sourceType; originApprovalId?: string }): Promise<ChangeOrder>` (rate defaults to the `hourly` package price; price defaults to `round(hours × rate)`; refuses a `done` or `cancelled` project; creates one locked, billable task per deliverable on the project, or one task titled after the change order when there are none).
  - `editDraft(env, id, edits)`; `voidDraftOrSent(env, id, reason)` (withdraws a waiting send approval, locks nothing further, marks its tasks `skipped` with a system comment); `unlockIfReady(env, id, now): Promise<number>` (when the order is `signed` **and** `paidAt` set: its `locked` tasks become `todo`, logs once, `runTasksChanged`; idempotent, returns how many it unlocked); `markChangeOrderPaid(env, id, o: { via: "stripe" | "manual"; now: Date }): Promise<ChangeOrder>` (409 `ChangeOrderStateError` when not `signed`; idempotent; logs `change_order_paid`; calls `unlockIfReady`); `afterSigned(env, id, now)` (logs `change_order_signed`, calls `unlockIfReady`); `changeOrderLink(env, co): string | null`.
- Produces (approvals):
  - `change_order.send` (label "Send change order"; in `APP_PROPOSED`): payload `{ changeOrderId: string }`; `createChangeOrderSendApproval(env, co): Promise<Approval>` (one waiting per order; an edit withdraws it; preview shows To, subject, body, hours, rate, price, schedule impact). `execute` refuses a real send while `legalGate(config)` is non-null (message names Settings > Documents), seals the order (frozen content, `sha256Hex(canonicalJson(content))`, token, `expiresAt = now + expiryDays`), then mails the link: to `settings.contact_email` with subject prefix "[Test] " for a test order, else to the content's contact; a retry after a sent mail does not send again.
  - `change_order.draft` (label "Draft a change order"; agent-proposable): payload `{ projectId: string; title: string (≤120); summary: string (≤1500); reason: string (≤600); hours: number (0.25–40, step 0.25); source: "email" | "meeting"; sourceNote?: string (≤300) }`; `execute` calls `draftChangeOrder(... sourceType: source, originApprovalId: a.id)`, never sends, and is idempotent per approval (`UNIQUE origin_approval_id`).
- Mail copy (`changeorders/mail.ts`): `renderChangeOrderMail(co: ChangeOrder, link: string, s: Settings): { subject: string; body: string }`, plain text, one link, price and hours stated, "nothing starts until you sign and the invoice is paid".

- [ ] **Step 1: Write the failing tests.** `drafting prices hours at the hourly rate and rounds to cents`, `a custom price is kept`, `a done project refuses a change order`, `a draft's tasks are locked, billable and on the project`, `no deliverables makes one task named after the change order`, `one waiting send approval per order and an edit withdraws it`, `a real send before the legal review is refused with the Settings message and sends nothing`, `a test order mails only the owner with the [Test] prefix`, `approving twice sends once`, `the sealed hash changes when the content changes`, `signed alone does not unlock`, `paid alone before signing is a 409`, `signed then paid unlocks the locked tasks once, and a replayed paid unlocks none`, `signing content whose hash changed is not_open`, `signing twice stores one signature`, `voiding a signed order is refused`, `voiding a sent order skips its tasks`, `expireDue expires a sent order past expiresAt and its tasks stay locked`, `change_order.draft creates a draft and never sends`, `the same draft approval run twice makes one draft`, `change_order.draft with an unknown project is refused`.
- [ ] **Step 2: Run to verify failure.** Run: `npx vitest run test/changeorders-db.test.ts test/changeorders-service.test.ts test/changeorders-approvals.test.ts`. Expected: FAIL.
- [ ] **Step 3: Implement** the modules, registrations and the `"/c/"` prefix.
- [ ] **Step 4: Run all.** Run: `npm test && npm run typecheck`. Expected: PASS.
- [ ] **Step 5: Commit** — `git add -A && git commit -m "feat(projects): change orders"`

---

### Task 8: Change order client page

**Files:**
- Create: `src/worker/changeorders/public.ts`, `src/client/pages/ChangeOrder.tsx`, `src/client/changeOrderPageView.ts`
- Modify: `src/worker/routes/public.ts` (`GET /c/:token`, `POST /c/:token/sign`, `POST /c/:token/decline`, each behind `clientLimited`), `src/worker/auth.ts` (public-path regexes for exactly those three, one non-empty segment each), `src/client/App.tsx` (`<Route path="/c/*" element={<ChangeOrder />} />`, no shell), `public/_headers` (`/c` and `/c/*` like `/p`), `src/client/public.css`
- Test: `test/changeorders-public.test.ts`, `test/changeorder-page-view.test.ts`

**Interfaces:**
- Consumes: Task 7; `SignFormSchema`, `consentTextFor`, `ESIGN_VERSION`.
- Produces (`public.ts`):
  - `PublicChangeOrder { state: "open" | "signed" | "closed"; reference: string; clientName: string; contactName: string; projectName: string; title: string; summary: string; reason: string; deliverables: string[]; notIncluded: string[]; hours: number; rateCents: number; priceCents: number; scheduleImpactDays: number | null; expiresOn: string | null; contentSha256: string; consentText: string; ownerName: string; ownerBusiness: string; signed: { signerName: string; signedAt: string } | null; payment: "none" | "paid"; closedReason: "void" | "expired" | "declined" | null }` (never includes other tasks, notes, the owner's cost rate or any other client's data).
  - `changeOrderPage(env, token, o: { now: Date; userAgent: string | null }): Promise<PublicChangeOrder | null>` (null for malformed, unknown or draft; records a view and moves `sent` to `viewed`); `signChangeOrderPublic(env, token, form: unknown, o: { now: Date; ip: string | null; userAgent: string | null }): Promise<{ ok: true; page: PublicChangeOrder } | { ok: false; status: 400 | 404 | 409; error: string }>` (same shape and rules as `signProposal`: token first, then the form, then closed/expired, then the hash must match, then `signChangeOrder`, then `afterSigned`; a failure after the stored signature still answers ok); `declineChangeOrderPublic(env, token, reason: unknown, now)` (reason ≤ 300, cleaned).
- Page behavior (`ChangeOrder.tsx`): one column, phone first. Shows the change in plain terms, hours × rate = price, schedule impact, what is not included, the ESIGN disclosure and the two checkboxes, a name field, "Sign" and "No thanks". After signing: "Signed. We'll email the invoice; work starts once it's paid." Every client string is rendered as text. Pure helpers in `changeOrderPageView.ts`: `priceLine(hours, rateCents, priceCents): string`, `canSign(form): { ok: boolean; missing: string[] }`, `closedMessage(reason)`.

- [ ] **Step 1: Write the failing tests.** `an unknown, malformed, draft or revoked token is the same 404`, `the page never includes other tasks, the cost rate or another client`, `opening a sent order moves it to viewed and a second open within 10 minutes adds no view`, `signing records name, ip, user agent, consent text, version and hash`, `a changed hash is a 409`, `signing twice answers with the first signature and stores one`, `an expired or voided order answers closed`, `declining closes it, caps the reason and unlocks nothing`, `a bad form on an unreal token is 404 not 400`, `signed does not unlock by itself`, `responses carry no-store and noindex`, `the three routes are public but an owner route such as /api/projects is still 401`; view: `priceLine at 1.5 hours and 9500 cents`, `canSign lists what is missing`, `closedMessage covers every reason`.
- [ ] **Step 2: Run to verify failure.** Run: `npx vitest run test/changeorders-public.test.ts test/changeorder-page-view.test.ts`. Expected: FAIL.
- [ ] **Step 3: Implement** `public.ts`, the routes and auth regexes, the page and the view helpers (never viewed in a browser by the builder; the open-items note says so).
- [ ] **Step 4: Run all and build.** Run: `npm test && npm run typecheck && npm run build`. Expected: PASS.
- [ ] **Step 5: Commit** — `git add -A && git commit -m "feat(projects): change order client page"`

---

### Task 9: Owner API

**Files:**
- Create: `src/worker/routes/projects.ts`, `src/worker/routes/sops.ts`, `src/worker/routes/time.ts`, `src/worker/routes/changeOrders.ts`
- Modify: `src/worker/index.ts` (mount all four under `/api`)
- Test: `test/projects-routes.test.ts`, `test/sops-routes.test.ts`, `test/time-routes.test.ts`, `test/changeorders-routes.test.ts`

**Interfaces:**
- Consumes: Tasks 1–7. All routes sit behind `requireAuth` and use zod with the caps above.
- Produces:
  - Projects: `GET /projects?status=` → `{ projects: (Project & { businessName; openTasks; doneTasks; waitingOnClient: boolean })[] }`; `GET /projects/:id` → `{ project; tasks: Task[]; milestones; time: { actualMinutes; billableMinutes }; profit: ReturnType<typeof projectProfit> & { soldCents: number; paidCents: number }; waitingOnClient: boolean; changeOrders: ChangeOrder[]; template: { key; name; version } | null }`; `POST /projects` (custom project: `{ businessId, name }`); `POST /deals/:id/projects/test`; `PATCH /projects/:id` `{ status?: "active" | "paused" | "cancelled"; pausedReason? }`; `POST /projects/:id/tasks` (ad hoc); `POST /projects/:id/sop/push` `{ confirm: true }` → saves `stepsFromTasks` as the template's next version (409 for a custom project or a project with no template; returns the new version); `GET /tasks/:id` → `{ task; comments }`; `PATCH /tasks/:id`; `POST /tasks/:id/(start|complete|skip|reopen|waiting|comment|ask-claude|send-back)` (skip needs `reason`; comment needs `body`; ask-claude and send-back take an optional `note`; a `TaskBlockedError` answers 409 with `{ blockedBy }`); `POST /tasks/:id/move` `{ toPosition }`; `DELETE /tasks/:id` (409 when `deleteTask` refuses); `GET /me/tasks` → Logan's ready and in-review tasks, grouped by project.
  - SOPs: `GET /sops` (calls `ensureSeedSops` first), `GET /sops/:key`, `PUT /sops/:key` (zod `SopTemplateInputSchema`, 400 with `validateTemplate` problems), `POST /sops/:key/active`.
  - Time: `GET /time/running`, `POST /tasks/:id/timer/start`, `POST /timer/stop`, `POST /tasks/:id/time` (manual), `PATCH /time/:id`, `DELETE /time/:id` (409 when invoiced), `GET /time/week?of=YYYY-MM-DD` → `weekGrid` for the configured zone and week start.
  - Change orders: `GET /projects/:id/change-orders`; `POST /projects/:id/change-orders` (calls `draftChangeOrder`); `PATCH /change-orders/:id` (draft only); `POST /change-orders/:id/send` (creates the send approval; 409 for a non-draft); `POST /change-orders/:id/void` `{ reason }`; `POST /change-orders/:id/mark-paid` `{ confirm: true }` (409 unless `signed`; logs "marked paid by hand").
  - `GET /work-config` and the settings route already carry `work_config`.

- [ ] **Step 1: Write the failing tests.** `every route is 401 without a session`, `GET /projects/:id carries profit with the cost rate applied and never the token of a change order`, `custom project create and PATCH status to paused stores the reason`, `done and cancelled projects refuse reopening`, `complete on a gated step is 409 with blockedBy titles`, `skip without a reason is 400`, `delete of a started task is 409`, `a task of a test project can ask Claude and a real one is queued by dispatch`, `sop push saves the instance as the next template version and is 409 for a custom project`, `sop push omits a deleted step and keeps an added one`, `PUT /sops with a requires cycle is 400 with the problem sentence`, `GET /sops seeds on first call and a second call adds nothing`, `starting a timer on a done task is 409`, `week grid honours the configured week start`, `an invoiced entry cannot be deleted (409)`, `mark-paid needs confirm and a signed order`, `change order send creates one approval and a second call returns it`, `void of a signed order is 409`.
- [ ] **Step 2: Run to verify failure.** Run: `npx vitest run test/projects-routes.test.ts test/sops-routes.test.ts test/time-routes.test.ts test/changeorders-routes.test.ts`. Expected: FAIL.
- [ ] **Step 3: Implement** the four route files and mount them.
- [ ] **Step 4: Run all.** Run: `npm test && npm run typecheck`. Expected: PASS.
- [ ] **Step 5: Commit** — `git add -A && git commit -m "feat(projects): owner API"`

---

### Task 10: Owner UI: Projects, tasks, timer, timesheet

**Files:**
- Create: `src/client/pages/Projects.tsx`, `src/client/pages/Project.tsx`, `src/client/pages/Timesheet.tsx`, `src/client/components/TaskRow.tsx`, `src/client/components/TimerWidget.tsx`, `src/client/projectView.ts`, `src/client/timeView.ts`
- Modify: `src/client/navView.ts` (`Section` gains `"work"`; `/projects`, `/projects/*`, `/timesheet`, `/me/tasks`-style page path map to it; `sidebarOf` gives it a sidebar), `src/client/components/Shell.tsx` (a rail item "Projects", a sidebar with Active, Waiting on client, Paused, Done, Timesheet, and the timer widget in the rail), `src/client/App.tsx` (routes `/projects`, `/projects/:id`, `/timesheet`), `src/client/pages/Deal.tsx` (a "Project" link when the deal has projects), `src/client/styles.css` or a new `src/client/work.css`
- Test: `test/project-view.test.ts`, `test/time-view.test.ts`, `test/nav-view.test.ts` (extend)

**Interfaces:**
- Consumes: Task 9 routes (client types mirror the responses).
- Produces (`projectView.ts`, pure): `phaseGroups(tasks: Task[]): { phaseKey: string; title: string; tasks: Task[]; done: number; total: number }[]`; `taskState(t: Task, all: Task[]): { label: string; tone: "neutral" | "good" | "warn" | "muted"; blockedBy: string[] }` (labels "Ready", "Blocked by 7.2", "In review", "Waiting on client", "Locked: change order unpaid", "Done", "Skipped"); `ownerBadge(o: OwnerTag): string`; `projectProgress(tasks): { done: number; total: number; pct: number }`; `milestoneChips(ms)`; `profitLines(p): string[]` ("Cost rate not set" when 0; "Paid $X, cost $Y, margin $Z, about $N an hour").
- Produces (`timeView.ts`, pure): `formatMinutes(m: number): string` ("1h 05m"); `elapsedLabel(startedAt: string, now: Date): string`; `weekLabel(days: string[]): string`; `varianceLabel(est: number, actual: number): string` ("20% over", "on estimate", "no estimate").
- Behavior: Projects list (cards: client, kind, progress, next task, state chip including Waiting on client). Project page: header with status controls and milestone chips; tabs **Tasks** (phase groups, each task row with owner badge, estimate vs actual, Start/Done/Skip/Waiting, the timer button, expand for comments, checklist and an "Ask Claude" button), **SOP** (read-only phase list with the template name and version, the edit/push controls land in Task 11), **Time**, **Change orders** (panel in Task 11), **Profit** (card from `profitLines`). A test project wears a "Test" chip. The timer widget in the rail shows the running task and elapsed time with a Stop button. The timesheet is a week grid (Mon–Sun or per setting) with previous/next week, inline manual entry and row totals.

- [ ] **Step 1: Write the failing tests.** `phaseGroups orders phases and counts done`, `taskState says Blocked by 7.2 and names the open requirement`, `taskState for a locked change-order task`, `waiting client is muted not warn`, `formatMinutes at 65 and 0`, `elapsedLabel past a day`, `varianceLabel at 20% over and no estimate`, `profitLines with no cost rate`, `sectionOf maps /projects/abc and /timesheet to work and sidebarOf gives it a sidebar`.
- [ ] **Step 2: Run to verify failure.** Run: `npx vitest run test/project-view.test.ts test/time-view.test.ts test/nav-view.test.ts`. Expected: FAIL.
- [ ] **Step 3: Implement** the helpers, pages, components and nav edits. Touch targets at least 44 px, inputs 16 px minimum for iOS.
- [ ] **Step 4: Run all and build.** Run: `npm test && npm run typecheck && npm run build`. Expected: PASS. (The pages are never viewed in a browser by the builder.)
- [ ] **Step 5: Commit** — `git add -A && git commit -m "feat(projects): projects, tasks, timer and timesheet UI"`

---

### Task 11: Owner UI: SOP editor and change-order panel

**Files:**
- Create: `src/client/pages/settings/Sops.tsx`, `src/client/pages/settings/Work.tsx`, `src/client/components/ChangeOrdersPanel.tsx`, `src/client/sopView.ts`, `src/client/changeOrderView.ts`
- Modify: `src/client/App.tsx` (`/settings/sops`, `/settings/work`), `src/client/components/Shell.tsx` and `src/client/settingsView.ts` (two entries in the Settings sidebar), `src/client/pages/Project.tsx` (SOP tab edit/push controls, Change orders tab uses the panel)
- Test: `test/sop-view.test.ts`, `test/change-order-view.test.ts`

**Interfaces:**
- Consumes: Task 9 routes.
- Produces (`sopView.ts`, pure): `templateProblems(t: SopTemplateInput): string[]` (the same sentences `validateTemplate` gives, run before the save so the button explains itself); `stepRows(t): { phaseTitle: string; steps: SopStep[] }[]`; `totalEstimate(t): string` ("about 42 hours"); `diffSummary(before: SopTemplate, after: SopTemplateInput): string[]` ("3 steps added, 1 removed, 2 changed", used by the push-back confirm).
- Produces (`changeOrderView.ts`, pure): `statusLabel(s: ChangeOrderStatus, paid: boolean): string` ("Draft", "Waiting for client", "Viewed", "Signed, waiting for payment", "Signed and paid, work unlocked", "Declined", "Expired", "Void"); `statusTone`; `pricePreview(hours: number, rateCents: number, override: number | null): { priceCents: number; custom: boolean; line: string }`; `careRateHint(careAltCents: number | null, hourlyCents: number): string | null`.
- Behavior: **Settings > SOPs**: list of templates with version and step count; an editor with phases and steps (add, remove, reorder, owner tag, estimate, done-when, requires picker limited to other steps, milestone select, client summary, skippable, linked template names), an Active switch, save with the problem list shown inline. **Settings > Work**: cost rate ($/hour), week start, timer cap, with the note "The cost rate is yours alone and never appears on a client page". **Project > SOP tab**: edit this client's steps (the same task edit controls), and "Save as template" with a confirm showing `diffSummary` and the sentence "This changes the template for every future project, not the ones running." **Change orders panel**: list with status chips, "New change order" form (title, what is changing, why it is outside scope, hours, rate, price override, schedule impact, not-included list, deliverables that become tasks), a "Send for approval" button that links to the approval inbox, void, the signed record (name, time, hash prefix), a client link copy for sent orders, and "Mark paid (outside Stripe)" behind a confirm that says it must be pressed only after the money is in the account.

- [ ] **Step 1: Write the failing tests.** `templateProblems names a requires cycle in plain words`, `stepRows groups by phase in order`, `totalEstimate sums minutes`, `diffSummary counts added, removed and changed`, `statusLabel for signed unpaid and signed paid`, `pricePreview marks a custom price`, `careRateHint is null without a care rate`.
- [ ] **Step 2: Run to verify failure.** Run: `npx vitest run test/sop-view.test.ts test/change-order-view.test.ts`. Expected: FAIL.
- [ ] **Step 3: Implement** the helpers, the two settings pages, the panel and the Project page wiring.
- [ ] **Step 4: Run all and build.** Run: `npm test && npm run typecheck && npm run build`. Expected: PASS.
- [ ] **Step 5: Commit** — `git add -A && git commit -m "feat(projects): SOP editor, work settings, change-order panel"`

---

### Task 12: Daily sweep, recurring tasks, Today and the Friday "done / next"

**Files:**
- Create: `src/worker/sop/cadence.ts`, `src/worker/projects/sweep.ts`, `src/worker/projects/progress.ts`
- Modify: `src/worker/schedule.ts` (a `part("project sweep", ...)` in the daily branch, after the onboarding sweep), `src/worker/today.ts` (`TODAY_KINDS` gains `"project_attention"`; one candidate pass), `src/client/todayView.ts`, `src/worker/onboarding/mail.ts` (`renderFriday` ctx gains `done: string[]` and `next: string[]`; remove the `TODO(plan-7)` note), `src/worker/onboarding/sweep.ts` (passes `projectDoneNext` into the Friday mail)
- Test: `test/sop-cadence.test.ts`, `test/projects-sweep.test.ts`, `test/projects-progress.test.ts`, `test/projects-today.test.ts`

**Interfaces:**
- Consumes: Tasks 1–7; `listCadences`, `getTemplate`, `insertTasks`; `renderFriday`; `buildToday`'s `push` pattern.
- Produces (`sop/cadence.ts`, pure): `periodKey(c: Cadence, d: Date, tz: string): string` ("2026-W48" ISO week, "2026-11", "2026-Q4", "2026"); `periodLabel(c: Cadence, key: string): string` ("Week of Nov 23", "November 2026"); `dueOnFor(c: Cadence, cadenceDay: number | null, d: Date, tz: string): string` (the day in that period on `YYYY-MM-DD`, e.g. weekly day 3 gives that week's Wednesday, monthly day 5 the 5th; null day gives the period's last day).
- Produces (`projects/sweep.ts`): `generateRecurring(env, now: Date): Promise<number>` (for every cadence on an `active`, non-test project: one task per `(cadence, period)`, title "`<template name>`: `<period label>`", `isStep = false`, `cadenceKey = templateKey`, `periodKey`, `dueOn`, checklist = the template's steps as `"<title> (<owner label>)"`, owner = `logan` if any step is Logan's, else `claude_drafts` if any is, else `claude`; `UNIQUE(project_id, cadence_key, period_key)` makes a rerun or a second sweep add nothing); `sweepProjects(env, now): Promise<{ recurring: number; dispatched: number; expired: number; stopped: number }>` (generateRecurring, then `dispatchReady`, `expireDue` for change orders, `capStaleTimers`; each part isolated and logged; never mails anything).
- Produces (`projects/progress.ts`): `projectDoneNext(db, businessId, now: Date, tz: string): Promise<{ done: string[]; next: string[] }>` (client-visible only: a task whose `clientSummary` is non-null; `done` = those finished in the last 7 days, newest first, at most 5; `next` = the earliest unfinished ones in the current phase, at most 3; test projects give empty lists).
- Today item `project_attention` (priority 68, between `proposal_follow_up` 65 and `onboarding_attention` 70): one per lead with a real project and the first of: tasks `in_review` ("N Claude steps to review"), a signed change order not yet paid ("Change order signed: waiting for payment"), Logan's ready tasks overdue or due today ("N tasks due"). Test projects never show; done/snooze behave like the other kinds.

- [ ] **Step 1: Write the failing tests.** Cadence: `periodKey at the ISO week boundary around New Year`, `periodKey for quarter and annual`, `dueOnFor weekly day 3 is the Wednesday of that week in the zone`, `dueOnFor monthly day 5`, `a date at 23:30 Sunday Pacific is in that Sunday's week`. Sweep: `a weekly cadence makes one task for this week and a rerun makes none`, `a new week makes a new task`, `a paused, done or test project generates nothing`, `owner of a checklist task follows its steps`, `the sweep dispatches ready Claude steps and expires an old sent change order and stops a stale timer`, `one failing part does not stop the others`, `the sweep sends no mail`. Progress: `done lists only client-visible steps finished in 7 days`, `next lists at most three in the current phase`, `a task with no client summary never appears`, `a test project gives empty lists`. Today/Friday: `an in_review task shows a review item`, `a signed unpaid change order shows`, `overdue Logan task shows and a future one does not`, `a test project shows nothing`, `the Friday email carries the done and next lines and omits both when empty`, `no internal task title ever reaches the Friday email`.
- [ ] **Step 2: Run to verify failure.** Run: `npx vitest run test/sop-cadence.test.ts test/projects-sweep.test.ts test/projects-progress.test.ts test/projects-today.test.ts`. Expected: FAIL.
- [ ] **Step 3: Implement** the three modules, the cron part, the Today pass and the Friday changes; update the comment on `runScheduled` listing what the daily cron does.
- [ ] **Step 4: Run all.** Run: `npm test && npm run typecheck`. Expected: PASS.
- [ ] **Step 5: Commit** — `git add -A && git commit -m "feat(projects): daily sweep, recurring tasks, Today, Friday done/next"`

---

### Task 13: End-to-end flow and the open-items note

**Files:**
- Create: `test/projects-flow.test.ts`, `docs/superpowers/notes/2026-11-plan-7-open-items.md`
- Modify: `README.md` (a short "Projects" section: SOP templates and seeds, ready/gate rules, Claude dispatch, timer, change orders and the Worker config they need)

**Interfaces:**
- Consumes: everything above, plus the fakes `test/onboarding-flow.test.ts` uses (Stripe, mail transport, PDF browser, fixed calendar).

- [ ] **Step 1: Write the flow test.** One test drives the real entry points: a signed Starter + Care proposal is paid through `/hooks/stripe`; assert the onboarding and one BUILD project exist, Care is deferred, the first-phase Claude steps are queued and none from a later phase; complete steps through `/api/tasks/:id/complete`; assert go-live is 409 with the open QA steps named, then finish them and go live succeeds; assert `design_approved` and `site_finished` are recorded once; run a timer on a task, start another (first saved), add a manual entry, read the week grid and the project's profit; finish the last step and assert the project is done and CARE-0 now exists; flag a change order through the MCP `propose_approval` path, approve it, send it (approval, owner-only mail in test, real mail blocked by the legal gate until configured), open and sign it through the public routes, assert its tasks are still locked, mark it paid and assert they unlock once and Claude dispatch resumes; run the daily cron on a fixed Wednesday and assert one weekly CARE-1 task and none on a second run; assert the Friday email carries the done/next lines and no internal task title; replay the Stripe event and assert nothing new starts; a second onboarding silent for 14 days shows the project as waiting on client and dispatches nothing until a client write.
- [ ] **Step 2: Run to verify failure, then pass.** Run: `npx vitest run test/projects-flow.test.ts`. Expected: FAIL first only if an earlier task left a seam open; fix the seam, not the test.
- [ ] **Step 3: Write the open-items note** (same headings as `2026-11-plan-6-open-items.md`): *Needs Logan* — apply the new remote migration before deploying; read every seed SOP step (BUILD, QUICKFIX, CARE-0, CARE-1, CARE-4) as the worker of it; set the cost rate in Settings > Work; start a test project on a test lead, walk a phase, run a timer, draft and send a test change order to yourself and sign it on a phone; confirm the legal review before any real change order; *Decisions for Logan* — milestone steps (`design_approved` on 4.5, `site_finished` on 6.8), the change-order rate and the Care rate, Claude dispatch automatic for real projects only, the 5-job cap, 12-hour timer cap and 30-second drop, Monday week start, skip rules (non-skippable steps never satisfy `requires`), Care starts when the build finishes, no SOP yet for Local SEO or Reviews; *Known gaps*; *Rulings made during the run*.
- [ ] **Step 4: Full verification.** Run: `npm test && npm run typecheck && npm run build`. Expected: all pass, test count above 3561.
- [ ] **Step 5: Commit** — `git add -A && git commit -m "docs(projects): flow test, README, open items"`
