# Agency OS Plan 11: Care monitoring, incidents and client health Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** The app watches every Care client's live site, opens an incident when a site is down or its domain is about to expire, shows both on Today, and gives each client a health score and a Care fleet page.

**Architecture:** The 5-minute cron probes each monitored site over HTTP from the Worker; the daily cron reads domain expiry from public RDAP and prunes old checks. A pure incident engine turns probe results into at most one open incident per site and kind (two failures in a row open one, one success closes it). Health is one pure function over facts the app already holds plus the new checks. Everything reaches the owner through Today, the client page, a `/care` fleet board and two read-only MCP tools. Nothing is sent to anyone and no task is created.

**Tech Stack:** Cloudflare Workers + Hono, D1 (migration 0061), zod, `@modelcontextprotocol/sdk`, React 19 SPA, vitest (Workers pool). No new dependency and no paid service.

**Spec:** `docs/superpowers/specs/2026-11-17-agency-os-design.md` (copy at `~/Project Sites/agency/docs/specs/2026-11-17-agency-os-design.md`) §9.8 (Care fleet: "uptime checks from Cloudflare cron"), §7 (Site: "monitoring status"; Organization: "health score"), §6 (the client page header shows "Health 82"), §12 Phase 3 ("Care fleet automation … Health, grade, capacity"), §17 ("Health-score formula" is left to the builder). Carry-forwards: `docs/superpowers/notes/2026-11-plan-9-open-items.md` ("health/grade and monitoring status deferred to Phase 3") and `…-plan-10-open-items.md`.

## Scope: what Plan 11 is and what is left of Phase 3

Phase 3 (§12) is too big for one plan, so it is cut into five. This is the first: it needs no Mac helper work and no client-facing mail, and every later plan reads what it makes.

- **Plan 11 (this):** uptime and domain-expiry monitoring, incidents, health score, Care fleet board.
- Plan 12: Care updates: weekly update batch over WP-CLI through the Mac helper, Playwright before/after diffs, CARE-2/3/5/6/7 SOPs, incident tasks.
- Plan 13: monthly Care reports (this is where CARE-4 becomes real; it stays as seeded until then) and report videos.
- Plan 14: Local SEO delivery (SEO-0…3).
- Plan 15: Studio social images, post-launch ladder (REVIEWS, OFFBOARD/GROW), batch views, auto-approve rules, client grade (A/B/C) and capacity.

## Global Constraints

- "uptime checks from Cloudflare cron (UptimeRobot free tier as backup)" (§9.8). Probes run from the Worker's cron. The backup is a manual setup and not built.
- "Outbound actions only ever create Approvals." (§9.13) Monitoring sends nothing to anyone: no mail, no webhook, no client-visible page, no queued Claude task.
- Running cost stays at or under `$150/month`; this plan adds no paid service (RDAP is free) and no dependency.
- Test clients, test sites, archived sites and sites with no URL are never probed and never shown. Reuse `testClientSql` / `clientSql` (`src/worker/clients/record.ts`) and `sites.test`.
- Nothing remote is stored except a status code and one of the fixed phrases in `ERROR_TEXT` (Task 2). A response body, header or error message from a client's site never reaches the database, Today, an MCP result or a log line.
- No secret is stored or shown: this plan touches no vault name or access note.
- Dates and days-left are counted on calendar dates in the booking zone (`zoneOf(settings)`, `dayKey`), never UTC.
- Next migration is `0061_monitoring`. Apply the remote migration before deploying the Worker.
- Branch to cut: `feat/agency-os-care-monitoring` from `main` (worktree `~/Project Sites/site-search-agency-os`). Subagents run on Sonnet.
- Verification commands: `npx vitest run <file>`, `npm test`, `npm run test:helper`, `npm run typecheck`, `npm run build`. Known timing flakes (`billing-flow`, `billing-sweep`, `projects-flow`) pass alone.

## Review Focus

Inputs and conditions the spec implies and no happy-path test would exercise, most likely first. Each has its test in the task named at the end of the line.

1. A site URL that points at the Worker's own network or anything internal (`http://localhost`, `http://10.0.0.5`, `http://[::1]`, `http://169.254.169.254`, `file:`, `ftp:`, a name ending `.internal` or `.local`): it is never fetched, and the site shows "can't be monitored" instead of "up". (Task 2)
2. A single failed check (a 502 during the client's own deploy) must not open an incident; two in a row do; a site that keeps failing opens exactly one; a site that flaps (fail, fail, ok, fail, fail) opens, closes, then opens a second one. (Task 3)
3. One hanging or slow site must not stop the others or fail the cron: each probe has a 10 s timeout, a tick probes at most 40 sites, and a probe that throws counts as a failed check. (Task 4)
4. A client with no Care subscription, a test client, an archived site, a site with no URL and a Care subscription that has ended are never probed and never on Today, the Care board or MCP. A Care client with a site that has no checks yet is not "at risk": no checks means unknown, never 0% and never 100%. (Tasks 4, 5)
5. Health on an empty client (no checks, no invoices, no access items) is a finite number, not NaN, and the Care board, the client record and the MCP overview give the same score for the same client. (Task 5, Task 7)

## Calls made in this plan (Logan to check)

1. Plan 11 is monitoring, incidents and health only; the rest of Phase 3 is Plans 12 to 15 (above).
2. A probe is one GET of the site's URL from the Worker, following redirects. **Down** means: a network error, a timeout (10 s), a 5xx, a 404 or a 410. A 401 or 403 counts as **up** (the server answered; a firewall that blocks the Worker would otherwise page you all night). A response slower than 5 s is up and is only shown as slow.
3. **Two checks in a row** (5 to 10 minutes) open a down incident; **one good check** closes it.
4. The Worker cannot read a TLS certificate's expiry, so certificate expiry is not monitored here: an expired certificate shows as down (the connection fails). Reading expiry properly is a Mac helper job and goes in Plan 12.
5. Domain expiry is read weekly from public RDAP (`https://rdap.org/domain/<domain>`). Within 30 days of expiry opens a `domain_expiring` incident; a domain RDAP does not know or cannot answer for gives no incident, only "unknown".
6. A site is **monitored** when it is real, live, has a URL, and its client has a live Care subscription (the same rule `careLabel` uses) or you switched monitoring on for that site. A client without Care is never probed unless you switch it on.
7. There is no push or email alert for a down site: Today, the client page, the Care board and MCP only. Mailing yourself unattended would be the app's first unattended send, so it is not built. Say so if a morning look is too slow for a down site.
8. Health is 0 to 100 from the deductions in Task 5 (down 30, domain 10 to 20, uptime 10 to 20, overdue invoice 15, billing hold 25, past-due subscription 15, access missing 10, waiting on client 10), bands good 80 or more, watch 60 to 79, at risk under 60. These numbers are a first guess; the formula is one small function.
9. An incident is a record, not a task: no task is created. The "incident task" of CARE-5 comes with the update batch in Plan 12.
10. Client grade (A/B/C) and capacity are deferred to Plan 15: their cutoffs are your calls and nothing here needs them.
11. Cut line (§12 six-week rule): drop Task 9 (the pages) first, keeping the routes and the MCP tools; then Task 8.

---

### Task 1: Monitoring tables and data module

**Files:**
- Create: `migrations/0061_monitoring.sql`, `src/worker/db/monitoring.ts`
- Modify: `src/worker/db/sites.ts` (the `Site` type, its row mapper and the column lists), `src/worker/types.ts` (`ACTIVITY_KINDS`: add `"site_down"`, `"site_back"`, `"domain_expiring"`), `src/client/activityView.ts` (labels for the three kinds; run `grep -rn "site_changed" src/client` to find every map that lists activity kinds)
- Test: `test/monitoring-db.test.ts`

**Interfaces:**
- Produces (`sites`): three columns `monitoring INTEGER NOT NULL DEFAULT 0 CHECK (monitoring IN (0, 1))`, `domain_expires_on TEXT` (a `YYYY-MM-DD` date), `domain_checked_at TEXT`; `Site` gains `monitoring: boolean; domainExpiresOn: string | null; domainCheckedAt: string | null`. Every place that builds a `Site` (including `test/fixtures`) fills them.
- Produces (tables): `site_checks(id TEXT PRIMARY KEY, site_id TEXT NOT NULL REFERENCES sites(id), checked_at TEXT NOT NULL, ok INTEGER NOT NULL CHECK (ok IN (0, 1)), status INTEGER, ms INTEGER, error TEXT)` with an index on `(site_id, checked_at)`; `site_incidents(id TEXT PRIMARY KEY, site_id TEXT NOT NULL REFERENCES sites(id), business_id TEXT NOT NULL REFERENCES businesses(id), kind TEXT NOT NULL CHECK (kind IN ('down', 'domain_expiring')), opened_at TEXT NOT NULL, closed_at TEXT, detail TEXT NOT NULL)` with `CREATE UNIQUE INDEX uq_site_incident_open ON site_incidents(site_id, kind) WHERE closed_at IS NULL`. Times are UTC ISO strings with milliseconds, as everywhere. No `ON DELETE CASCADE`, like `sites`.
- Produces (`db/monitoring.ts`): `type IncidentKind = "down" | "domain_expiring"`; `interface SiteCheck { id; siteId; checkedAt; ok: boolean; status: number | null; ms: number | null; error: string | null }`; `interface Incident { id; siteId; businessId; kind: IncidentKind; openedAt; closedAt: string | null; detail: string }`;
  `insertCheck(db, c: Omit<SiteCheck, "id">): Promise<void>`; `recentChecks(db, siteId, limit: number): Promise<SiteCheck[]>` (newest first); `uptimePercent(db, siteId, sinceIso: string): Promise<{ percent: number | null; checks: number }>` (percent of ok checks to one decimal; `null` when there are no checks); `pruneChecks(db, beforeIso: string): Promise<number>`;
  `openIncident(db, i: { siteId; businessId; kind: IncidentKind; detail: string; now: string }): Promise<{ incident: Incident; created: boolean }>` (`created` is false and nothing changes when one is already open for that site and kind); `closeIncident(db, siteId, kind: IncidentKind, now: string): Promise<Incident | null>` (the one it closed, or null); `listIncidents(db, o: { businessId?: string; open?: boolean; limit?: number }): Promise<Incident[]>` (newest first, default limit 50, test clients and test sites left out); `setDomainExpiry(db, siteId, expiresOn: string | null, checkedAt: string): Promise<void>`; `setMonitoring(db, siteId, on: boolean, now: string): Promise<Site | null>`;
  `export const CARE_SUBSCRIPTION_SQL = (a: string): string` (an `EXISTS` over `subscriptions` for the business alias `a`: a live, real Care row, built from the same `CARE_KEYS` and `LIVE` that `careLabel` in `src/worker/clients/record.ts` uses; export those two constants if they are not exported);
  `monitoredSites(db, limit: number): Promise<Site[]>` (real, live, with a URL, and `monitoring = 1` OR `CARE_SUBSCRIPTION_SQL`, never a test client; the sites checked longest ago first, never-checked ones before all; at most `limit`).

- [ ] **Step 1: Write the failing test `test/monitoring-db.test.ts`.** Use `seedClient` and `addSub` (`test/fixtures/clients.ts`). Cases: `openIncident` twice for one site and kind returns `created: true` then `created: false` and leaves one row; after `closeIncident` a new `openIncident` is `created: true`; `uptimePercent` with no checks is `{ percent: null, checks: 0 }` and with 3 ok of 4 is `75`; `pruneChecks` removes only older rows; `monitoredSites` returns the Care client's site and not: a client with no Care row, one whose Care subscription is `cancelled`, a `test` client, an archived site, a site with no URL; and returns a non-Care site once `setMonitoring(…, true)`; a never-checked site comes before one checked a minute ago; `limit` is honoured.
- [ ] **Step 2: Run `npx vitest run test/monitoring-db.test.ts`.** Expected: FAIL (module not found).
- [ ] **Step 3: Write the migration and `db/monitoring.ts`, and add the three fields to `Site`.** Add the three activity kinds and their client labels.
- [ ] **Step 4: Run the test.** Expected: PASS; then `npx vitest run test/sites-db.test.ts test/sites-seed.test.ts test/clients-flow.test.ts` still PASS.
- [ ] **Step 5: Commit** `feat(care): monitoring tables, incidents and the monitored-site rule`.

---

### Task 2: The probe and the domain-expiry reader

**Files:**
- Create: `src/worker/monitoring/probe.ts`, `src/worker/monitoring/rdap.ts`
- Test: `test/monitoring-probe.test.ts`, `test/monitoring-rdap.test.ts`

**Interfaces:**
- Produces (`probe.ts`): `export const PROBE_TIMEOUT_MS = 10_000, SLOW_MS = 5_000`; `export const ERROR_TEXT = { timeout: "timed out after 10 seconds", connect: "could not connect", blocked: "this address can't be monitored" } as const`; `type MonitorableUrl = { ok: true; url: string } | { ok: false; reason: string }`; `monitorableUrl(raw: string | null): MonitorableUrl`; `interface ProbeResult { ok: boolean; status: number | null; ms: number; error: string | null; slow: boolean }`; `probeSite(url: string, fetchFn: typeof fetch, nowMs: () => number): Promise<ProbeResult>`. `error` is `null` when `ok`; otherwise exactly `` `HTTP ${status}` `` or one value of `ERROR_TEXT`. It never contains anything the remote site sent.
- Produces (`rdap.ts`): `parseRdapExpiry(json: unknown): string | null` (the `YYYY-MM-DD` of the event whose `eventAction` is `"expiration"`; anything else, malformed or not an object gives null); `fetchDomainExpiry(domain: string, fetchFn: typeof fetch): Promise<string | null>` (GET `https://rdap.org/domain/<domain>` with `accept: application/rdap+json`, 5 s timeout, null on any failure; the domain is checked first with `/^[a-z0-9.-]+\.[a-z]{2,}$/i` and a bad one is never requested).

- [ ] **Step 1: Write the failing tests.** `monitorableUrl`: `https://acmeplumbing.com/` and `http://acmeplumbing.com` are ok; each of `http://localhost`, `http://127.0.0.1`, `http://10.0.0.5`, `http://192.168.1.1`, `http://172.16.0.1`, `http://169.254.169.254`, `http://[::1]`, `http://printer.local`, `http://db.internal`, `file:///etc/passwd`, `ftp://acmeplumbing.com`, `javascript:alert(1)`, `""` and `null` are `{ ok: false, reason: ERROR_TEXT.blocked }`, and a bare `acmeplumbing.com` is turned into `https://acmeplumbing.com/`. `probeSite` with a fake `fetchFn` (the fake never throws on its own): 200, 301-then-200, 401 and 403 are `ok: true`; 404, 410, 500, 503 are not ok with `error` `HTTP 404` and so on; a fake that rejects with `new TypeError("secret internal host db.corp")` gives `error: ERROR_TEXT.connect` and the rejection text appears nowhere in the result; a fake that never resolves and aborts when its signal fires gives `ERROR_TEXT.timeout` (use `vi.useFakeTimers`); a 200 that took 6 000 ms by the injected clock has `slow: true`, one that took 100 ms `slow: false`. `parseRdapExpiry` on a real-shaped RDAP document returns `2027-03-14`, and on `null`, `[]`, `{}` and an event with a non-date value returns null; `fetchDomainExpiry("not a domain", fetch)` never calls the fake.
- [ ] **Step 2: Run both files.** Expected: FAIL (module not found).
- [ ] **Step 3: Implement `monitorableUrl` (parse with `new URL`, allow only `http:` and `https:`, refuse IP-literal hosts in loopback, private, link-local and unique-local ranges and the hosts above), `probeSite` (one `fetchFn(url, { signal: AbortSignal.timeout(PROBE_TIMEOUT_MS), redirect: "follow", headers: { "user-agent": "SitelineMonitor/1.0" } })`; read no body; down is any throw, a timeout, a 404, a 410 or any status of 500 and above) and the two RDAP functions.**
- [ ] **Step 4: Run both files.** Expected: PASS.
- [ ] **Step 5: Commit** `feat(care): site probe and RDAP expiry reader`.

---

### Task 3: The incident engine

**Files:**
- Create: `src/worker/monitoring/incidents.ts`
- Test: `test/monitoring-incidents.test.ts`

**Interfaces:**
- Consumes: `insertCheck`, `recentChecks`, `openIncident`, `closeIncident`, `setDomainExpiry` (Task 1); `ProbeResult` (Task 2); `logActivity` (`src/worker/db/activity.ts`); `zoneOf` (`src/worker/sop/cadence.ts`), `dayKey` (`src/worker/booking/slots.ts`), `getSettings`.
- Produces: `export const DOWN_AFTER = 2, DOMAIN_WARN_DAYS = 30`; `interface Transition { opened: boolean; closed: boolean }`;
  `recordProbe(env: Env, site: Site, r: ProbeResult, now: Date): Promise<Transition>` (stores the check; if the last `DOWN_AFTER` checks, this one included, all failed, opens a `down` incident with `detail = r.error` and logs one `site_down` activity on the business; if this check is ok, closes the open `down` incident and logs one `site_back` activity whose detail says how long it was down, in whole minutes, e.g. "back after 47 min"; opening twice or closing with nothing open logs nothing);
  `domainDaysLeft(expiresOn: string, now: Date, zone: string): number` (calendar days from today's date in `zone` to `expiresOn`; negative once past);
  `recordDomainExpiry(env: Env, site: Site, expiresOn: string | null, now: Date): Promise<Transition>` (stores the expiry and the check time; `null` stores only the check time and changes no incident; within `DOMAIN_WARN_DAYS` (including already past) opens a `domain_expiring` incident with `detail` like "domain expires in 12 days" or "domain expired 3 days ago" and logs `domain_expiring` once; beyond it, closes an open one).

- [ ] **Step 1: Write the failing test.** One probe failure leaves no incident and no activity; the second failure opens one `down` incident with detail `HTTP 503` and one `site_down` activity; a third and fourth failure change nothing (still one row, one activity); an ok check closes it, sets `closedAt`, logs one `site_back` ("back after 47 min" for a fixed clock); a second ok check changes nothing; fail, fail, ok, fail, fail gives two incidents, the first closed and the second open; fail then ok then fail (never two in a row) opens none; `recordProbe` for a `slow` ok result opens nothing; `domainDaysLeft("2026-12-03", new Date("2026-11-21T07:30:00Z"), "America/Los_Angeles")` is 13 (it is 23:30 on 20 November there; UTC would say 12) and one at `2026-11-21T08:30:00Z` for a date `2026-11-21` is 0 (the zone's midnight, not UTC's); `recordDomainExpiry` with 12 days left opens `domain_expiring` once and a second call opens no second; with 90 days left it closes it; with an already-past date the detail says "expired"; with `null` and an open incident the incident stays open and `domainCheckedAt` is set.
- [ ] **Step 2: Run `npx vitest run test/monitoring-incidents.test.ts`.** Expected: FAIL.
- [ ] **Step 3: Implement the four exports.** Read the last `DOWN_AFTER` checks with `recentChecks` after inserting the new one.
- [ ] **Step 4: Run the test.** Expected: PASS.
- [ ] **Step 5: Commit** `feat(care): incident engine`.

---

### Task 4: The sweeps and the cron

**Files:**
- Create: `src/worker/monitoring/sweep.ts`
- Modify: `src/worker/schedule.ts` (two `part(...)` calls, below), `wrangler.jsonc` is NOT changed (the 5-minute and daily crons already exist)
- Test: `test/monitoring-sweep.test.ts`

**Interfaces:**
- Consumes: `monitoredSites`, `pruneChecks`, `listIncidents` (Task 1); `monitorableUrl`, `probeSite` (Task 2); `recordProbe`, `recordDomainExpiry` (Task 3); `fetchDomainExpiry` (Task 2).
- Produces: `export const MAX_PER_TICK = 40, CONCURRENCY = 5, CHECK_KEEP_DAYS = 35, DOMAIN_RECHECK_DAYS = 7`; `export const monitoringDeps: { fetch: typeof fetch }` (defaults to the global `fetch`; tests replace it and restore it, the way `productionDeps` is used);
  `interface UptimeSweepResult { probed: number; failed: number; skipped: number; opened: number; closed: number }`; `sweepUptime(env: Env, now: Date): Promise<UptimeSweepResult>` (takes `monitoredSites(env.DB, MAX_PER_TICK)`; a site whose URL is not `monitorableUrl` is counted in `skipped` and never fetched; the rest are probed `CONCURRENCY` at a time; a probe that throws is recorded as a failed check with `ERROR_TEXT.connect`; never throws);
  `interface DomainSweepResult { checked: number; opened: number; closed: number; pruned: number }`; `sweepDomains(env: Env, now: Date): Promise<DomainSweepResult>` (for each site of `monitoredSites(env.DB, 500)` with a `domain` whose `domainCheckedAt` is empty or older than `DOMAIN_RECHECK_DAYS`; then `pruneChecks` for checks older than `CHECK_KEEP_DAYS`; never throws).
- `schedule.ts`: in the `REMINDER_CRON` branch add `await part("uptime", async () => { const r = await sweepUptime(env, now); return r.opened || r.closed ? r : undefined; }, true);` after the booking reminders (quiet unless something changed); in the daily list add `await part("domain expiry", () => sweepDomains(env, now));` after the billing sweep; update the doc comment on `runScheduled` and on `REMINDER_CRON` (it no longer only sends booking reminders).

- [ ] **Step 1: Write the failing test.** With `monitoringDeps.fetch` replaced by a recorder: a Care client's site is fetched once per `sweepUptime`; none of these is ever fetched (assert the recorder's call list): a client with no Care, a client whose Care row is `cancelled`, a test client, an archived site, a site with no URL, a site at `http://10.0.0.5` (counted in `skipped`); a non-Care client is fetched once it is switched on; 45 monitored sites give `probed: 40` and the next call probes the 5 not yet checked first; one site whose fake never resolves (fake timers) does not stop the other four and the call still resolves; a fake that throws gives a failed check, not a throw; two ticks of 503 give `opened: 1` on the second; `runScheduled(env, REMINDER_CRON, now)` with no monitored sites resolves and logs nothing; `runScheduled(env, DAILY_CRON, now)` calls `sweepDomains` (a recorded RDAP call for a site not checked in 8 days, none for one checked 2 days ago) and removes a check dated 40 days before `now` and keeps one 10 days old; an RDAP failure leaves the site's expiry and incidents as they were.
- [ ] **Step 2: Run `npx vitest run test/monitoring-sweep.test.ts`.** Expected: FAIL.
- [ ] **Step 3: Implement `sweep.ts` and wire `schedule.ts`.**
- [ ] **Step 4: Run the test, then `npx vitest run test/schedule.test.ts test/radar-info.test.ts`** (the daily cron must still be first in `wrangler.jsonc`). Expected: PASS.
- [ ] **Step 5: Commit** `feat(care): uptime and domain sweeps on the existing crons`.

---

### Task 5: The health score

**Files:**
- Create: `src/worker/clients/health.ts`, `src/worker/clients/healthData.ts`
- Test: `test/health.test.ts`, `test/health-data.test.ts`

**Interfaces:**
- Produces (`health.ts`, pure): `interface HealthInput { openDown: boolean; domainDaysLeft: number | null; uptime30: number | null; checks30: number; overdueInvoices: number; held: boolean; pastDueSubscription: boolean; accessUnresolved: number; waitingOnClient: boolean }`; `type HealthBand = "good" | "watch" | "at_risk"`; `interface Health { score: number; band: HealthBand; reasons: string[]; hasData: boolean }`; `computeHealth(i: HealthInput): Health`.
  Start at 100 and take off, each at most once: an open down incident 30; domain 20 when `domainDaysLeft` is 7 or fewer (past included), 10 when 8 to 30; uptime under 99.0% 20, under 99.5% 10 (only when `checks30` is at least 20, so a few early checks cannot drag it); `overdueInvoices > 0` 15; `held` 25; `pastDueSubscription` 15; `accessUnresolved > 0` 10; `waitingOnClient` 10. The score is clamped to 0 to 100 and is an integer. Band: 80 or more `good`, 60 to 79 `watch`, under 60 `at_risk`. `reasons` has one plain sentence per deduction, in deduction order ("Site is down", "Domain expires in 12 days", "Uptime 98.7% in 30 days", "An invoice is overdue", "Billing is on hold", "A subscription payment failed", "Site access is still missing", "Waiting on the client"). `hasData` is `checks30 > 0`.
- Produces (`healthData.ts`): `healthInputs(db: D1Database, businessIds: string[], now: Date): Promise<Map<string, HealthInput>>` (one entry per id, queried in chunks of 50 like `src/worker/today.ts`; `uptime30` and `checks30` pooled across the business's monitored sites over the last 30 days; `domainDaysLeft` is the soonest among its live sites, by `domainDaysLeft` from Task 3; `overdueInvoices` and `held` are computed the same way `getClientRecord` computes `invoices.overdueCount` and `held` (reuse the same helper, extracting it from `clients/record.ts` if it is inline); `pastDueSubscription` is a live Care or Subscription row with `status = 'past_due'`; `accessUnresolved` counts `unresolved(items)` over live sites; `waitingOnClient` is the same test the Today `onboarding_attention` reason uses for "back of the queue"); `healthFor(db, businessId, now): Promise<Health>`.

- [ ] **Step 1: Write the failing tests.** `health.test.ts`: no inputs wrong (`openDown false, domainDaysLeft null, uptime30 null, checks30 0, 0, false, false, 0, false`) is `{ score: 100, band: "good", reasons: [], hasData: false }`; open down alone is 70 and `watch`; down plus a held billing plus an overdue invoice is 30 and `at_risk` with three reasons in order; every deduction at once clamps to 0; `uptime30: 98.7, checks30: 5` takes nothing and the same with `checks30: 20` takes 20; `domainDaysLeft: 7` takes 20, `8` takes 10, `31` and `null` take nothing, `-3` takes 20 and the reason says "expired"; `score` is an integer for every combination (loop the bit combinations) and never NaN. `health-data.test.ts`: a client with nothing gives `checks30: 0, uptime30: null` and `computeHealth` of it is 100; a client with 3 ok and 1 failed checks in the window gives `uptime30: 75`; a check older than 30 days is ignored; two sites of one client pool their checks; a client with an overdue invoice has `overdueInvoices: 1` and equals `getClientRecord(...).invoices.overdueCount` for the same `now`; a held client has `held: true` as the record says; a past-due Care subscription sets `pastDueSubscription`.
- [ ] **Step 2: Run both files.** Expected: FAIL.
- [ ] **Step 3: Implement.** If extracting the overdue and held helpers from `getClientRecord`, keep that function's output identical (`test/clients-flow.test.ts` pins it).
- [ ] **Step 4: Run both files and `npx vitest run test/clients-flow.test.ts`.** Expected: PASS.
- [ ] **Step 5: Commit** `feat(care): client health score`.

---

### Task 6: Today shows incidents

**Files:**
- Modify: `src/worker/today.ts` (`TODAY_KINDS`, a new `incidentAttention`, the loop in `buildToday`), `src/client/todayHome.ts` and any other view that maps a Today kind to a label or link (run `grep -rn "access_missing" src` and cover every hit)
- Test: `test/monitoring-today.test.ts`; update any existing test that lists every Today kind (`grep -rn "TODAY_KINDS\|access_missing" test`)

**Interfaces:**
- Consumes: `listIncidents` (Task 1).
- Produces: `TODAY_KINDS` gains `"site_incident"`; `buildToday` returns at most one `site_incident` item per client with `id: "site_incident:<businessId>"`: a down incident (priority 90) wins over a domain one (priority 66); reasons: `"<domain> has been down for 47 minutes"` (whole minutes, then "1 hour 5 minutes", then "2 days" for long ones, computed from `openedAt` and `now`) and `"<domain> expires in 12 days"` or `"<domain> expired 3 days ago"`; with two sites down the reason names the first and says "and 1 other site". It stays for a suppressed lead (it is the owner's own work, like `access_missing`), honours the done and snooze rules of the other kinds, and never appears for a test client or test site.

- [ ] **Step 1: Write the failing test.** Mirror `test/sites-today.test.ts` (same `NOW`, reset, `seedClient`). Cases: a client with an open down incident for 47 minutes gives exactly one item with the exact reason and priority 90; a domain incident only gives priority 66; both give one item, the down one; a closed incident gives none; a test client's incident gives none; a site marked `test` gives none; an incident for a suppressed lead still shows; `today_done` hides it for 7 days; `TODAY_KINDS` contains `site_incident`.
- [ ] **Step 2: Run the test.** Expected: FAIL.
- [ ] **Step 3: Implement `incidentAttention(db, now): Promise<Map<string, { reason: string; priority: number }>>` and push the item in the loop next to `access_missing`; fix every view and test that lists the kinds.**
- [ ] **Step 4: Run `npx vitest run test/monitoring-today.test.ts test/today.test.ts test/today-home.test.ts test/sites-today.test.ts`.** Expected: PASS.
- [ ] **Step 5: Commit** `feat(care): site incidents on Today`.

---

### Task 7: Care routes and the client record

**Files:**
- Create: `src/worker/routes/care.ts`, `src/worker/monitoring/fleet.ts`
- Modify: `src/worker/index.ts` (mount `careRoutes` under `/api`, next to `moneyRoutes`), `src/worker/clients/record.ts` (`ClientRecord` and `ClientRow`), `src/worker/routes/clients.ts` only if the record's JSON is shaped there
- Test: `test/care-routes.test.ts`

**Interfaces:**
- Consumes: `monitoredSites`, `listIncidents`, `recentChecks`, `uptimePercent`, `setMonitoring` (Task 1); `computeHealth`, `healthInputs` (Task 5).
- Produces: `interface SiteMonitoringView { siteId: string; domain: string | null; monitored: boolean; monitorable: boolean; up: boolean | null; slow: boolean; lastCheckedAt: string | null; uptime30: number | null; checks30: number; domainExpiresOn: string | null }` (`up` is `null` with no checks; `monitored` is the same rule as `monitoredSites`; `monitorable` is `monitorableUrl(url).ok`);
  `interface IncidentView { id: string; siteId: string; domain: string | null; kind: IncidentKind; openedAt: string; closedAt: string | null; detail: string }`;
  `interface CareRow { businessId: string; name: string; careLabel: string | null; mrrCents: number; health: Health; uptime30: number | null; sites: SiteMonitoringView[]; openIncidents: IncidentView[] }`;
  `careFleet(db: D1Database, now: Date): Promise<CareRow[]>` (clients with a live Care subscription, or with a site switched on, worst health first, ties by name; test clients left out; defined in the new file `src/worker/monitoring/fleet.ts`, which also exports the three view types above; `routes/care.ts` only calls it);
  routes under `/api`: `GET /care` → `{ clients: CareRow[] }`; `GET /incidents?open=1&businessId=` → `{ incidents: IncidentView[] }`; `GET /sites/:id/checks?limit=` → `{ checks: { checkedAt; ok; status; ms; error }[] }` (limit 1 to 200, default 50; 404 for an unknown, test or archived site); `PUT /sites/:id/monitoring` body `{ enabled: boolean }` → `{ site: SiteMonitoringView }` (400 for a body that is not exactly that; 404 as above; 409 with a plain sentence if turning it on for a site whose URL is not monitorable).
  `ClientRecord` gains `health: Health` and each `sites[i]` gains `monitoring: SiteMonitoringView`; `ClientRow` gains `healthScore: number | null` (null for a client without Care or a switched-on site). All routes sit behind the existing owner auth.

- [ ] **Step 1: Write the failing test.** Through `app.request` with the owner session (the pattern in `test/clients-flow.test.ts`): a Care client with two ok checks and one failed shows `uptime30: 66.7`, `up: false`, and appears first on `GET /care` ahead of a healthy one; a client with no Care and no switch is absent; a test client is absent; `GET /care` and `GET /clients/:id` give the same `health.score` for the same client and `now` (Review Focus 5); a new Care client with no checks has `up: null`, `uptime30: null`, `hasData: false` and score 100; `PUT /sites/:id/monitoring` `{ enabled: true }` puts a non-Care client's site on the board and `{ enabled: false }` takes it off; `{ enabled: "yes" }` and `{}` are 400; a site at `http://10.0.0.5` answers 409 and stays off; unknown id is 404; `GET /incidents?open=1` lists only open ones; the checks route clamps `limit=9999` to 200; every route answers 401 without a session.
- [ ] **Step 2: Run the test.** Expected: FAIL.
- [ ] **Step 3: Implement the routes, `careFleet` and the record changes.**
- [ ] **Step 4: Run `npx vitest run test/care-routes.test.ts test/clients-flow.test.ts`.** Expected: PASS.
- [ ] **Step 5: Commit** `feat(care): care fleet routes and client health`.

---

### Task 8: MCP read tools

**Files:**
- Create: `src/worker/mcp/tools/care.ts`
- Modify: `src/worker/mcp/server.ts` (import and call `registerCareTools`)
- Test: `test/mcp-care.test.ts`; extend `test/mcp-leaks.test.ts` and any test that asserts the tool count (25 becomes 27)

**Interfaces:**
- Consumes: `careFleet`, `IncidentView` (Task 7); `listIncidents` (Task 1).
- Produces: `registerCareTools(server, ctx)` (same signature as `registerMoneyTools`) registering two read-only tools: `get_care_overview` (no input) returning `{ clients: { clientId, name, careLabel, healthScore, band, reasons, uptime30, openIncidents: number }[] }` worst first; `list_incidents` with `{ open?: boolean; clientId?: string; limit?: number }` (limit 1 to 100, default 25) returning `{ incidents: { id, clientId, clientName, domain, kind, openedAt, closedAt, detail }[] }`. Both are hand-built views: no site URL, no vault name, no access note, no token, no Stripe id. Both are logged as agent actions the way the other read tools are.

- [ ] **Step 1: Write the failing test.** With a Care client that has an open down incident, a healthy one and a test client with an incident: `get_care_overview` lists the first two, the sick one first, and the test client nowhere; `list_incidents` with `open: true` returns the one open incident with `detail: "HTTP 503"`; `clientId` filters; `limit: 500` is refused by the schema; the JSON of both results contains no `http`, no `vault`, no token string and none of the site's `url` (assert on the serialized text); the server now lists 27 tools; both tools appear in the agent-action log.
- [ ] **Step 2: Run the test.** Expected: FAIL.
- [ ] **Step 3: Implement `tools/care.ts` and register it.**
- [ ] **Step 4: Run `npx vitest run test/mcp-care.test.ts test/mcp.test.ts test/mcp-read.test.ts test/mcp-leaks.test.ts`.** Expected: PASS.
- [ ] **Step 5: Commit** `feat(care): MCP care overview and incident tools`.

---

### Task 9: The Care page, the client panel and the list column

**Files:**
- Create: `src/client/careView.ts`, `src/client/pages/Care.tsx`
- Modify: `src/client/pages/Client.tsx` (a Care panel), `src/client/pages/Clients.tsx` (a Health column), `src/client/App.tsx` (the `/care` route), `src/client/navView.ts` (`/care` counts as Work, like `/money`), `src/client/api.ts` (the new calls)
- Test: `test/care-view.test.ts` (the pure view functions only; pages are checked by typecheck and build, as for Plan 10)

**Interfaces:**
- Consumes: the route shapes of Task 7.
- Produces (`careView.ts`, pure): `healthLabel(h: { score: number; band: HealthBand; hasData: boolean }): string` ("Health 82" / "Health 82 · no checks yet"); `bandTone(b: HealthBand): "ok" | "warn" | "bad"`; `formatUptime(p: number | null): string` ("99.8%" and "No checks yet", never "0%" for null); `incidentLine(i: IncidentView, now: Date): string` ("Down for 47 minutes: HTTP 503", "Domain expires in 12 days", and for a closed one "Was down 47 minutes, back at …" with the date in the booking zone passed in); `siteStateLabel(s: SiteMonitoringView): string` ("Up", "Slow", "Down", "Not checked yet", "Can't be monitored", "Monitoring off"); `sortCare(rows: CareRow[]): CareRow[]` (worst score first, ties by name, stable).
- Pages: `/care` shows one row per client (name, Care label, health chip with its band, uptime, open incident lines, each site's state) and a "Refresh" button that refetches; the client page's Care panel shows the health chip with its reasons, each site's state, uptime, domain expiry, a monitoring switch per site (calling `PUT /sites/:id/monitoring`; the 409 sentence shown as is) and the last 5 incidents; the clients list shows the score or a dash. Plain words, no jargon; phone width: the board is a single column of cards.

- [ ] **Step 1: Write the failing test `test/care-view.test.ts`.** `healthLabel({ score: 82, band: "good", hasData: true })` is `"Health 82"` and with `hasData: false` is `"Health 82 · no checks yet"`; `formatUptime(null)` is `"No checks yet"` and `formatUptime(99.75)` is `"99.8%"` and `formatUptime(100)` is `"100%"`; `incidentLine` for an incident opened 47 minutes before `now` is `"Down for 47 minutes: HTTP 503"` and for one opened 3 hours 5 minutes before `"Down for 3 hours 5 minutes: HTTP 503"`; `siteStateLabel` for each of the six states; `sortCare` keeps equal scores in name order and does not mutate its input.
- [ ] **Step 2: Run the test.** Expected: FAIL.
- [ ] **Step 3: Implement `careView.ts`, then the two pages and the three small edits.**
- [ ] **Step 4: Run `npx vitest run test/care-view.test.ts`, then `npm run typecheck` and `npm run build`.** Expected: PASS, clean.
- [ ] **Step 5: Commit** `feat(care): care board, client care panel and health column`.

---

### Task 10: The end-to-end test, the README and the open-items note

**Files:**
- Create: `test/care-monitoring-flow.test.ts`, `docs/superpowers/notes/2026-11-plan-11-open-items.md`
- Modify: `README.md` (a "Care monitoring" section after "Meetings, MCP and Money": the two crons, what is monitored, down and domain rules, Today, `/care`, the two MCP tools, "nothing is sent to anyone", config: none, the remote migration)

**Interfaces:**
- Consumes: everything above, through its real entry points: `runScheduled` with `REMINDER_CRON` and `DAILY_CRON`, `app.request` for the owner routes, the MCP route, `buildToday`; `monitoringDeps.fetch` is the only fake. Fixed calendar: Los Angeles, 3 December 2026, 09:00.

- [ ] **Step 1: Write the test, telling one story.** A Care client with one site, a client with no Care, a test client and an archived site; tick 1 (200) writes one check and opens nothing; tick 2 (503) writes a check, opens nothing and Today has no `site_incident`; tick 3 (503) opens one incident, Today has one `site_incident` priority 90 with the exact reason, `GET /api/care` shows the client first with `up: false` and a lower score, `get_care_overview` and `list_incidents` agree, and the activity timeline has one `site_down`; tick 4 (503) changes nothing; tick 5 (200) closes it, Today has no item, `site_back` is logged once, and the score is back where it started; the recorder shows that the no-Care client, the test client and the archived site were never fetched, and that a private-address site was skipped; `sweepDomains` called directly (the daily cron also runs the onboarding, project and billing sweeps, which can make approvals and tasks of their own, so the "nothing was made" assertion below counts rows around the monitoring calls only) with a fake RDAP answer of 12 days opens `domain_expiring` and Today shows it at priority 66; a later answer of 400 days closes it; switching the no-Care client on through `PUT /api/sites/:id/monitoring` makes the next tick fetch it; no mail transport call and no new approval or task exists at the end (the story's most important assertion); no URL, token or vault name is in any MCP result; every number on the board is finite.
- [ ] **Step 2: Run it.** Expected: PASS, or fix the defect it finds in the code under test, never in the test.
- [ ] **Step 3: Write the README section and the open-items note** (what was built, "Needs Logan", "Decisions for Logan" mirroring the Calls above with any ruling made while building, "Known gaps", the flakes). Needs Logan must say: apply `0061_monitoring` to the remote D1 before deploying (check with `wrangler d1 migrations list`, record the restore bookmark first); deploy; open `/care` and a client page on the real Worker at phone width; check one real Care site shows as up after two ticks; stop a site (or point a test site at a URL that returns 503) to see the incident and the Today row once; confirm RDAP answers for the real domains (some country domains give no answer: they show "unknown"); decide Calls 2, 3, 7 and 8.
- [ ] **Step 4: Run the whole suite: `npm test`, `npm run test:helper`, `npm run typecheck`, `npm run build`.** Expected: all pass except the known timing flakes, each of which passes alone.
- [ ] **Step 5: Commit** `test(care): monitoring end to end; docs: plan 11 notes`.

---

## Self-review (run when the plan was written)

- **Spec coverage:** §9.8 "uptime checks from Cloudflare cron" is Tasks 2 and 4; §7 Site "monitoring status" and Organization "health score" are Tasks 1, 5 and 7; §6 "Health 82" on the client page is Task 9; §12 Phase 3 "Health, grade, capacity": health is here, grade and capacity are deferred in Call 10 on purpose; "Care fleet automation", "monthly reports", "Local SEO", Studio and the ladder are Plans 12 to 15 and listed under Scope. The §9.8 "backup UptimeRobot" is not built (Global Constraints).
- **Types:** `Site` fields (Task 1) are used by Tasks 3, 4 and 7; `ProbeResult` (Task 2) by Tasks 3 and 4; `Transition` (Task 3) by Task 4; `HealthInput`/`Health` (Task 5) by Tasks 7, 8 and 9; `SiteMonitoringView`, `IncidentView`, `CareRow` (Task 7) by Tasks 8 and 9; `IncidentKind` (Task 1) by Tasks 3, 6, 7. `domainDaysLeft` is defined in Task 3 and consumed in Task 5.
- **Review Focus:** items 1 to 5 each name the task whose tests pin them; items 1, 2, 3, 4, 5 are in Tasks 2, 3, 4, 4/5 and 5/7.
- **Proportion:** bodies are left to the implementer except the health deductions, the down rule and the exact reason strings, which the spec leaves to the builder and the tests pin.
