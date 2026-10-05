# Opportunity Map Phases 0–3 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship Phases 0–3 of the product opportunity roadmap: evidence provenance and audit history, a service catalog with best-first-offer and fit scoring, and faster daily prospecting (suppression, quick scan, import, batch triage, today queue).

**Architecture:** Extend the existing Cloudflare Worker (Hono routes → `src/worker/db/*.ts` → D1 migrations) and React client (`src/client/pages`, `src/client/components`). New pure logic lives in small modules with their own tests; routes stay thin. Derived values (urgency, best offer, fit, audit diff) are computed at read time from stored data, not persisted, unless a task says otherwise.

**Tech Stack:** TypeScript, Hono, Cloudflare D1/R2/Workflows, Vite + React, Vitest with `@cloudflare/vitest-pool-workers` (tests run inside the Workers runtime; migrations auto-apply from `./migrations` via `test/apply-migrations.ts`).

**Spec:** [`docs/product-opportunity-map.md`](../../product-opportunity-map.md); sequencing rationale in [`2026-10-04-product-opportunity-roadmap.md`](2026-10-04-product-opportunity-roadmap.md).

## Global Constraints

- Public scan vs. client-connected audit: a public scan cannot claim conversion rates, plugin update status, backups, form deliverability, or Search Console data.
- Evidence before claims: keep URL, screenshot, date, method, and confidence with each issue; unknowns are phrased as questions or hypotheses.
- A score is a conversation aid; keep site quality, business fit, and urgency separate. A crawler failure must not make a good prospect look bad.
- Keep an approval step on external outreach: the app creates drafts and never sends mail. No automated cold-email sending.
- Never auto-adjust the scoring model from a few outcomes.
- The app is a single-user personal tool; do not add accounts or roles.
- Existing behavior must keep working: do not change the signature of `upsertBusiness` (12 callers), `score()` return field names (`score`, `health`, `categoryScores`, `niche`, `findings`, `offer`, `lowPriority`), or the `Audit` fields `score`, `offer`, `health_score`. New `Finding`/`Audit` fields are **optional** so stored audits still parse.
- The `Offer` type (`new_site | performance | care_plan | seo_basics | conversion`) stays; it is mapped onto the new service catalog, not replaced.
- Migrations: next number is `0014`, one file per task that needs one, named exactly as the task says. SQLite/D1: use `ALTER TABLE ... ADD COLUMN` with a default; no destructive changes.
- Verification gate for every task: `npm run typecheck && npm test` both green before commit (baseline: 41 files / 766 tests passing).
- UI work is verified in the browser: start the dev server with `preview_start` (see `.claude/launch.json`; create it per tool instructions if missing) and exercise the golden path plus one failure path.
- Commit messages are conventional (`feat:`, `test:`, `fix:`) and end with the line `Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>`.
- Follow surrounding code style: terse, comment only the non-obvious *why*; match existing naming (`snake_case` DB columns, `camelCase` TS).

## Codebase facts (verified 2026-10-04)

- `src/worker/index.ts` mounts routers with `app.route("/api/<name>", xRoutes)`; all `/api/*` is behind `requireAuth`. Cron `17 13 * * *` runs `runDueRadars`.
- `Finding` (`src/worker/types.ts:18`): `{ code, category, severity, points, evidence, recommendation, source: "rule" | "ai" }`. Findings are stored as a JSON string in `audits.findings`; `src/worker/db/audits.ts` `normalizeFinding` returns findings that have a `category` untouched, so extra optional properties round-trip with no migration.
- **Every audit run inserts a new `audits` row** (`insertAudit`); `latestAudit` reads the newest. The `audits` table is therefore already an append-only history of scores, findings and screenshot keys. There is no `listAudits` yet.
- `score()` is in `src/worker/scoring/scorer.ts`; `pickOffer` at line 273. Unreachable/parked/no-website sites return `health: 0` and a critical finding; sites with no measurable categories return `health: null`.
- `src/worker/pipeline/lead.ts` `runLead(deps, step, params)` steps: render → crawl → pagespeed → dns → review (AI) → score (inserts audit) → draft → progress. `draftFor` is the single drafting path used by `runLead` and `regenerateDraft`.
- `domainOf(url)` in `src/worker/db/businesses.ts` normalizes a URL to a lowercase host without `www.`; reuse it, do not write a second normalizer. `upsertBusiness(db, listing, searchId)` dedupes by `place_id`, then by domain.
- Lead routes are in `src/worker/routes/leads.ts` (`GET /`, `GET /:id`, `PATCH /:id`, `POST /:id/archive`, `POST /:id/reaudit` which creates a `LEAD_WORKFLOW` instance with `{ businessId, searchId: null, forceDraft: true }`, `POST /:id/regenerate`, gmail-draft, drive, report). `leadRows` is exported and tested in `test/routes.test.ts`.
- Test patterns: DB tests import `{ env } from "cloudflare:test"` and use helpers directly (`test/db.test.ts`); route tests use `SELF.fetch` with a login cookie (see top of `test/routes.test.ts`, including `seedLead`).
- Searches already have an opt-in column pattern: `migrations/0013_search_new_only.sql` (`ALTER TABLE searches ADD COLUMN new_only INTEGER NOT NULL DEFAULT 0`) threaded through `createSearch`, `search-start.ts`, the search workflow and the `Search` type. Follow it for any new per-search flag.
- Activity log: `logActivity(db, businessId, kind, detail)`; `ActivityKind` in `types.ts` is a closed union, extend it when adding kinds.
- Client entry points: `src/client/pages/{AllLeads,LeadDetail,LeadTable,NewSearch,SearchDetail,Settings,Radar,...}.tsx`; `src/client/api.ts` holds the API helpers and `ApiError`.

## Review Focus

Each line has a test in the task named in brackets.

1. **Crawler failure ≠ bad prospect** [Task 1, Task 5]: an audit with `health_score: null` must not lower the lead's fit, and `urgencyOf([])` is `0` rather than a penalty.
2. **Ambiguous lead matches on import** [Task 10]: same domain different name, same name different domain, `http://www.x.com/` vs `https://x.com`, duplicate rows inside one CSV — never silently merged.
3. **Suppressed lead re-enters via search, radar or import** [Tasks 7, 10]: a suppressed domain or place ID is excluded everywhere a lead can be created, and draft routes refuse it.
4. **Stale evidence shown as current** [Tasks 1, 3]: a finding with an old `observed_at` is flagged old; a finding without `observed_at` falls back to its audit's `created_at`, never to "now".
5. **No profiles ≠ zero fit** [Task 5]: with no active fit profiles `fit` is `null`, and a quick-scan lead with `fit: null` is never auto-excluded from the promising queue.

---

### Task 1: Finding provenance and urgency

**Files:**
- Modify: `src/worker/types.ts` (add optional fields to `Finding`)
- Create: `src/worker/audit/provenance.ts`
- Modify: `src/worker/pipeline/lead.ts` (apply provenance before `insertAudit`)
- Test: `test/provenance.test.ts`

**Interfaces:**
- Produces:
  - `Finding.observed_at?: string` (ISO timestamp) and `Finding.confidence?: "high" | "medium" | "low"` (both optional).
  - `export function withProvenance(findings: Finding[], observedAt: string): Finding[]` — returns copies with `observed_at` set (never overwriting an existing one) and `confidence` set when absent: `source === "rule"` → `"high"`; `source === "ai"` → `"medium"`.
  - `export function urgencyOf(findings: Finding[]): number` — integer 0–100: `min(100, 30*critical + 12*important + 3*nice)`; `0` for an empty list.
  - `export function isStale(f: Finding, auditCreatedAt: string, now: Date, days = 30): boolean` — uses `f.observed_at ?? auditCreatedAt`.

- [ ] **Step 1: Write the failing tests** in `test/provenance.test.ts`:
  - `withProvenance` stamps `observed_at` and `confidence` (`rule`→high, `ai`→medium) and does not mutate the input array's objects.
  - `withProvenance` keeps an existing `observed_at` and an existing `confidence`.
  - `urgencyOf([])` is `0`; one critical is `30`; 2 critical + 1 important is `72`; the sum caps at `100`.
  - `isStale`: a finding observed 45 days before `now` is stale; observed 5 days before is not; a finding with no `observed_at` uses the audit's `created_at` (stale if that is old, fresh if recent) and never treats a missing date as "now".
  - `runLead` integration (add to `test/pipeline-lead.test.ts` following its existing setup): after a run, every finding on `latestAudit(...)` has `observed_at` equal to `deps.now().toISOString()` and a `confidence`.
- [ ] **Step 2: Run** `npx vitest run test/provenance.test.ts test/pipeline-lead.test.ts` — expect failures (module/fields missing).
- [ ] **Step 3: Implement** the type fields, `provenance.ts`, and in `lead.ts` pass `withProvenance(s.findings, deps.now().toISOString())` as the `findings` given to `insertAudit` (`s.findings` still feeds `draftFor` via the stored audit, so no other change).
- [ ] **Step 4: Run** the two test files, then `npm run typecheck && npm test` — all green.
- [ ] **Step 5: Commit** `feat(audit): findings carry observed_at and confidence; add urgencyOf`.

---

### Task 2: Audit history and finding diff

**Files:**
- Modify: `src/worker/db/audits.ts` (add `listAudits`)
- Create: `src/worker/audit/diff.ts`
- Modify: `src/worker/routes/leads.ts` (`GET /:id` payload gains `changes`)
- Test: `test/audit-diff.test.ts`, extend `test/routes.test.ts`

**Interfaces:**
- Consumes: `Finding`, `Audit` from `src/worker/types.ts`.
- Produces:
  - `export async function listAudits(db: D1Database, businessId: string, limit = 20): Promise<Audit[]>` — newest first.
  - `export const findingKey = (f: Finding): string => f.code` — the key a finding is matched on across audits (AI findings already have a per-topic `ai_*` code; CRO findings are `cro:<id>`).
  - `export function diffFindings(prev: Finding[], next: Finding[]): { added: Finding[]; resolved: Finding[]; unchanged: Finding[] }` — `unchanged` holds the `next` objects.
  - `GET /api/leads/:id` response gains `changes: { since: string; added: Finding[]; resolved: Finding[]; unchangedCount: number } | null` — `null` when the lead has fewer than two audits; `since` is the previous audit's `created_at`.

- [ ] **Step 1: Write failing tests** in `test/audit-diff.test.ts`:
  - identical code sets → all `unchanged`, none added/resolved; empty `prev` → everything `added`; empty `next` → everything `resolved`.
  - a finding whose code disappears is `resolved`; a new code is `added`; reordering the array changes nothing (match by code, not position).
  - `listAudits` returns newest first and respects `limit` (insert three audits with `insertAudit`, newest has the highest `created_at`).
  - route test (in `test/routes.test.ts`): a lead with one audit returns `changes: null`; after inserting a second audit with a different finding set, `GET /api/leads/:id` returns `changes.added`, `changes.resolved`, `changes.unchangedCount` correctly.
- [ ] **Step 2: Run** `npx vitest run test/audit-diff.test.ts test/routes.test.ts` — expect failures.
- [ ] **Step 3: Implement** `listAudits` (`SELECT * FROM audits WHERE business_id = ? ORDER BY created_at DESC LIMIT ?`, reuse `fromRow`; export it only if `fromRow` is not already reachable — keep it inside `audits.ts`), `diff.ts`, and wire `changes` into the `GET /:id` handler by diffing the two newest audits.
- [ ] **Step 4: Run** targeted tests then `npm run typecheck && npm test` — all green.
- [ ] **Step 5: Commit** `feat(audit): audit history list and finding diff on lead detail`.

---

### Task 3: Evidence UI on the lead detail page

**Files:**
- Create: `src/client/components/EvidenceBadge.tsx`
- Modify: `src/client/pages/LeadDetail.tsx` (findings list, urgency chip, "Changes since last audit")
- Modify: client types in `src/client/` where `Finding`/lead detail types are declared (find with `grep -rn "recommendation" src/client`)
- Test: a pure helper test if you extract one (e.g. `test/evidence-view.test.ts` for a `confidenceLabel`/`ageLabel` helper); the rest is browser-verified

**Interfaces:**
- Consumes: `Finding.observed_at/confidence`, `isStale` and `urgencyOf` from Task 1 (import from `src/worker/audit/provenance` only if the client already imports worker modules; otherwise duplicate nothing — have the lead detail API return `urgency: number` computed server-side with `urgencyOf` and `stale: boolean` per finding using `isStale`, add both to the `GET /:id` payload and a route test).
- Consumes: `changes` from Task 2.
- Produces: `<EvidenceBadge finding={...} auditCreatedAt={...} stale={boolean} />` showing source (`Rule check` / `AI review`), `observed N days ago`, and a confidence chip; a stale finding shows an "older than 30 days" note.

- [ ] **Step 1:** Extend the `GET /:id` response with `urgency` and per-finding `stale` (failing route test first in `test/routes.test.ts`: a finding with `observed_at` 45 days ago has `stale: true`, a recent one `false`, a legacy finding without `observed_at` uses the audit date).
- [ ] **Step 2:** Implement the server side; test green.
- [ ] **Step 3:** Build `EvidenceBadge` and render it on the top five findings in `LeadDetail.tsx`; show the urgency value as a labelled, separate figure next to (not blended into) site health and opportunity; render "Changes since last audit" (added/resolved lists, unchanged count) when `changes` is non-null.
- [ ] **Step 4:** Verify in the browser: seed or use an existing lead with two audits, confirm badges, the stale note, and the changes block render; confirm a lead with one audit shows no changes block and no console errors.
- [ ] **Step 5:** `npm run typecheck && npm test`; commit `feat(ui): evidence badges, urgency and audit changes on lead detail`.

---

### Task 4: Service catalog

**Files:**
- Create: `migrations/0014_services.sql`, `src/worker/db/services.ts`, `src/worker/routes/services.ts`, `src/client/components/ServicesEditor.tsx`
- Modify: `src/worker/index.ts` (mount `/api/services`), `src/client/pages/Settings.tsx` (render `ServicesEditor`), `src/worker/types.ts` (`Service` type)
- Test: `test/services.test.ts`

**Interfaces:**
- Produces:
  - Table `services(id TEXT PRIMARY KEY, key TEXT NOT NULL UNIQUE, name TEXT NOT NULL, category TEXT NOT NULL, summary TEXT NOT NULL DEFAULT '', deliverables TEXT NOT NULL DEFAULT '[]', prerequisites TEXT NOT NULL DEFAULT '[]', first_engagement TEXT, finding_codes TEXT NOT NULL DEFAULT '[]', finding_categories TEXT NOT NULL DEFAULT '[]', is_specialty INTEGER NOT NULL DEFAULT 0, active INTEGER NOT NULL DEFAULT 1, sort INTEGER NOT NULL DEFAULT 0)` — the three JSON columns hold arrays; the migration **seeds all 34 rows** below with `INSERT`.
  - `export interface Service { id: string; key: string; name: string; category: string; summary: string; deliverables: string[]; prerequisites: string[]; first_engagement: string | null; finding_codes: string[]; finding_categories: AuditCategory[]; is_specialty: boolean; active: boolean; sort: number }`
  - `listServices(db: D1Database, o?: { activeOnly?: boolean }): Promise<Service[]>` ordered by `sort`, `getServiceByKey(db, key)`, `updateService(db, id, patch: Partial<Pick<Service, "name" | "summary" | "deliverables" | "prerequisites" | "first_engagement" | "finding_codes" | "finding_categories" | "is_specialty" | "active">>)`, `createService(db, input)` (key slugified from name, unique).
  - `export const OFFER_TO_SERVICE: Record<Offer, string>` = `{ new_site: "web-design-development", performance: "hosting-maintenance", care_plan: "hosting-maintenance", seo_basics: "seo", conversion: "conversion-rate-optimization" }` and `offerService(offer: Offer, services: Service[]): Service | null` (null if that key is missing or inactive).
  - Routes: `GET /api/services`, `POST /api/services`, `PATCH /api/services/:id` (400 on empty name; 404 unknown id).

**Seed data (migration):** keys are slugs of the names. Categories and names, in this order (`sort` 10, 20, …):
- Search & Visibility: SEO, Local SEO, Technical SEO, Ecommerce SEO, SEO Strategy
- Paid Media: PPC & Paid Media, Paid Search, Paid Social, Remarketing, Display Advertising, Social Media Marketing
- Websites: Web Design & Development, Custom Websites, Ecommerce Websites, WordPress Development, Website Accessibility, Hosting & Maintenance
- Brand & Content: Branding, Brand Identity, Brand Messaging, Graphic Design, Content Marketing, Content Strategy, Copywriting
- AI & Strategy: Digital Marketing, AI Marketing, AI Search Optimization, Generative Engine Optimization, AI Content Optimization, Digital Marketing Strategy
- Growth & Optimization: Performance Marketing, Conversion Rate Optimization, Lead Generation, Analytics & Attribution

`is_specialty = 1` for: `hosting-maintenance`, `conversion-rate-optimization`, `seo`, `ai-search-optimization`, `web-design-development`, `wordpress-development`, `graphic-design`. All rows `active = 1`. `summary` is one plain sentence per service. Evidence mapping (leave empty arrays for services not listed):
- `hosting-maintenance`: codes `slow_mobile, meh_mobile, slow_lcp, layout_shift, broken_links, mixed_content, no_https, no_https_redirect, no_email_auth, old_copyright, stale_content, site_unreachable`; categories `speed`.
- `web-design-development`: codes `not_mobile_friendly, no_viewport, mobile_overflow, small_text_mobile, dated_build, no_nav, no_footer, site_parked, no_website`; categories `design, mobile`.
- `conversion-rate-optimization`: codes `no_contact_path, no_cta, no_phone_visible, no_click_to_call, no_social_proof, cro:*`; categories `cro`.
- `seo`: codes `no_title_or_meta, no_h1, no_open_graph, low_seo_score, no_sitemap, thin_homepage, missing_niche_page`.
- `technical-seo`: codes `no_schema, no_sitemap, broken_links`; categories `technical`.
- `local-seo`: codes `no_local_schema`.
- `website-accessibility`: codes `low_accessibility, images_missing_alt, small_text_mobile`.
- `content-strategy`: codes `stale_content, past_events, thin_homepage, old_copyright`; categories `content`.
A trailing `*` in a code is a prefix wildcard (`cro:*` matches `cro:abc`). Verify every non-wildcard code exists in `FindingCode` (`src/worker/types.ts:8`); drop any that do not rather than inventing codes.

- [ ] **Step 1: Write failing tests** (`test/services.test.ts`): seed has exactly 34 services across 6 categories; the 7 specialty keys are flagged; `listServices({activeOnly: true})` excludes a service after `updateService(..., { active: false })`; `updateService` round-trips JSON arrays; `createService` slugifies and rejects a duplicate key; `offerService("conversion", services)` returns the CRO service and `null` when it is deactivated; route tests for list/patch/post and the 400/404 cases.
- [ ] **Step 2:** Run `npx vitest run test/services.test.ts` — fails.
- [ ] **Step 3:** Implement migration, db module, types, routes, mount in `index.ts`.
- [ ] **Step 4:** Build `ServicesEditor` in Settings: services grouped by category, toggles for Active and Specialty, editable summary / deliverables / prerequisites / first engagement, "Add service". Verify in the browser (toggle a service off, reload, still off; add a service; one failing request shows an error and does not drop the edit).
- [ ] **Step 5:** `npm run typecheck && npm test`; commit `feat(services): 34-service catalog with specialty flags and settings editor`.

---

### Task 5: Best first offer

**Files:**
- Create: `src/worker/services/best-offer.ts`, `src/client/components/BestOfferCard.tsx`
- Modify: `src/worker/routes/leads.ts` (`GET /:id` gains `best_offer`), `src/client/pages/LeadDetail.tsx`
- Test: `test/best-offer.test.ts`, extend `test/routes.test.ts`

**Interfaces:**
- Consumes: `Service`, `listServices`, `offerService`, `OFFER_TO_SERVICE` (Task 4); `Finding.confidence` (Task 1).
- Produces:
  - `export function serviceMatchesFinding(s: Service, f: Finding): boolean` — true if any of `s.finding_codes` equals `f.code` (or a `prefix*` pattern matches) **or**, failing that, `s.finding_categories` includes `f.category`.
  - `export interface BestOffer { service: Service; because: Finding[]; legacyOffer: Offer | null }`
  - `export function bestOffer(findings: Finding[], services: Service[], legacyOffer?: Offer | null): BestOffer | null` — considers only `active` services; a service's weight is the sum over matching findings of `critical 3 / important 2 / nice 1`, halved for `confidence === "low"`; specialty services are multiplied by `1.25`; highest weight wins, ties broken by `sort`; `because` is that service's matching findings (max 5, most severe first). If no service matches any finding, fall back to `offerService(legacyOffer, services)` with `because: []`; if that is null too, return `null`.
  - `GET /api/leads/:id` gains `best_offer: BestOffer | null` (null when the lead has no audit).

- [ ] **Step 1: Write failing tests** (`test/best-offer.test.ts`) using services built in the test (not the DB): a slow-site finding set picks `hosting-maintenance`; a booking-path finding set picks CRO; a specialty service beats a non-specialty with an equal match; an inactive service is never returned; `cro:abc` matches `cro:*`; an `ai_x` finding with `category: "cro"` matches CRO via category; low-confidence findings count half; no matches falls back to the legacy offer's service; no findings and no legacy offer returns `null`. Route test: `GET /api/leads/:id` of a seeded lead returns `best_offer.service.key` and `because`.
- [ ] **Step 2:** Run `npx vitest run test/best-offer.test.ts` — fails.
- [ ] **Step 3:** Implement `best-offer.ts` and wire it into the route.
- [ ] **Step 4:** Build `BestOfferCard` (service name, summary, first engagement, deliverables, prerequisites, and the supporting findings with their `EvidenceBadge`) and render it on `LeadDetail.tsx`. Verify in the browser, including a lead with no audit (no card, no error).
- [ ] **Step 5:** `npm run typecheck && npm test`; commit `feat(services): best-first-offer card on lead detail`.

---

### Task 6: Fit profiles and fit scoring (backend)

**Files:**
- Create: `migrations/0015_fit_profiles.sql`, `src/worker/db/fit.ts`, `src/worker/scoring/fit.ts`, `src/worker/routes/fit.ts`
- Modify: `src/worker/index.ts` (mount `/api/fit-profiles`), `src/worker/routes/leads.ts` (`leadRows` and `GET /:id` gain `fit`), `src/worker/types.ts`
- Test: `test/fit.test.ts`, extend `test/routes.test.ts`

**Interfaces:**
- Produces:
  - Table `fit_profiles(id TEXT PRIMARY KEY, name TEXT NOT NULL, service_key TEXT NOT NULL, industries TEXT NOT NULL DEFAULT '[]', geos TEXT NOT NULL DEFAULT '[]', platforms TEXT NOT NULL DEFAULT '[]', min_reviews INTEGER, min_rating REAL, active INTEGER NOT NULL DEFAULT 1, created_at TEXT NOT NULL)`; migration seeds three rows: "WordPress care" (`service_key: hosting-maintenance`, `platforms: ["wordpress"]`), "CRO" (`conversion-rate-optimization`, `min_reviews: 10`, `min_rating: 4.0`), "Redesign" (`web-design-development`, `platforms: ["wix","squarespace","godaddy","weebly"]`). Industries/geos start empty for Logan to fill in.
  - `export interface FitProfile { id: string; name: string; service_key: string; industries: string[]; geos: string[]; platforms: Platform[]; min_reviews: number | null; min_rating: number | null; active: boolean }`
  - `export interface FitResult { fit: number | null; profile: { id: string; name: string; service_key: string } | null; matched: string[]; missing: string[] }`
  - `export function scoreFit(business: Business, audit: Audit | null, profiles: FitProfile[]): FitResult` — for each **active** profile, the defined criteria are: `industry` (if `industries` non-empty; matches when `business.category` contains any entry, case-insensitive), `geo` (if `geos` non-empty; matches when `business.address` contains any entry, case-insensitive), `platform` (if `platforms` non-empty; matches when `audit?.platform` is in the list; **an audit with `platform: null` or no audit counts as missing, never as a negative mismatch penalty beyond missing**), `reviews` (if `min_reviews` set; `business.review_count >= min_reviews`), `rating` (if `min_rating` set; `business.rating >= min_rating`). Profile fit = `round(100 * matched / defined)`; profiles with zero defined criteria are ignored. The result is the best profile (ties → first). `fit: null` (and empty `matched`/`missing`) when there are no usable profiles. **Site health and `health_score` are never inputs** (crawler failure must not lower fit).
  - CRUD: `listFitProfiles(db)`, `createFitProfile`, `updateFitProfile`, `deleteFitProfile`; routes `GET/POST/PATCH/DELETE /api/fit-profiles` (400 when `service_key` is not a catalog key).
  - Lead payloads: each row from `leadRows` and `GET /:id` gains `fit: FitResult` (profiles loaded once per request).

- [ ] **Step 1: Write failing tests** (`test/fit.test.ts`): industry+geo match scores higher than geo-only for the same profile; no active profiles → `fit: null`; a profile with no defined criteria is ignored; platform criterion matches `audit.platform`, and an audit with `platform: null` leaves it in `missing`; a failed-crawl audit (`health_score: null`, `site_status: "unreachable"`) yields the same fit as a healthy audit for identical business fields (Review Focus 1); `matched`/`missing` list criterion names; best profile wins. Route tests: CRUD round trip, 400 for an unknown `service_key`, and `fit` present in the lead list and detail payloads.
- [ ] **Step 2:** Run `npx vitest run test/fit.test.ts` — fails.
- [ ] **Step 3:** Implement migration, db module, `fit.ts`, routes, payload wiring.
- [ ] **Step 4:** `npm run typecheck && npm test`; commit `feat(fit): service fit profiles and transparent fit score`.

---

### Task 7: Fit in the UI

**Files:**
- Create: `src/client/components/FitProfilesEditor.tsx`, `src/client/components/FitChip.tsx`
- Modify: `src/client/pages/Settings.tsx`, `src/client/pages/LeadTable.tsx` (Fit column + sort), `src/client/pages/LeadDetail.tsx` (fit explanation), client API types/helpers
- Test: helper tests only if you extract pure sort/format helpers (`test/fit-view.test.ts`); otherwise browser-verified

**Interfaces:**
- Consumes: `FitResult` and the `/api/fit-profiles` routes (Task 6); `fit` on lead rows.
- Produces: `<FitChip fit={FitResult} />` (number with a tooltip/popover listing `matched` and `missing`; `—` when `fit` is `null`), a sortable Fit column in `LeadTable.tsx` where `null` sorts last, and a profile editor in Settings (name, service from the catalog, industries, geos, platforms, min reviews, min rating, active, delete).

- [ ] **Step 1:** Implement `FitChip` and the Fit column; `null` fit renders `—` and never `0`.
- [ ] **Step 2:** Implement `FitProfilesEditor` in Settings and the fit explanation on `LeadDetail.tsx`.
- [ ] **Step 3:** Verify in the browser: edit a profile's industries, reload, confirm a lead's fit and its matched/missing lists change; confirm sorting by Fit puts `—` rows last; deleting all profiles makes every row `—`.
- [ ] **Step 4:** `npm run typecheck && npm test`; commit `feat(ui): fit column, fit explanation and profile editor`.

---

### Task 8: Suppression and ownership lists

**Files:**
- Create: `migrations/0016_suppressions.sql`, `src/worker/db/suppression.ts`, `src/worker/routes/suppressions.ts`, `src/client/components/SuppressionsEditor.tsx`
- Modify: `src/worker/index.ts`, `src/worker/pipeline/search.ts` (skip suppressed listings), `src/worker/routes/leads.ts` (refuse drafting/exports for a suppressed lead; add `POST /:id/suppress`), `src/worker/types.ts` (`ActivityKind` gains `"suppressed"`), `src/client/pages/LeadDetail.tsx` (action), `src/client/pages/Settings.tsx`
- Test: `test/suppression.test.ts`, extend `test/pipeline-search.test.ts` and `test/routes.test.ts`

**Interfaces:**
- Consumes: `domainOf` from `src/worker/db/businesses.ts`.
- Produces:
  - Table `suppressions(id TEXT PRIMARY KEY, kind TEXT NOT NULL CHECK (kind IN ('domain','place_id')), value TEXT NOT NULL, reason TEXT NOT NULL, note TEXT, created_at TEXT NOT NULL, UNIQUE(kind, value))`; `reason` is one of `client | opt_out | competitor | active_deal | other` (validate in code).
  - `export async function isSuppressed(db: D1Database, b: { domain?: string | null; placeId?: string | null; websiteUrl?: string | null }): Promise<Suppression | null>` — normalizes with `domainOf`, matches `domain` or `place_id` rows.
  - `listSuppressions`, `addSuppression(db, { kind, value, reason, note? })` (value normalized: domains via `domainOf` on the input; reject empty/invalid), `removeSuppression(db, id)`; routes `GET/POST /api/suppressions`, `DELETE /api/suppressions/:id`.
  - `POST /api/leads/:id/suppress { reason, note? }` adds a suppression for the lead's domain and, if present, place ID, and logs activity kind `suppressed`.
  - Search pipeline: listings matching a suppression are not upserted and are counted in the search's progress as skipped (follow how `incrementProcessed`/`found_count` behave so a search still completes).
  - `POST /api/leads/:id/regenerate`, `/gmail-draft` and `/report` return `409 { error: "suppressed", reason }` for a suppressed lead.

- [ ] **Step 1: Write failing tests** (`test/suppression.test.ts`): `isSuppressed` matches `https://www.Acme.com/` against a `acme.com` domain row; matches by place ID; returns `null` for an unrelated lead; adding a duplicate is rejected cleanly; adding an invalid/empty value is rejected. Pipeline test: a search whose results include a suppressed domain and a suppressed place ID upserts neither and still finishes `done` with correct counts. Route tests: `POST /:id/suppress` creates both rows; drafting/export routes return 409 for a suppressed lead and succeed after `DELETE /api/suppressions/:id` (Review Focus 3). Radar needs no separate test because it goes through the same search pipeline — add a one-line assertion in `test/radar-run.test.ts` only if that file already starts the real search pipeline.
- [ ] **Step 2:** Run `npx vitest run test/suppression.test.ts test/pipeline-search.test.ts` — fails.
- [ ] **Step 3:** Implement migration, db module, routes, pipeline filter, route guards.
- [ ] **Step 4:** UI: "Suppressions" section in Settings (list, add by domain with reason, remove) and a "Mark as client / opt-out / competitor" menu on `LeadDetail.tsx` that calls `/suppress`. Verify in the browser; a suppressed lead shows a visible banner and disabled draft/export buttons.
- [ ] **Step 5:** `npm run typecheck && npm test`; commit `feat(suppression): suppression list enforced in search, drafting and exports`.

---

### Task 9: Two-stage audit spending (quick scan)

**Files:**
- Create: `migrations/0017_scan_stage.sql`, `src/client/pages/Promising.tsx`
- Modify: `src/worker/pipeline/lead.ts` (`runLead` stage), `src/worker/workflows.ts`, `src/worker/search-start.ts`, `src/worker/pipeline/search.ts`, `src/worker/db/searches.ts`, `src/worker/db/businesses.ts`, `src/worker/routes/searches.ts`, `src/worker/routes/leads.ts` (`POST /:id/full-scan`; lead rows gain `scan_stage`), `src/worker/types.ts`, `src/client/pages/NewSearch.tsx`, `src/client/App` routing/nav, `src/client/pages/SearchDetail.tsx`
- Test: `test/quick-scan.test.ts`, extend `test/pipeline-lead.test.ts`, `test/pipeline-search.test.ts`, `test/routes.test.ts`

**Interfaces:**
- Consumes: `scoreFit` (Task 6) for the Promising queue; the per-search flag pattern from `migrations/0013_search_new_only.sql`.
- Produces:
  - `migrations/0017_scan_stage.sql`: `ALTER TABLE businesses ADD COLUMN scan_stage TEXT NOT NULL DEFAULT 'full'` and `ALTER TABLE searches ADD COLUMN quick_scan INTEGER NOT NULL DEFAULT 0`. Existing rows stay `'full'`.
  - `type ScanStage = "quick" | "full"`; `Business.scan_stage`; `Search.quick_scan: 0 | 1`.
  - `runLead(..., p: { ...; stage?: ScanStage })`, default `"full"` so every existing call and test is unchanged. In `"quick"` stage: **skip** render, pagespeed, review and draft; still run crawl, dns and score; insert the audit; set `businesses.scan_stage = 'quick'`. In `"full"` stage set `scan_stage = 'full'`. Quick audits are marked `partial: true` as `insertAudit` already does when pagespeed is absent. Spend recorded via `recordUsage` must show **no** `browser`, `pagespeed` or `claude` usage for a quick run.
  - A search created with `quick_scan = 1` runs its leads with `stage: "quick"`. The new-search form gets a checkbox "Quick scan first (cheaper)" defaulting to **on**. Radar-started searches keep `quick_scan = 0` (unattended spend and behavior unchanged — recorded as a ruling).
  - `POST /api/leads/:id/full-scan` starts the existing `LEAD_WORKFLOW` with `{ businessId, searchId: null, forceDraft: false, stage: "full" }` and logs activity `reaudit`; works for any lead at any stage (the ability to audit any lead is preserved).
  - Promising queue: `GET /api/leads?stage=quick` (or a dedicated `/api/leads/promising`) returns quick-stage, non-archived, non-suppressed leads with `fit`; sorted by `fit` desc (`null` last) then opportunity `score` desc. A `null`-fit lead is **never excluded**. `Promising.tsx` lists them with a minimum-fit filter (default none), per-row "Run full scan", and shows what a full scan adds.
  - Automatic promotion is **not** built in this task (manual promote only); record that as a ledger ruling.

- [ ] **Step 1: Write failing tests** (`test/quick-scan.test.ts` plus extensions): a quick `runLead` with fake deps inserts an audit, sets `scan_stage = 'quick'`, and makes **no** render, PageSpeed, AI-review or draft calls and records no browser/pagespeed/claude usage; a default `runLead` still runs all steps and sets `'full'`; a search with `quick_scan = 1` passes `stage: "quick"` to its lead workflows and one without passes `"full"`; `POST /:id/full-scan` creates a workflow with `stage: "full"` and works on a lead with no audit; the promising list orders by fit then score, puts `null` fit last, keeps `null`-fit leads, and excludes archived and suppressed ones (Review Focus 5). Migration test: a lead that existed before the migration has `scan_stage = 'full'`.
- [ ] **Step 2:** Run `npx vitest run test/quick-scan.test.ts` — fails.
- [ ] **Step 3:** Implement migration, `runLead` staging (extract nothing; add `stage` handling inline around the existing `step.do` blocks), workflow param threading, search flag threading, routes.
- [ ] **Step 4:** UI: the new-search checkbox, a "Quick scan" badge on rows, and the Promising page with its nav entry. Verify in the browser: create a search form with the box on, open the Promising page, click "Run full scan" on a row (the request succeeds and the row's stage updates after reload).
- [ ] **Step 5:** `npm run typecheck && npm test`; commit `feat(scan): quick-scan stage, promising queue, on-demand full scan`.

---

### Task 10: Import leads by URL or CSV

**Files:**
- Create: `src/worker/import/match.ts`, `src/worker/import/parse.ts`, `src/worker/routes/import.ts`, `src/client/pages/Import.tsx`
- Modify: `src/worker/index.ts`, `src/worker/db/businesses.ts` (add `findBusinessCandidates`; do not change `upsertBusiness`), client nav/routing, `src/worker/db/searches.ts` if an "Imports" container search is needed
- Test: `test/import-match.test.ts`, `test/import-routes.test.ts`

**Interfaces:**
- Consumes: `domainOf`, `upsertBusiness`, `isSuppressed` (Task 8), `Listing` type.
- Produces:
  - `export interface ImportRow { name: string; url: string | null; address?: string | null; phone?: string | null; category?: string | null; source: string }`
  - `export type MatchKind = "new" | "exact" | "ambiguous"`; `export function matchBusiness(row: ImportRow, existing: Business[]): { kind: MatchKind; candidates: Business[] }`:
    - `exact`: the row's normalized domain equals an existing business's domain **and** names are similar (case/punctuation-insensitive equality, or one contains the other); returns that business.
    - `ambiguous`: same domain but clearly different names (and not social-only hosts), **or** same normalized name but different domains, **or** more than one candidate matches; returns all candidates.
    - `new`: otherwise. Social-only hosts (`isSocialOnlyUrl`) are never used as a domain match.
  - `parseCsv(text: string): ImportRow[]` — header row with `name`, `website|url`, optional `address, phone, category`; tolerates quoted fields, CRLF, BOM, blank lines; rows without a name are rejected with an error entry (not thrown).
  - `POST /api/import/preview { text?: string, url?: string, source: string }` → `{ rows: [{ row, kind: "new" | "exact" | "ambiguous" | "duplicate_in_file" | "suppressed" | "invalid", candidates, reason? }] }`; **no database writes**. A second row in the same file that normalizes to the same domain as an earlier one is `duplicate_in_file`.
  - `POST /api/import/commit { rows: [{ row, action: "create" | "link" | "skip", businessId? }], source }` → creates only `create` rows (via `upsertBusiness` into an "Imports" container search with `business_type: "import"`, `location: "Import"`, created `done`, so existing search/lead views keep working) and logs nothing for `skip`; `link` attaches the import's source to the chosen existing business (activity note only) without overwriting its fields. `commit` re-checks suppression and refuses suppressed rows even if the client says `create`.
  - Newly created businesses start with `scan_stage = 'full'`? **No:** they are created with no audit and queued the same way a quick-scan search queues its leads (start `LEAD_WORKFLOW` with `stage: "quick"`); the response reports how many audits were queued.

- [ ] **Step 1: Write failing tests** (`test/import-match.test.ts`): `http://www.x.com/` vs `https://x.com` → `exact` (same name); same domain but a different name → `ambiguous`; same name different domains → `ambiguous`; two existing candidates for one row → `ambiguous` with both; social-only URL (`facebook.com/...`) never matches by domain; no website and unmatched name → `new`; CSV parsing for quoted commas, CRLF, BOM, missing name, `website` vs `url` header. Route tests (`test/import-routes.test.ts`): preview returns `duplicate_in_file` for two rows with the same domain in one file and writes nothing; a suppressed domain is `suppressed` in preview and is refused by `commit` even when sent as `create` (Review Focus 3); `commit` creates only chosen rows, resolves an `ambiguous` row to `link`, and the created business appears in the "Imports" container search (Review Focus 2).
- [ ] **Step 2:** Run `npx vitest run test/import-match.test.ts test/import-routes.test.ts` — fails.
- [ ] **Step 3:** Implement `match.ts`, `parse.ts`, `findBusinessCandidates` (candidates by normalized domain, and by normalized name), routes, container search handling.
- [ ] **Step 4:** UI: `Import.tsx` — paste a single URL or upload/paste a CSV, preview table with per-row classification and, for ambiguous rows, a pick-one control (Create new / Link to X / Skip); commit button; result summary. Verify in the browser with a CSV that contains a new row, an exact match, an ambiguous row, a duplicate and a suppressed domain.
- [ ] **Step 5:** `npm run typecheck && npm test`; commit `feat(import): add leads by URL or CSV with ambiguity review`.

---

### Task 11: Batch triage and saved filters

**Files:**
- Create: `migrations/0018_saved_filters.sql`, `src/worker/db/filters.ts`, `src/client/components/BulkBar.tsx`
- Modify: `src/worker/routes/leads.ts` (bulk + undo + filters routes), `src/worker/db/businesses.ts` (bulk helpers), `src/worker/types.ts` (`ActivityKind` gains `"bulk"`), `src/client/pages/AllLeads.tsx`, `src/client/pages/LeadTable.tsx`, `src/client/pages/SearchDetail.tsx`
- Test: `test/leads-bulk.test.ts`

**Interfaces:**
- Produces:
  - `POST /api/leads/bulk { ids: string[], action: "status" | "archive" | "restore" | "tag" | "untag", status?: LeadStatus, tag?: string }` → `{ updated: number, undoToken: string | null }`. At most 200 ids per call (400 beyond). `archive` is the existing soft archive (`archived_at`); there is **no** bulk delete. Each affected lead gets one `activity` row of kind `bulk`. The response `undoToken` identifies a snapshot of prior `lead_status`/`archived_at`/tags for those ids; `POST /api/leads/bulk/undo { undoToken }` restores them (tokens expire after 10 minutes and work once; an unknown/expired token is 404).
  - Tags: `ALTER TABLE businesses ADD COLUMN tags TEXT NOT NULL DEFAULT '[]'` (JSON array of lowercase strings, max 20 per lead, 32 chars each); `Business.tags: string[]` parsed on read; `GET /api/leads?tag=` filters.
  - Saved filters: table `saved_filters(id TEXT PRIMARY KEY, name TEXT NOT NULL, query TEXT NOT NULL, created_at TEXT NOT NULL)` (`query` is the serialized list-filter state from the leads page); routes `GET/POST /api/leads/filters`, `DELETE /api/leads/filters/:id` (mounted before `/:id` so they are not captured by it).
  - Undo snapshots live in a table `bulk_undo(token TEXT PRIMARY KEY, snapshot TEXT NOT NULL, created_at TEXT NOT NULL)` in the same migration.

- [ ] **Step 1: Write failing tests** (`test/leads-bulk.test.ts`): bulk status change updates all ids and logs one activity each; bulk archive then `undo` restores `archived_at` and status; `tag`/`untag` normalize case, dedupe and enforce the limits; 201 ids → 400; an unknown id in the list is ignored and counted correctly (`updated` excludes it); undo with an expired token (set `created_at` 11 minutes back) → 404 and a reused token → 404; saved filters CRUD and `/filters` route not shadowed by `/:id`; no `delete` action exists (400 for `action: "delete"`).
- [ ] **Step 2:** Run `npx vitest run test/leads-bulk.test.ts` — fails.
- [ ] **Step 3:** Implement migration, db helpers, routes.
- [ ] **Step 4:** UI: row checkboxes with select-all-on-page, a `BulkBar` (set status, archive, tag, an "Undo" toast for 10 seconds), and a saved-filters menu (save current filters, apply, delete) on `AllLeads.tsx`; the same selection bar on `SearchDetail.tsx`. Verify in the browser: select 3 leads, archive, click Undo, confirm they return; save and re-apply a filter.
- [ ] **Step 5:** `npm run typecheck && npm test`; commit `feat(triage): bulk actions with undo, tags and saved filters`.

---

### Task 12: Next-action ("Today") queue

**Files:**
- Create: `src/worker/today.ts`, `src/worker/routes/today.ts`, `src/client/pages/Today.tsx`
- Modify: `src/worker/index.ts`, `src/worker/types.ts` (`ActivityKind` gains `"today_done" | "snoozed"`), client nav/routing (make Today the default landing page only if the existing default is a plain leads list; otherwise just add a nav entry)
- Test: `test/today.test.ts`

**Interfaces:**
- Consumes: `follow_up_at`, `deal_value`, `lead_status`, drafts (`listDrafts`), `activity`, `latestAudit`, suppression (Task 8) to hide suppressed leads, `scan_stage` (Task 9).
- Produces:
  - `export interface TodayItem { id: string; kind: "follow_up_due" | "draft_unsent" | "stalled_deal" | "promising_quick_scan"; businessId: string; businessName: string; reason: string; due: string | null; priority: number }` — `id` is `${kind}:${businessId}`.
  - `export async function buildToday(db: D1Database, now: Date): Promise<TodayItem[]>`:
    - `follow_up_due`: `follow_up_at <= now` (overdue first), non-archived, status not `won`/`lost`/`skip`; priority 100 (+ days overdue, capped at +30).
    - `draft_unsent`: lead has a draft, status is `new` or `reviewed`, no `activity` of kind `export` for it since the draft's `created_at`, and the draft is older than 2 days; priority 60.
    - `stalled_deal`: status `contacted` or `replied`, `deal_value` set, and no `activity` row in the last 14 days; priority 70.
    - `promising_quick_scan`: `scan_stage = 'quick'`, non-archived, not suppressed, opportunity `score` ≥ 50; priority 40; at most 5 of these.
    - Items for a lead with a snooze/done activity (`snoozed`/`today_done`) newer than `now` minus the snooze span are hidden: `POST /api/today/:kind/:businessId/done` logs `today_done` (hides that item for 7 days); `POST .../snooze { days: 1-30 }` logs `snoozed` with `detail` = ISO "until" date. Suppressed and archived leads never appear.
    - Sorted by `priority` desc, then `due` asc.
  - `GET /api/today` → `{ items: TodayItem[] }`.

- [ ] **Step 1: Write failing tests** (`test/today.test.ts`, calling `buildToday` with a fixed `now`): an overdue follow-up outranks a stalled deal; a future follow-up does not appear; a lead with a `won` status never appears; an unsent draft older than 2 days appears and one with an `export` activity after it does not; a stalled deal with recent activity does not appear; `done` hides an item for 7 days and `snooze` hides it until the stated date; archived and suppressed leads never appear; at most 5 `promising_quick_scan` items; route test for `GET /api/today` and the two POST actions (400 on `days` outside 1–30).
- [ ] **Step 2:** Run `npx vitest run test/today.test.ts` — fails.
- [ ] **Step 3:** Implement `today.ts` and routes.
- [ ] **Step 4:** UI: `Today.tsx` listing items with the reason, a link to the lead, and Done / Snooze (1d, 3d, 7d) actions; empty state "Nothing due". Verify in the browser with seeded leads covering each kind.
- [ ] **Step 5:** `npm run typecheck && npm test`; commit `feat(today): next-action queue from follow-ups, drafts and stalled deals`.

---

## Self-review

- **Coverage:** Phase 1 (#2 → Tasks 1, 3; #53 → Tasks 2, 3), Phase 2 (#3 → Tasks 4, 5; #1 → Tasks 6, 7), Phase 3 (#7 → Task 8, #5 → Task 9, #6 → Task 10, #42 → Task 11, #41 → Task 12). Phase 0 was completed in the controller session (baseline green; radar and public routes mounted; cron configured; migrations 0001–0013 apply in tests).
- **Deviations from the roadmap, with reasons:** (1) no `audit_snapshots` table — `audits` is already append-only history (Task 2); (2) `urgency` and best-offer are derived at read time, not stored; (3) `source` on `Finding` keeps its existing `"rule" | "ai"` type and gains `confidence` and `observed_at`, rather than a new source vocabulary; (4) automatic promotion by a fit threshold is deferred, manual promote ships (Task 9); (5) radar searches stay full-scan.
- **Interface consistency:** `withProvenance/urgencyOf/isStale` (Task 1) → Task 3; `listAudits/diffFindings/changes` (Task 2) → Task 3; `Service/listServices/offerService` (Task 4) → Tasks 5, 6; `FitResult/scoreFit` (Task 6) → Tasks 7, 9; `isSuppressed` (Task 8) → Tasks 9, 10, 12; `scan_stage/stage` (Task 9) → Tasks 10, 12; `ActivityKind` additions are made by the task that first needs them (`suppressed` in 8, `bulk` in 11, `today_done|snoozed` in 12).
- **Placeholders:** none; file paths that depend on code the implementer must read (`App` routing, client API types) are named by how to find them.
