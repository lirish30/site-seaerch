# Agency OS Plan 13: Care monthly reports, the edit-hours ledger and edit requests Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** On the first days of each month the app builds every Care client's report from what it measured last month (uptime, updates, backups, incidents, renewals, edit hours), Claude writes a plain summary and one recommendation, Logan approves it, and the client gets a short email with a link to a report page. The edit-hours ledger and CARE-3 edit requests, which the report needs, come with it.

**Architecture:** One `care_reports` row per client per month holds a frozen `facts` snapshot (our numbers, built by code), Claude's summary and recommendation, and the client's link token. The daily cron makes the row and a `care.report` Claude task for each client whose CARE-4 task of the month exists; Claude's answer is stored and ONE `care.report` approval is proposed; approving it publishes the link and mails a fixed template. Uptime needs a daily rollup table because raw checks are pruned at 35 days (`CHECK_KEEP_DAYS`). The edit ledger sums minutes logged on edit-request tasks per booking-zone month against a per-plan allowance. The client page is a public token route like `/o/<token>`.

**Tech Stack:** Cloudflare Workers + Hono, D1 (migration 0063), zod, React 19 SPA, vitest (Workers pool). No new service, no helper change, no dependency.

**Spec:** `docs/superpowers/specs/2026-11-17-agency-os-design.md` (copy at `~/Project Sites/agency/docs/specs/2026-11-17-agency-os-design.md`) §9.8 ("Monthly report: generated per client from monitoring data, edit time used and work done. Claude drafts it, Logan approves, and it's sent as a client link with a short summary email."), §5 (client pages, tokens, views tracked), §8 (Care: "1 hr edits/mo (no rollover)"; Care Plus "3 hours of edits a month"), §9.13 (every outbound item is an approval; Claude work goes through the queue, never the API), §12 Phase 3. SOP source: `~/Project Sites/agency/research/kb/josh-hall-maintenance-seo.md` §10.4 (CARE-3, edit request: "warn at 80% of allowance; over-limit = quote at discounted hourly rate; no rollover") and §10.5 (CARE-4). Carry-forwards: `docs/superpowers/notes/2026-11-plan-12-open-items.md` (CARE-3 moved here, report reads Plan 11/12 data), `docs/superpowers/notes/2026-11-plan-7-open-items.md` (CARE-4 auto-dispatches a Claude job per Care client monthly: this plan replaces that behavior for step 1.1 with the report builder).

## Scope

Plan 13 of the five Phase 3 plans (see Plan 11). In: the report facts, the uptime rollup, the edit ledger with the 80% warning, CARE-3 (seed and an edit-request action), the `care.report` Claude kind, the `care.report` approval and mail, the public report page, the owner page, MCP read tool, CARE-4 ticking. Out, and where it goes: report videos (HyperFrames on the Mac; Plan 15 or later), GA4 and Search Console highlights (no Google Analytics or Search Console connection exists; the report leaves them out and says nothing about them), a security scan (no vulnerability feed, Plan 12 call 4), the over-limit quote draft (change orders exist; Logan raises one by hand), CARE-4 steps 1.5 and 1.6 (Plan 8 already drafts payment reminders; they stay hand ticks), Local SEO reports (Plan 14).

## Global Constraints

- "Outbound actions only ever create Approvals." (§9.13) The mail to the client is sent only by an approved `care.report` approval. A draft report is never visible at its link.
- "Claude costs $0 extra" (§9.13): Claude's part is a queue task (`registerTaskKind`), never an Anthropic API call. No `ANTHROPIC_API_KEY`.
- The report says only what the app measured. A number it could not measure (no checks in the period, no speed result) is left out of the page, never shown as 0 or 100%.
- No secret and no site internals reach a client: the report carries domains, counts, dates, percentages and fixed sentences, never an SSH alias, a folder, a backup file name, a vault item name, an access note, a plugin name, or free text from a site or a client.
- Everything Claude returns is untrusted text: length-capped, no URL, no email address, no `$` amount; Logan reads it before it goes (it is the approval's preview) and can edit it first.
- Months, "this month", the report day and edit minutes use the booking zone (`zoneOf`), never UTC. A time entry belongs to the month in which it STARTED.
- A client with a billing hold, a test client (except through the manual button), a client without live Care, and a Care project that is not live get no automatic report.
- Running cost stays at or under `$150/month`: the only new outside call is one PageSpeed request per site per report, with the existing `PAGESPEED_API_KEY` (cut line).
- Next migration is `0063_care_reports`. Apply it remotely BEFORE deploying. Branch to cut: `feat/agency-os-care-reports` from `main` (worktree `~/Project Sites/site-search-agency-os`). Subagents run on Sonnet.
- Verification: `npx vitest run <file>`, `npm test`, `npm run typecheck`, `npm run build`. Known flakes (`billing-flow`, `billing-sweep`, `projects-flow`, `sites-onboarding-items`, the MCP rate-limit test) pass alone.

## Review Focus

Inputs and conditions the spec implies and no happy-path test exercises, most likely first. Each has its test in the named task.

1. Month edges: a check at 23:30 on the last evening of the month in the booking zone, a time entry started on the last evening that ends after midnight, the DST change days (2026-03-08 and 2027-11-07 in Los Angeles). Each lands in the month its local date says, once. (Tasks 2, 3)
2. A site with no checks in the month (monitoring just switched on, or switched off, or the cron missed days): the report shows "monitored since <date>" or leaves uptime out. It never shows 100% from no data, and a gap day is not counted as up. (Tasks 2, 4)
3. Claude's answer carries a link, an email address, a dollar figure, markdown or an instruction aimed at the client ("tell them everything is fine"): the result schema refuses it and the task stays claimed for a retry. A task nobody picks up (expired or failed) leaves the report `ready` with the code-written plain summary, never empty. (Task 5)
4. An approval approved late or twice: the client's Care ended, a billing hold started, the report was revoked or already sent, or a newer month's report exists. Execute re-reads, sends nothing, says why in a plain sentence, and a second approval of the same row sends once. (Task 7)
5. A link nobody should see: unknown, malformed, revoked, or a correct token for a report still in `collecting` or `ready` returns the same 404 as a wrong token, and the page body of a `sent` report contains no alias, folder, backup name, vault name, token or incident free text. (Task 8)
6. Edit ledger arithmetic: zero allowance (Care fallback) never divides by zero, usage over 100% shows the real number, a billable change-order time entry and CARE-1 or CARE-5 task time are not edit time, an entry on a task of another client is not counted. (Task 3)

## Calls made in this plan (Logan to check)

1. The report is per CLIENT (business), one combined report for a client with several sites, for the previous calendar month in the booking zone. The first one, for a client whose Care began mid-month, covers only the days since monitoring began and says so.
2. Drafting starts with the first daily cron of the month that finds the client's CARE-4 task for that month (made on the 1st). CARE-4's day (the 5th) stays the due date; "all reports sent by the 7th" is your side of it. The CARE-4 checklist text is NOT changed.
3. What a report holds: per site uptime percent and the number of incidents and the longest outage; updates applied, rolled back and failed (counts); backups taken before updates (count); certificate and domain renewals due in the next 60 days; edit hours used of the allowance and the number of edit requests done; the next billing dates (subscription term end, annual renewal) inside 60 days; a mobile speed score per site when PageSpeed answers. Plugin names, slugs and incident sentences never appear. NEEDS YOUR CALL.
4. Not in the report (nothing measured it): traffic, search clicks and rankings, a security scan. The page does not mention them. They come with a Google Analytics and Search Console connection, not in this phase.
5. Edit allowance per month, one constant: Care 60 minutes, Care Plus 180, Care fallback 60 (a guess: say if it is different), no rollover. The ledger warns at 80%. NEEDS YOUR CALL.
6. Edit time is the minutes logged on an EDIT REQUEST task. An edit request is a task on the client's live Care project, made by one button, whose checklist is copied from a new seeded CARE-3. Time on anything else is not edit time.
7. Over the allowance the client page shows the real figure ("1 h 40 min of 1 h") and the owner views flag it; the app does not quote or bill by itself (a change order or the hourly invoice does, by your hand).
8. Claude writes one summary (at most 600 characters) and one recommendation (at most 300) from the numbers. Your approval shows both and the facts; you can edit either before approving.
9. The mail is a fixed template: a greeting, Claude's summary, the link, a sign-off. It goes from the main mailbox. A test client's report goes to you only, with "[Test] " on the subject.
10. The link is `<CLIENT_LINK_BASE>/m/<token>`, never expires, can be revoked, and counts views. A revoked report stays on record.
11. Uptime: the probe runs every five minutes (288 checks a day). A day counts as covered when it has at least 144 of them (half a day); a thinner day is kept in the rollup but left out of the percent and of the days covered. Percent = ok checks over all checks of the covered days, to one decimal.
12. CARE-4 ticking: 1.1 when the facts are built, 1.2 when you approve, 1.3 when the mail is sent, 1.4 when the billing dates are listed. 1.5 and 1.6 stay yours.
13. Cut line (§12 six-week rule): the PageSpeed score first, then the billing dates (1.4), then CARE-3's button (keeping the ledger and the seed), then the owner page (Task 9; the approval and the link still work).

---

### Task 1: Tables, the task flag and the data module

**Files:**
- Create: `migrations/0063_care_reports.sql`, `src/worker/db/careReports.ts`
- Modify: `src/worker/db/tasks.ts` (`Task`, `NewTask`, row mapping: `editRequest: boolean`), `src/worker/types.ts` (`ACTIVITY_KINDS` + `care_report_sent`), `src/client/activityView.ts` (its label), every fixture that builds a `Task`
- Test: `test/care-reports-db.test.ts`

**Interfaces:**
- Produces (migration): `tasks.edit_request INTEGER NOT NULL DEFAULT 0 CHECK (edit_request IN (0,1))`; `site_uptime_days(site_id TEXT NOT NULL, day TEXT NOT NULL, checks INTEGER NOT NULL, ok_checks INTEGER NOT NULL, PRIMARY KEY (site_id, day))` (`day` is the booking-zone local date `YYYY-MM-DD`); `care_reports(id TEXT PRIMARY KEY, business_id TEXT NOT NULL REFERENCES businesses(id), period TEXT NOT NULL, status TEXT NOT NULL CHECK (status IN ('collecting','ready','sent','revoked','cancelled')), token TEXT NOT NULL UNIQUE, facts TEXT NOT NULL, summary TEXT NOT NULL DEFAULT '', recommendation TEXT NOT NULL DEFAULT '', summary_source TEXT NOT NULL DEFAULT 'none' CHECK (summary_source IN ('none','claude','plain','logan')), claude_task_id TEXT, approval_id TEXT, test INTEGER NOT NULL DEFAULT 0, created_at TEXT NOT NULL, ready_at TEXT, sent_at TEXT, first_viewed_at TEXT, view_count INTEGER NOT NULL DEFAULT 0, revoked_at TEXT, UNIQUE (business_id, period))`.
- Produces (`db/careReports.ts`): `type ReportStatus`, `type SummarySource`; `interface CareReport` (camelCase of the columns, `facts` as `unknown` until Task 4 types it); `getReport(db, id)`, `getReportByToken(db, token)`, `getReportFor(db, businessId, period)`, `listReports(db, o: { period?: string; status?: ReportStatus[] })`; `insertReport(db, o: { businessId; period; token; facts: unknown; test: boolean; now: string }): Promise<{ report: CareReport; created: boolean }>` (idempotent on `(business_id, period)`); `setSummary(db, id, from: ReportStatus[], o: { summary; recommendation; source: SummarySource; now }): Promise<boolean>` (compare-and-set; sets `status = 'ready'` and `ready_at` from `collecting`); `editSummary(db, id, o: { summary; recommendation }): Promise<boolean>` (only while `ready`; sets `summary_source = 'logan'`); `setTaskAndApproval(db, id, patch: { claudeTaskId?: string; approvalId?: string }): Promise<void>`; `markSent(db, id, now): Promise<boolean>` (from `ready` only); `revoke(db, id, now): Promise<boolean>` (from `ready` or `sent`); `cancel(db, id): Promise<boolean>` (from `collecting` or `ready`); `recordView(db, id, now): Promise<void>` (increments, sets `first_viewed_at` once); `upsertUptimeDay(db, siteId, day, checks, okChecks): Promise<void>`; `uptimeDays(db, siteId, fromDay, toDay): Promise<{ day; checks; okChecks }[]>`.

- [ ] **Step 1: Write the failing test.** `insertReport` twice for one `(business, period)` gives `created: true` then `false` and one row; `setSummary` from `collecting` makes it `ready` with `ready_at`, and with a wrong `from` changes nothing; `editSummary` on a `sent` report returns false; `markSent` twice returns true then false; `recordView` three times gives `viewCount` 3 and an unchanged `firstViewedAt`; `revoke` of a `collecting` report returns false; `upsertUptimeDay` twice for one day keeps one row with the latest numbers; the `edit_request` flag round-trips through `insertTasks`/`getTask` and defaults false.
- [ ] **Step 2: Run `npx vitest run test/care-reports-db.test.ts`.** Expected: FAIL (module not found).
- [ ] **Step 3: Write the migration and the module; add the Task field and the activity kind with its label.**
- [ ] **Step 4: Run it, then `npx vitest run test/projects-db.test.ts test/care-updates-db.test.ts`.** Expected: PASS.
- [ ] **Step 5: Commit** `feat(care): report, uptime-day tables and the edit-request flag`.

---

### Task 2: Daily uptime rollup

**Files:**
- Create: `src/worker/monitoring/rollup.ts`
- Modify: `src/worker/monitoring/sweep.ts` (call the rollup before `pruneChecks`; keep the prune at `CHECK_KEEP_DAYS`)
- Test: `test/care-uptime-rollup.test.ts`

**Interfaces:**
- Consumes: `upsertUptimeDay` (Task 1), `site_checks` rows, `zoneOf`.
- Produces: `export const MIN_CHECKS_FOR_A_DAY = 144`; `localDay(iso: string, tz: string): string`; `rollupUptime(env: Pick<Env, "DB">, now: Date): Promise<number>` (recomputes every site's local days from 3 days before `now` through today from the raw checks, idempotent, returns days written; a day is written even when it has too few checks, with its true counts); `uptimeOf(days: { checks; okChecks }[]): { percent: number | null; coveredDays: number; firstDay: string | null }` (only days with `checks >= MIN_CHECKS_FOR_A_DAY` are covered; percent is one decimal of ok over all checks of covered days; `null` when none is covered).

- [ ] **Step 1: Write the failing test.** A check at 2026-11-30T23:30 local (07:30Z next day in Los Angeles) lands in `2026-11-30`; on 2026-03-08 (23 hours) and 2026-11-01 (25 hours) every check lands in its local date once; a day with 288 checks of which 12 failed is 95.8%; a day with 143 checks is written but not covered and one with 144 is; the 23-hour day (2026-03-08) with 276 checks is covered; `uptimeOf([])` is `{ percent: null, coveredDays: 0, firstDay: null }` and never 100; running the rollup twice changes nothing; running it after the prune window moved keeps old `site_uptime_days` rows (they are never pruned by `pruneChecks`).
- [ ] **Step 2: Run `npx vitest run test/care-uptime-rollup.test.ts`.** Expected: FAIL.
- [ ] **Step 3: Implement the three functions and call `rollupUptime` from the monitoring sweep just before the prune.** Group by `localDay` in code, not SQL (the zone has DST).
- [ ] **Step 4: Run it and `npx vitest run test/monitoring-sweep.test.ts`.** Expected: PASS.
- [ ] **Step 5: Commit** `feat(care): daily uptime rollup that outlives the check prune`.

---

### Task 3: The edit-hours ledger

**Files:**
- Create: `src/worker/care/ledger.ts`
- Modify: `src/worker/today.ts` (one row kind), `src/worker/routes/care.ts` (`GET /clients/:id/edit-ledger`)
- Test: `test/care-ledger.test.ts`

**Interfaces:**
- Consumes: `time_entries`, `tasks.edit_request` (Task 1), `getSubscription`/the client's live Care subscription package key (`care`, `care_plus`, `care_fallback`), `zoneOf`, `localDay` (Task 2).
- Produces: `export const EDIT_ALLOWANCE_MINUTES: Record<"care" | "care_plus" | "care_fallback", number> = { care: 60, care_plus: 180, care_fallback: 60 }` (Call 5); `export const WARN_AT = 0.8`; `interface EditLedger { month: string; allowanceMinutes: number; usedMinutes: number; percent: number | null; state: "ok" | "warn" | "over" }`; `editLedger(env: Pick<Env, "DB">, businessId: string, month: string, tz: string): Promise<EditLedger | null>` (null when the client has no live Care plan; `percent` is null when the allowance is 0; `warn` at 80% up to 100%, `over` above 100%; counts only entries of tasks with `edit_request = 1` and `business_id` equal, started in `month` by local date).
- Today: a row "<client> has used <n>% of this month's edit hours" at priority 60 for `warn` and 64 for `over`, only for the current month, one per client; never for a test client.

- [ ] **Step 1: Write the failing test.** 48 of 60 minutes is `warn` at 80%; 47 is `ok`; 61 is `over` and `usedMinutes` is 61; an entry started 2026-11-30 23:50 local that ends 2026-12-01 00:20 counts in November; allowance 0 gives `percent: null` and no throw; a billable entry on a change-order task, an entry on a CARE-1 task and an entry on another client's edit task are not counted; no live Care plan gives null; the Today row appears once at 60, becomes 64 over, and a test client has none.
- [ ] **Step 2: Run `npx vitest run test/care-ledger.test.ts`.** Expected: FAIL.
- [ ] **Step 3: Implement `editLedger`, the constants, the route and the Today row.**
- [ ] **Step 4: Run it and `npx vitest run test/today-care.test.ts`.** Expected: PASS.
- [ ] **Step 5: Commit** `feat(care): the edit-hours ledger with an 80% warning`.

---

### Task 4: The report facts

**Files:**
- Create: `src/worker/care/reportFacts.ts`
- Test: `test/care-report-facts.test.ts`

**Interfaces:**
- Consumes: `uptimeDays`/`uptimeOf` (Tasks 1, 2), `editLedger` (Task 3), `care_runs`/`care_updates`/`site_incidents` (Plans 11, 12), `Site.domainExpiresOn`/`certExpiresOn`, the client's subscriptions (term end, annual renewal), `runPageSpeed` (`src/worker/pagespeed.ts`).
- Produces: `export const ReportFacts` (zod) and `type ReportFacts = { version: 1; period: string; label: string; from: string; to: string; clientName: string; sites: SiteFacts[]; edits: (EditLedger & { requestsDone: number }) | null; renewals: { what: "domain" | "certificate" | "subscription_term" | "annual_renewal"; domain: string | null; on: string }[]; generatedAt: string }` where `SiteFacts = { domain: string; monitoredSince: string | null; uptimePercent: number | null; coveredDays: number; incidents: number; longestOutageMinutes: number | null; updatesApplied: number; updatesRolledBack: number; updatesFailed: number; backups: number; speedScore: number | null }`; `buildFacts(env: Env, businessId: string, period: string, now: Date, o?: { speed?: boolean }): Promise<ReportFacts>` (period is the MONTH REPORTED, `YYYY-MM`; sites are the client's live, real, monitored sites; `renewals` are those within 60 days after `now`, soonest first, at most 10; speed is requested only when `o.speed !== false` and fails to `null` on any error or a missing key); `plainSummary(f: ReportFacts): string` (a fixed-sentence summary written by code from the numbers, at most 600 characters, no site text); `monthRange(period: string, tz: string): { from: string; to: string; fromDay: string; toDay: string }`.
- Counting rules: `requestsDone` = edit-request tasks of the client marked done in the month (by local `done_at`); an update counts in the month of its run's `finished_at` (local); `applied` = `care_updates.status = 'applied'` for rows whose run finished in the month; `rolledBack` and `failed` the same by status; `backups` = runs of the month with a `backup_file`; `incidents` = `down` incidents opened in the month; `longestOutageMinutes` = the longest `opened_at`→`closed_at` of those (open ones run to the month end).

- [ ] **Step 1: Write the failing test.** Two sites of one client give two `SiteFacts` and one `ReportFacts`; a site with no uptime days has `uptimePercent: null` and the plain summary does not mention uptime for it; a client that began Care on the 20th has `monitoredSince` that day and `coveredDays` 11; updates of a run finished 2026-11-30 23:40 local count in November, one finished 2026-12-01 00:10 in December; a rolled-back run counts under `updatesRolledBack` and the incident sentence never appears anywhere in the JSON (assert the serialized facts contain none of `alias`, `wp_path`, `siteline-backups`, a slug or a vault name); a certificate expiring in 59 days is in `renewals`, in 61 days is not; PageSpeed throwing gives `speedScore: null`; an edit-request task marked done on 2026-11-30 local gives `requestsDone: 1`; `ReportFacts.parse(buildFacts(...))` succeeds; `plainSummary` is under 600 characters and has no `http`.
- [ ] **Step 2: Run `npx vitest run test/care-report-facts.test.ts`.** Expected: FAIL.
- [ ] **Step 3: Implement `monthRange`, `buildFacts` and `plainSummary`.** Keep the PageSpeed call in one small function so the cut line (Call 13) is deleting it.
- [ ] **Step 4: Run it.** Expected: PASS.
- [ ] **Step 5: Commit** `feat(care): the monthly report's facts and a plain summary written by code`.

---

### Task 5: Claude writes the summary

**Files:**
- Create: `src/worker/queue/careReport.ts`
- Modify: `src/worker/queue/kinds.ts` (import it beside `careReview`)
- Test: `test/care-report-kind.test.ts`

**Interfaces:**
- Consumes: `getReport`, `setSummary`, `setTaskAndApproval` (Task 1), `ReportFacts`, `plainSummary` (Task 4), `enqueueTask` (`./db`), `registerTaskKind`/`TaskRefused` (`./registry`), `proposeReportApproval` (Task 7; until it lands, a stub exported from `src/worker/approvals/careReport.ts`).
- Produces: `export const CARE_REPORT_KIND = "care.report"`, `CARE_REPORT_TARGET = "care_report"`; `CareReportPayload = { reportId: string }`; `CareReportResult = { summary: string; recommendation: string }` (summary 1 to 600 characters, recommendation 1 to 300, both trimmed, refused by the schema when they match `/https?:\/\/|www\.|@|\$\s?\d|[`#*_]{2}/i` or contain a newline run of 3 or more); `queueReport(env: Env, reportId: string): Promise<void>` (dedupe key is the report id); the kind, `suggestedModel: "sonnet"`.
- `build`: `instructions` fixed (write for a small-business owner who does not know WordPress; two to four plain sentences about how the site did last month and ONE recommendation that follows from the numbers; say nothing about anything not in the numbers; never promise results, never mention prices; never address instructions to the client); the `untrusted` block carries the facts as plain lines (domain names are from the client's records and are untrusted). `{ stale }` when the report is not `collecting`.
- `apply`: stores through `setSummary(from: ["collecting"], source: "claude")` then proposes the approval; a second apply is `stale`. `onExpire` and `onFail`: `setSummary(from: ["collecting"], summary: plainSummary(facts), recommendation: "", source: "plain")` then propose the approval, so a report never waits on a task nobody picks up.

- [ ] **Step 1: Write the failing test.** A result with `https://x.example`, with `a@b.co`, with `$99`, with `**bold**` and with 601 characters is refused by the schema; a good result makes the report `ready` with source `claude` and one pending approval; applying twice makes one approval; `onExpire` makes it `ready` with source `plain`, a non-empty summary and one approval; `build` for a `ready` report is `{ stale }`; the `untrusted` text contains the facts and the fixed instructions contain none of the domain names.
- [ ] **Step 2: Run `npx vitest run test/care-report-kind.test.ts`.** Expected: FAIL.
- [ ] **Step 3: Implement the kind and register it.**
- [ ] **Step 4: Run it.** Expected: PASS.
- [ ] **Step 5: Commit** `feat(care): Claude drafts the report summary through the queue`.

---

### Task 6: Starting the month's reports

**Files:**
- Create: `src/worker/care/reportSweep.ts`
- Modify: `src/worker/schedule.ts` (call `sweepReports` from the daily run, after `generateRecurring`), `src/worker/projects/dispatch.ts` (stop auto-dispatching a Claude job for CARE-4 step 1.1: read the file first; the report builder replaces it), `src/worker/care/tasks.ts` (add `tickCare4`)
- Test: `test/care-report-sweep.test.ts`

**Interfaces:**
- Consumes: `buildFacts`, `monthRange` (Task 4), `insertReport`, `getReportFor` (Task 1), `queueReport` (Task 5), `newClientToken` (`../documents/token`), `generateRecurring`'s CARE-4 task (`cadence_key = 'CARE-4'`, `period_key` = the current month), `isOnHold`, `projectIsLive`.
- Produces: `sweepReports(env: Env, now: Date): Promise<{ started: number; skipped: number }>` (for each live, real Care client with a CARE-4 task whose period is the current month, no billing hold, and no report for the previous month yet: build the facts, `insertReport`, `queueReport`, `tickCare4(…, ["1.1","1.4"])`; one failing client is logged and does not stop the rest; at most 50 clients per run); `startReport(env: Env, businessId: string, o: { test: boolean; now: Date }): Promise<{ report: CareReport; created: boolean }>` (the manual path: any client with a live Care project, test clients included, for the PREVIOUS month; `created: false` returns the existing row); `previousMonth(now: Date, tz: string): string` (`YYYY-MM`, the format `periodKey("monthly", …)` returns); `tickCare4(env, businessId, period, steps: ("1.1"|"1.2"|"1.3"|"1.4")[], now): Promise<boolean>` (same alignment rules as `tickCare1`: only a task whose checklist lines up with the template; never un-ticks; errors logged and swallowed).
- Route: `POST /api/clients/:id/care-report` (owner session) calls `startReport` with `test` = the client's test flag; answers `{ report: { id, status, period } }`.

- [ ] **Step 1: Write the failing test.** On 2026-12-02 a live Care client with a CARE-4 task for `2026-12` gets one report for `2026-11` and one `care.report` task, and its 1.1 and 1.4 are ticked; a second sweep makes nothing; a client on billing hold, a test client, a client whose Care project is cancelled and one with no CARE-4 task get nothing; one client whose facts throw does not stop the next; `startReport` for a test client makes a report flagged `test`; `previousMonth(2026-01-03, LA)` is `2025-12`; the CARE-4 step 1.1 no longer queues its own Claude job (assert `claude_tasks` holds only the `care.report` one).
- [ ] **Step 2: Run `npx vitest run test/care-report-sweep.test.ts`.** Expected: FAIL.
- [ ] **Step 3: Implement the sweep, `startReport`, `tickCare4` and the route; change the dispatch.**
- [ ] **Step 4: Run it, then `npx vitest run test/projects-sweep.test.ts test/projects-flow.test.ts test/billing-flow.test.ts`.** Expected: PASS (`billing-flow` reads CARE-4 task periods; it may flake alone-passing).
- [ ] **Step 5: Commit** `feat(care): start each Care client's monthly report and stop the old CARE-4 dispatch`.

---

### Task 7: The `care.report` approval and the mail

**Files:**
- Create: `src/worker/approvals/careReport.ts`, `src/worker/care/reportMail.ts`
- Modify: `src/worker/index.ts` (`import "./approvals/careReport"` beside the other approval imports), `src/worker/mcp` list of kinds only the app proposes (find `care.updates` there and add `care.report`)
- Test: `test/care-report-approval.test.ts`

**Interfaces:**
- Consumes: `registerHandler` (`./registry`), `sendEmail` (`../mail/send`), `mainMailboxProblem`, `invoiceRecipient`, `signOff`, `checkConflict` (as `approvals/termNotice.ts` uses them), `markSent`, `getReport`, `tickCare4`, `reportLink`.
- Produces: `reportLink(base: string | undefined, token: string): string | null` (`<base>/m/<token>` through `guestLinkBase`, null when the base is not https or is workers.dev); `proposeReportApproval(env: Env, report: CareReport): Promise<string | null>` (one pending `care.report` approval per report, payload `{ reportId }`, preview text = the summary, the recommendation, the link and the headline numbers; returns the approval id, or the existing one); `renderReportMail(o: { clientName; contactName; yourName; summary; link: string; period: string }): { subject: string; body: string }` (fixed template: "Your site's report for <Month Year>", greeting, the summary, the link, sign-off; no figures of its own).
- Handler `care.report`, label "Send monthly report": everything is re-read at approval; refuses with a plain sentence (nothing sent, no throw) when the report is not `ready`, is `revoked` or `cancelled`, the client has no live Care project, is on billing hold, or the link base is unusable; throws (so the approval stays pending) when the mailbox cannot send, the contact has no email, or `checkConflict` blocks (except source `client`); sends with the approval id as the once-only key and `skipLimits: true`, a test report to the owner only with "[Test] " on the subject; then `markSent`, logs `care_report_sent` once, and ticks CARE-4 1.2 and 1.3. A retry after the mail went but before `markSent` marks sent and sends nothing (look the message up by approval id as `termNotice.ts` does).

- [ ] **Step 1: Write the failing test.** Approving a `ready` report sends one mail whose body contains the summary and `/m/<token>`, marks it `sent`, logs once and ticks 1.2 and 1.3; approving the same approval twice sends once; a revoked report, a cancelled one, a client on hold and a client whose Care project ended each send nothing and report the reason; a mailbox error leaves the approval pending and the report `ready`; a test report mails the owner with "[Test] "; `proposeReportApproval` twice gives one approval and the preview holds the summary and the link; the mail body contains no `siteline-backups`, alias or token other than the one link; an agent (MCP) cannot propose `care.report`.
- [ ] **Step 2: Run `npx vitest run test/care-report-approval.test.ts`.** Expected: FAIL.
- [ ] **Step 3: Implement the handler, the mail and `proposeReportApproval`; remove Task 5's stub.**
- [ ] **Step 4: Run it and `npx vitest run test/care-report-kind.test.ts`.** Expected: PASS.
- [ ] **Step 5: Commit** `feat(care): approve and mail the monthly report`.

---

### Task 8: The client's report page

**Files:**
- Create: `src/worker/care/reportPublic.ts`, `src/client/pages/CareReportPage.tsx`, `src/client/careReportPageView.ts`
- Modify: `src/worker/routes/public.ts` (`GET /m/:token`, behind `clientLimited`), `src/client/App.tsx` (`<Route path="/m/*" …>` beside `/o/*`), `src/client/public.css` if the page needs a rule
- Test: `test/care-report-public.test.ts`, `test/care-report-page-view.test.ts`

**Interfaces:**
- Consumes: `getReportByToken`, `recordView` (Task 1), `ReportFacts` (Task 4), `isClientToken`.
- Produces: `publicReport(env: Env, token: string, now: Date): Promise<PublicReport | null>` where `PublicReport = { clientName: string; label: string; summary: string; recommendation: string; sites: { domain; uptimePercent: number | null; coveredDays: number; monitoredSince: string | null; incidents: number; longestOutageMinutes: number | null; updatesApplied: number; updatesRolledBack: number; backups: number; speedScore: number | null }[]; edits: { usedMinutes; allowanceMinutes; state; requestsDone } | null; renewals: { what; domain; on }[]; sentOn: string }`. Null for a malformed token, an unknown one, a revoked one and any report not `sent` (one indistinguishable 404). Records a view only on a `sent` report. Nothing else is returned: no ids, no alias, no backup name, no `facts` raw blob, no approval or task id.
- `careReportPageView.ts` (pure, tested without a DOM): `hours(minutes: number): string` ("1 h 40 min", "45 min", "0 min"), `uptimeLine(site): string | null` (null leaves the line out; "99.9% uptime over 29 days" or "monitored since 14 Nov"), `editsLine(edits): string | null` (over the allowance reads the real figure, never "100%").
- The page: a calm summary-first layout (the summary and recommendation at the top, then a card per site, then edit hours, then "coming up"), readable at phone width, no login, a `noindex` meta tag, no script beyond the app's own. A site with `uptimePercent: null` shows no uptime line at all.

- [ ] **Step 1: Write the failing tests.** Worker: a `sent` report returns the shape above and counts a view; `ready`, `collecting`, `revoked`, unknown and a 42-character token all return null and record nothing; the JSON of a `sent` page contains none of `alias`, `wp_path`, `siteline-backups`, `token`, `approval`, a plugin slug seeded into the facts' run, or the incident sentence; the route sets `cache-control: no-store` and `x-robots-tag: noindex`. View: `hours(100)` is "1 h 40 min", `hours(60)` "1 h", `hours(0)` "0 min"; `editsLine` for 100 of 60 minutes reads "1 h 40 min of 1 h"; `uptimeLine` for `null` percent with a `monitoredSince` reads "monitored since …" and with neither is null.
- [ ] **Step 2: Run both files.** Expected: FAIL.
- [ ] **Step 3: Implement the public function, the route, the view helpers, the page and the route in `App.tsx`.**
- [ ] **Step 4: Run both, then `npm run typecheck`.** Expected: PASS.
- [ ] **Step 5: Commit** `feat(care): the client's monthly report page`.

---

### Task 9: Your side: the reports page, edit requests, the Care panel and MCP

**Files:**
- Create: `src/worker/care/editRequest.ts`, `src/worker/mcp/tools/careReport.ts`, `src/client/careReportsView.ts`, `src/client/pages/CareReports.tsx`
- Modify: `src/worker/sop/seeds.ts` (add `CARE_3` to `SEED_SOPS`: key `CARE-3`, name "Care edit request", kind `project`, never started as a project, the five steps of research §10.4 with the owners shown there), `src/worker/routes/care.ts` (`GET /care/reports?period=`, `PUT /care/reports/:id`, `POST /care/reports/:id/revoke`, `POST /clients/:id/edit-requests`), `src/client/App.tsx` and the nav (`/care/reports`), the client page's Care panel (`src/client/pages` Care panel component: the ledger bar and "Last report" block), `src/worker/mcp/server.ts` or its tool registry (register the new tool)
- Test: `test/care-reports-routes.test.ts`, `test/care-edit-request.test.ts`, `test/mcp-care-report.test.ts`, `test/care-reports-view.test.ts`

**Interfaces:**
- Consumes: Tasks 1, 3, 6, 7; `getTemplate`/`SEED_SOPS` (as `care/incidents.ts` copies CARE-5), the Care project and `insertTasks`.
- Produces: `createEditRequest(env: Env, businessId: string, o: { title: string; now: Date }): Promise<{ taskId: string } | { refused: string }>` (a task on the client's live Care project, `isStep: false`, `editRequest: true`, `cadenceKey: null`, checklist copied from CARE-3 (`<step title> (<owner label>)`, as `recurringTask` writes it), title cleaned to 120 characters; refuses with a plain sentence when the client has no live Care project, is on hold, or the title is empty); `GET /care/reports` answers `{ period, reports: { id, client, status, summary, recommendation, source, sentOn, views, link: string | null, ledger: EditLedger | null }[] }` (`link` only for `ready`, `sent`; owner session only); `PUT /care/reports/:id` edits summary and recommendation while `ready` (same schema limits as Task 5's result, refused with a sentence otherwise); revoke is `ready` or `sent` only; MCP `get_care_report` (read-only, 29 tools): per client for a period, status, headline numbers and the ledger, never a token, link, summary text of a draft is allowed, alias or backup.
- The reports page lists the month's reports with their status chips, an editable summary box for `ready`, the link to copy, "Revoke", and a "Build now" button per client (calls `POST /api/clients/:id/care-report`). The Care panel shows the ledger bar (green, amber at 80%, red over) with "Add an edit request".

- [ ] **Step 1: Write the failing tests.** Edit request: makes one task flagged `editRequest` with the five-step checklist copied from CARE-3 on the live Care project; refuses with no Care, on hold, and with an empty title; two requests make two tasks. Routes: `PUT` refuses a `sent` report and a summary with a URL; revoke of `ready` and `sent` works and of `collecting` is refused; the list leaves out a token and gives `link: null` for `collecting`; all routes need the owner session. MCP: the answer contains no token, link, alias or backup file name, and the tool count is 29. View helpers: the chip text per status; the ledger bar's state per percent (`null` percent shows "no allowance").
- [ ] **Step 2: Run the four files.** Expected: FAIL.
- [ ] **Step 3: Implement.** The CARE-3 seed must keep `SEED_SOPS` valid for `test/sop-seeds.test.ts` and `test/sops-routes.test.ts` (update their expected key lists).
- [ ] **Step 4: Run the four files, `npx vitest run test/sop-seeds.test.ts test/sops-routes.test.ts`, then `npm run typecheck`.** Expected: PASS.
- [ ] **Step 5: Commit** `feat(care): reports page, edit requests, the ledger on the Care panel and an MCP read tool`.

---

### Task 10: The whole month, end to end, and the notes

**Files:**
- Create: `test/care-reports-flow.test.ts`, `docs/superpowers/notes/2026-11-plan-13-open-items.md`
- Modify: `README.md` only if it lists the Worker's routes or crons
- Test: `test/care-reports-flow.test.ts`

**Interfaces:**
- Consumes: the real entry points on a fixed calendar (Los Angeles, Wednesday 2 December 2026, 09:00): the daily cron, the owner's routes under `/api`, the queue's real completion (`completeTask`), the real approval path, the public route, and the MCP route. The only fakes are PageSpeed and the mail transport.

- [ ] **Step 1: Write the flow test.** Story: three clients. A has two monitored sites with a month of November checks (one site down for 3 hours on the 14th), one rolled-back update run, two clean runs, 75 minutes logged on an edit request, and a certificate 40 days out. B has one site that began monitoring on 20 November and 30 minutes of edit time. C has Care Plus with no checks at all. A fourth client is on billing hold and a fifth is a test client. The 2 December cron makes exactly three reports (A, B, C) and three `care.report` tasks, ticks 1.1 and 1.4, and none for the held or test client. Completing A's task with a good result and C's with a URL (refused, then retried good) and leaving B's to expire gives three `ready` reports and three approvals (B's with source `plain`). The Today feed shows A at 125% over (Care allowance 60) as `over` and B at 50% with no row. Approving A's report sends one mail, `sent`, 1.2 and 1.3 ticked; the public page for A's token returns the figures (uptime under 100, 1 incident with a 180-minute longest outage, 1 rolled back, 2 applied, 75 of 60 minutes and 1 edit request done) and records a view; the page for B's still-`ready` token is a 404; approving A's approval a second time sends nothing; revoking A's report makes its page a 404; the manual "Build now" for the test client makes a `test` report that mails the owner only. At the end no `/api` body, MCP answer, public page or mail body contains an alias, a folder, a backup file name, a vault name, an access note or a token other than the client's own link in the mail, and no error was logged.
- [ ] **Step 2: Run `npx vitest run test/care-reports-flow.test.ts`.** Expected: FAIL until everything above is wired; fix defects in the owning task's files, each with its own unit test (the Plan 12 flow found two this way).
- [ ] **Step 3: Run `npm test`, `npm run typecheck`, `npm run build`.** Expected: only the known flakes, each passing alone.
- [ ] **Step 4: Write the notes file** in the shape of `2026-11-plan-12-open-items.md`: what was built; Needs Logan (apply 0063 before deploying, deploy, view `/care/reports`, a client report at phone width and the real mail, rehearse with the test client's "Build now", check the CARE-4 task ticks, set the real allowance numbers); the calls above with your answers; rulings made while building; known gaps; rollback (the old Worker ignores the new tables and column).
- [ ] **Step 5: Commit** `test(care): the monthly report flow; docs: Plan 13 open items`.
