# Product Opportunity Map Implementation Roadmap

> **For agentic workers:** This is a **master roadmap**, not a task-by-task TDD plan. 55 features across ~10 subsystems cannot be planned at code level in one pass; later phases depend on interfaces earlier phases create. **Before starting each phase, write that phase's detailed plan** (`docs/superpowers/plans/YYYY-MM-DD-phase-N-<name>.md`) with superpowers:writing-plans, then execute it with superpowers:subagent-driven-development or superpowers:executing-plans. Phases 0–3 below include task-level breakdowns; later phases are feature-level scopes.

**Goal:** Implement all 55 feature opportunities in the product opportunity map, in dependency order, so each phase ships working, testable software on its own.

**Architecture:** Extend the existing Cloudflare Worker (Hono routes + D1 migrations + Workflows pipelines) and React client. Every new diagnostic is a self-contained module that emits evidence-backed findings into the existing audit/CRO model; every new workflow is a route + `db/` module + page/component following the current pattern (`routes/*.ts` → `db/*.ts` → `client/pages|components`).

**Tech Stack:** TypeScript, Hono, Cloudflare D1/Workers/Browser Rendering (`@cloudflare/puppeteer`), Vite + React, Vitest, Anthropic SDK, Bright Data, Google (Gmail/Drive) integration.

**Spec:** [`docs/product-opportunity-map.md`](../../product-opportunity-map.md)

## Global Constraints

Copied from the spec's design rules; every phase inherits them.

- Public scan vs. client-connected audit: a public scan cannot claim conversion rates, plugin update status, backups, form deliverability, or Search Console data. Reserve those for connected audits.
- Evidence before claims: every issue keeps URL, screenshot, date, method, and confidence. Unknowns are phrased as questions or hypotheses.
- A score is a conversation aid: show strengths and gaps. Keep site quality, business fit, and urgency separate.
- Keep an approval step on external outreach: the app creates drafts; it does not send mail. No fully automated cold-email sending.
- Never submit public forms or place orders on a prospect site (walkthroughs, commerce journeys). Synthetic submissions only on client-controlled sites with consent (#25).
- Never auto-adjust the scoring model from a few outcomes (#4): review, then change weights by hand.
- Do not claim an automated axe scan is a full WCAG audit; do not name a vulnerable plugin without verified version evidence.
- The app is a single-user personal tool: no roles/accounts work until a real second user exists (#55).
- Credentials never go in CRM notes (#47).
- Migrations: next number is `0014`; one migration file per phase minimum, named `00NN_<topic>.sql`, applied with `npm run db:migrate:local`.
- Verification gate for every task: `npm run typecheck && npm test` green before commit. After large changes run `graft build`.

## Review Focus

Failure modes the spec implies but no feature's tests would cover by default. Each must get a test in the owning phase.

1. **Crawler failure ≠ bad prospect** (Phase 1): a failed/blocked crawl must produce "unknown" site quality, not a low score. Test: null/failed audit yields `site_quality = null` and does not lower fit.
2. **Ambiguous lead matches on import** (Phase 3): same domain with a different name, same name with two domains, `www.`/trailing-slash/http-vs-https variants, and duplicate rows within one CSV. Expected: never silently merge; queue for review.
3. **Suppressed lead re-enters via radar/import** (Phase 3): a suppressed domain must be excluded from Maps search results, radar runs, imports and follow-up drafts.
4. **Stale evidence presented as current** (Phases 1, 5): findings older than a threshold show their age; re-audit diffs distinguish "new", "unchanged", "resolved", "dismissed false positive".
5. **Follow-up to someone who replied/opted out** (Phase 6): reply logged, opt-out recorded, or ambiguous thread match must stop/hold the sequence and never change lead stage silently.

---

## Dependency map

```
Phase 0 Baseline
   └─ Phase 1 Evidence foundation (#2, #53)
         ├─ Phase 2 Service catalog + fit (#3, #1)
         │     └─ Phase 3 Throughput (#6, #7, #5, #42, #41)
         │           └─ Phase 4 Pitch assets (#32, #33, #34)
         ├─ Phase 5 Core diagnostics (#14, #15, #17, #18, #24)   [needs Phase 1 evidence model; Phase 2 catalog to map to services]
         └─ Phase 6 Close the loop (#36, #37, #35, #8)           [#8 needs #53 from Phase 1; #36/#37 need Phase 3 queue]
Phase 7 Extended diagnostics + context (7a #16 #20-23 #26 | 7b #9 #10 #12 #27 | 7c #11)
Phase 8 Client-authorized data (#29, #30, #31, #19, #25)
Phase 9 Sales intelligence + integrations (#4, #38-40, #43-46, #54)
Phase 10 Client lifecycle (#47-52)
Phase 11 Gated / deferred (#13, #28, #55)
```

Note the one place this departs from the map's priority labels: **#53 (P2) is pulled into Phase 1** because #8 (P1 change alerts) and #4/#50 need immutable evidence snapshots.

## Feature coverage checklist

| Phase | Features |
|---|---|
| 0 | baseline verification (no features) |
| 1 | #2, #53 |
| 2 | #3, #1 |
| 3 | #6, #7, #5, #42, #41 |
| 4 | #32, #33, #34 |
| 5 | #14, #15, #17, #18, #24 |
| 6 | #36, #37, #35, #8 |
| 7a | #16, #20, #21, #22, #23, #26 |
| 7b | #9, #10, #12, #27 |
| 7c | #11 |
| 8 | #29, #30, #31, #19, #25 |
| 9 | #4, #38, #39, #40, #43, #44, #45, #46, #54 |
| 10 | #47, #48, #49, #50, #51, #52 |
| 11 | #13, #28, #55 |

All 55 appear exactly once.

## Standard diagnostic module pattern (used by Phases 5, 7, 8)

So later phases don't each reinvent the shape, every new diagnostic follows this:

1. **Module** `src/worker/audit/<name>.ts` (public checks) or `src/worker/cro/evidence/<name>.ts` (browser evidence): a pure function `(input) => Finding[]` where each `Finding` carries `source`, `observed_at`, `confidence`, and `evidence` (URL/screenshot ref) — fields added in Phase 1.
2. **Fixture-driven test** in `test/` using a saved HTML/response fixture; one "clean site produces no finding" test, one "unknown/blocked produces `confidence: low` or no claim" test.
3. **Wire** into `src/worker/pipeline/lead.ts` (cheap checks) or `src/worker/cro/pipeline.ts` (deep checks); gate by the two-stage budget rule from Phase 3.
4. **Map** each finding type to a service in the Phase 2 catalog.
5. **Surface** in `LeadDetail.tsx` and the report (`report/html.ts`) with its evidence and confidence; never as a bare score.

---

## Phase 0: Confirm the baseline (½ day)

**Finding that changes this phase:** the map warns of an unresolved merge (43 conflict blocks). In this checkout that is **no longer true**: `git status` is clean of unmerged files, a search for `<<<<<<<` markers in `src`, `migrations`, `test`, `docs` finds none, PR #3 (`site-search-v2`) is merged, `npm run typecheck` passes and `npm test` passes (41 files, 766 tests). The remaining risk is that the *wiring* the map says was in conflict (radar and public reports) is actually mounted.

### Task 0.1: Verify radar and public-report wiring

**Files:**
- Read: `src/worker/index.ts`, `src/worker/routes/radar.ts`, `src/worker/routes/public.ts`, `src/worker/radar-run.ts`, `wrangler.toml` (or `wrangler.jsonc`)
- Test: add `test/wiring.test.ts` only if a gap is found

- [ ] **Step 1:** Confirm `src/worker/index.ts` mounts the radar and public routers and that a scheduled/cron handler calls the radar run (`graft callers runRadar --depth 2`, or `graft grep "radar"` scoped to `src/worker/index.ts`).
- [ ] **Step 2:** Confirm `wrangler` config declares the cron trigger and the bindings the routes use.
- [ ] **Step 3:** Run `npm run db:migrate:local` on a fresh local D1 and confirm migrations 0001–0013 apply in order with no errors.
- [ ] **Step 4:** If any wiring is missing, write a failing test that requests the route / invokes `scheduled`, wire it, and confirm it passes. If nothing is missing, skip.
- [ ] **Step 5:** Tag the baseline: `git tag baseline-pre-roadmap` (local only). Commit any fix.

**Exit criteria:** fresh DB migrates; radar and public report reachable in `npm run dev`; typecheck and tests green.

---

## Phase 1: Evidence foundation — #2 explainable score with confidence, #53 evidence history and diff

**Why first:** nearly every later feature (service mapping, teaser, alerts, calibration, before/after) needs findings with provenance and a way to compare audits over time.

**Deliverable:** every finding carries `source`, `observed_at`, `confidence`; scoring reports three separate values (`site_quality`, `business_fit` placeholder, `urgency`); audits are stored as immutable snapshots with a computed diff.

### Task 1.1: Provenance fields on findings (#2)

**Files:**
- Modify: finding type in `src/worker/types.ts`; finding producers in `src/worker/audit/rubrics.ts` and the AI review step in `src/worker/pipeline/lead.ts`
- Create: `migrations/0014_evidence.sql` (only if findings are stored in typed columns; if they are a JSON blob in `audits`, no migration is needed for this task, so check `src/worker/db/audits.ts` first)
- Test: `test/audit-provenance.test.ts`

- [ ] **Step 1:** Write a failing test: running the rubric over an existing HTML fixture yields findings where each has non-empty `source` (`"rule" | "pagespeed" | "ai" | "crawl"`), an ISO `observed_at`, and `confidence` in `"high" | "medium" | "low"`.
- [ ] **Step 2:** Run it, confirm it fails on missing fields.
- [ ] **Step 3:** Add the three fields as **optional** on the type first (old stored audits must still parse), populate them in each producer; rule/PageSpeed = high, AI = medium unless it cites a quote, crawl-fallback = low.
- [ ] **Step 4:** Run typecheck + tests; fix callers that the new fields touch (`graft callers <FindingProducer> --depth 2` first).
- [ ] **Step 5:** Commit `feat(audit): findings carry source, observed_at, confidence`.

### Task 1.2: Separate site quality / urgency from fit, and treat crawler failure as unknown (#2, Review Focus 1)

**Files:**
- Modify: `src/worker/scoring/scorer.ts` (`score`, `pickOffer`), score consumers in `src/worker/db/audits.ts`
- Test: extend the existing scorer test in `test/`

- [ ] **Step 1:** Failing test: an audit whose crawl failed returns `site_quality: null` and `confidence: "low"`, and `pickOffer(..., null)` behavior is unchanged (`care_plan`).
- [ ] **Step 2:** Failing test: `score()` output exposes `urgency` derived from critical-finding count and severity, independent of `site_quality`.
- [ ] **Step 3:** Implement; keep `health_score` and `opportunity_score` names stable so the report (`report/html.ts`) and `LeadTable.tsx` keep working. `business_fit` stays `null` until Phase 2.
- [ ] **Step 4:** Tests green; commit.

### Task 1.3: Show the evidence behind the top five findings in the UI (#2)

**Files:**
- Modify: `src/client/pages/LeadDetail.tsx` (findings section)
- Create: `src/client/components/EvidenceBadge.tsx`

- [ ] **Step 1:** Render source + "observed N days ago" + confidence chip on the top five findings; show an "older than 30 days" warning (Review Focus 4).
- [ ] **Step 2:** Verify in `npm run dev` via the Browser pane: open a lead, confirm chips render, a low-confidence finding is visually distinct.
- [ ] **Step 3:** Commit.

### Task 1.4: Immutable audit snapshots and diff (#53)

**Files:**
- Create: `migrations/0014_evidence.sql` (`audit_snapshots(id, business_id, audit_id, taken_at, scores_json, findings_json, screenshot_keys_json)`; index on `(business_id, taken_at)`), `src/worker/db/snapshots.ts`, `src/worker/audit/diff.ts`
- Modify: `src/worker/pipeline/lead.ts` (write a snapshot at audit completion)
- Test: `test/audit-diff.test.ts`

**Interfaces:**
- Produces: `diffFindings(prev: Finding[], next: Finding[]): { added: Finding[]; resolved: Finding[]; unchanged: Finding[] }`, matched on a stable finding key (type + URL/selector), not array position. Phases 5, 6 (#8) and 10 (#50) consume this.

- [ ] **Step 1:** Failing tests for `diffFindings`: identical sets → all unchanged; a finding removed → resolved; new → added; same type on a different URL → added and resolved (not unchanged).
- [ ] **Step 2:** Implement `diff.ts`; tests pass.
- [ ] **Step 3:** Migration + `db/snapshots.ts` (`saveSnapshot`, `listSnapshots`, `latestTwo`); failing then passing test using the existing D1 test setup.
- [ ] **Step 4:** Write a snapshot at the end of the lead pipeline; test that a re-audit produces two snapshots and a diff.
- [ ] **Step 5:** Add a minimal "Changes since last audit" list to `LeadDetail.tsx`; commit.

**Exit criteria:** top findings display provenance; failed crawl no longer lowers quality; re-audit shows a diff.

---

## Phase 2: Decide what to sell — #3 service catalog and best-first-offer, #1 ideal-client rules and fit score

**Deliverable:** an editable catalog of Logan's real services; each lead shows a "best first offer" card and a separate `business_fit` score driven by saved service profiles.

### Task 2.1: Service catalog (#3)

**Files:**
- Create: `migrations/0015_services.sql` (`services(id, key, name, category, summary, deliverables_json, prerequisites_json, first_engagement, finding_types_json, is_specialty, active)`), `src/worker/db/services.ts`, `src/worker/routes/services.ts`, `src/client/pages/Services.tsx` (or a section in `Settings.tsx`)

**Catalog decision (confirmed by Logan, 2026-10-04):** seed **all 34 services** from the agency's service menu, grouped in six categories, so options stay open. The six loganirish.com service areas are flagged `is_specialty = 1`; everything else is seeded `active = 1, is_specialty = 0` and Logan can toggle either in the UI. Services with no diagnostic mapping yet (e.g. Paid Media) have empty `finding_types_json`; they are valid fit-profile targets but never appear as a "best first offer" until a finding maps to them.

| Category | Services |
|---|---|
| Search & Visibility | SEO, Local SEO, Technical SEO, Ecommerce SEO, SEO Strategy |
| Paid Media | PPC & Paid Media, Paid Search, Paid Social, Remarketing, Display Advertising, Social Media Marketing |
| Websites | Web Design & Development, Custom Websites, Ecommerce Websites, WordPress Development, Website Accessibility, Hosting & Maintenance |
| Brand & Content | Branding, Brand Identity, Brand Messaging, Graphic Design, Content Marketing, Content Strategy, Copywriting |
| AI & Strategy | Digital Marketing, AI Marketing, AI Search Optimization, Generative Engine Optimization, AI Content Optimization, Digital Marketing Strategy |
| Growth & Optimization | Performance Marketing, Conversion Rate Optimization, Lead Generation, Analytics & Attribution |

Initial specialty flags (editable): Hosting & Maintenance (management/operations), Conversion Rate Optimization, SEO, AI Search Optimization, Web Design & Development, WordPress Development, Graphic Design. "Best first offer" ranking prefers specialty services when evidence supports more than one.
- Modify: `src/worker/index.ts` (mount router), Offer enum/type used by `scorer.ts`
- Test: `test/services.test.ts`

**Interfaces:**
- Produces: `listServices(db): Promise<Service[]>`, `serviceForFinding(findingType: string, services: Service[]): Service | null`, seeded with the services on loganirish.com (website management, operations, CRO, SEO/AI visibility, development, design) so existing offers (`new_site`, `performance`, `care_plan`, `conversion`, `seo_basics`) map to catalog keys.

- [ ] **Step 1:** Failing test for CRUD + seed; implement; pass.
- [ ] **Step 2:** Failing test for `serviceForFinding` (slow-WordPress finding → performance audit + care plan; booking-path finding → CRO project); implement; pass.
- [ ] **Step 3:** Keep the legacy `Offer` enum working via a mapping layer (do not break `report/html.ts` or stored audits); test the mapping.
- [ ] **Step 4:** Settings/Services UI: list, edit, enable/disable. Verify in the browser.
- [ ] **Step 5:** Commit.

### Task 2.2: "Best first offer" card (#3)

**Files:** Modify `src/client/pages/LeadDetail.tsx`, `src/worker/routes/leads.ts`; Create `src/client/components/BestOfferCard.tsx`

- [ ] **Step 1:** Failing route test: `GET /api/leads/:id` includes `best_offer: { service, because: Finding[] }` using `serviceForFinding` over top findings.
- [ ] **Step 2:** Implement; render the card (service, likely deliverables, prerequisites, supporting findings); verify in browser; commit.

### Task 2.3: Service profiles and fit score (#1)

**Files:**
- Create: `migrations/0016_fit_profiles.sql` (`fit_profiles(id, service_key, industries_json, geos_json, size_signals_json, platforms_json, active)`), `src/worker/scoring/fit.ts`, `src/worker/db/fit.ts`
- Modify: `src/worker/scoring/scorer.ts` (populate `business_fit`), `src/client/components/LeadTable` / `LeadTable.tsx` (column + sort)
- Test: `test/fit.test.ts`

**Interfaces:**
- Produces: `scoreFit(business, audit, profiles): { fit: number | null; matched: string[]; missing: string[] }` — transparent: returns which criteria matched.

- [ ] **Step 1:** Failing tests: business matching industry+geo scores higher than one matching only geo; no profiles saved → `fit: null` (not 0); platform detected from CMS signal matches a WordPress-care profile.
- [ ] **Step 2:** Implement `scoreFit`; pass.
- [ ] **Step 3:** Three seeded starter profiles (WordPress care, CRO, redesign) editable in the UI; "why this fit" tooltip lists `matched`/`missing`.
- [ ] **Step 4:** Commit.

**Exit criteria:** lead table sorts by fit; fit is explained; fit never silently reads 0 when no profiles exist.

---

## Phase 3: Make daily prospecting faster — #6 imports, #7 suppression, #5 quick scan, #42 batch triage, #41 next-action queue

### Task 3.1: Suppression and ownership lists (#7)

**Files:** Create `migrations/0017_suppression.sql` (`suppressions(id, kind, value, reason, created_at)` — kind: `domain | place_id | name`), `src/worker/db/suppression.ts`; Modify `src/worker/pipeline/search.ts`, `src/worker/radar-run.ts`, `src/worker/routes/leads.ts` (draft routes), `src/client/pages/Settings.tsx`; Test `test/suppression.test.ts`

- [ ] **Step 1:** Failing tests: `isSuppressed(db, business)` matches normalized domain (`www.`, scheme, trailing slash stripped) and place ID.
- [ ] **Step 2:** Failing integration tests (Review Focus 3): a search result, a radar-found business, and an import row for a suppressed domain are each excluded; the drafter route refuses with a clear 409.
- [ ] **Step 3:** Implement and apply the filter at all three entry points; one shared `normalizeDomain` helper (also used by Task 3.2).
- [ ] **Step 4:** Settings UI for adding/removing entries; "mark as client / opt-out / competitor" action on LeadDetail writes a suppression. Commit.

### Task 3.2: Add by URL or CSV with ambiguity review (#6)

**Files:** Create `src/worker/import/match.ts`, `src/worker/routes/import.ts`, `src/client/pages/Import.tsx`; Modify `src/worker/db/businesses.ts` (reuse `upsertBusiness`, 12 callers — do not change its signature; add a `findMatches`), `src/worker/index.ts`; Test `test/import-match.test.ts`

**Interfaces:**
- Produces: `matchBusiness(row, existing[]): { kind: "new" | "exact" | "ambiguous"; candidates: Business[] }`

- [ ] **Step 1:** Failing tests for the Review Focus 2 cases: exact domain → `exact`; same name different domain → `ambiguous`; `http://www.x.com/` vs `https://x.com` → `exact`; two identical rows in one CSV → second is `exact` of the first (dedupe within file).
- [ ] **Step 2:** Implement `matchBusiness`; pass.
- [ ] **Step 3:** Route: `POST /api/import/preview` returns per-row classification; `POST /api/import/commit` writes only `new` and user-resolved rows; suppressed rows are reported, not imported. Tests for both.
- [ ] **Step 4:** UI: paste URL or upload CSV, review table, resolve ambiguous rows. Source recorded as `import`/`referral`. Commit.

### Task 3.3: Two-stage audit spending (#5)

**Files:** Modify `src/worker/pipeline/lead.ts`, `src/worker/workflows.ts`, `src/worker/cost.ts`, `src/worker/db/audits.ts`; migration `0018_quick_scan.sql` (`scan_stage` on businesses: `listed | quick | full`); Test `test/quick-scan.test.ts`

- [ ] **Step 1:** Failing test: quick stage runs crawl-light + rule checks only (no browser screenshots, no AI call, no PageSpeed) and records its cost in `cost.ts`.
- [ ] **Step 2:** Failing test: leads at/above the fit threshold (Task 2.3; null fit never auto-promotes) are queued for full scan; any lead can be promoted manually.
- [ ] **Step 3:** Implement; "Promising leads" queue view with one-click "run full scan". Preserve the monthly spend cap behavior. Commit.

### Task 3.4: Batch triage and saved filters (#42)

**Files:** Modify `src/client/pages/AllLeads.tsx`, `LeadTable.tsx`, `SearchDetail.tsx`, `src/worker/routes/leads.ts`; migration `0019_saved_filters.sql`; Test `test/leads-bulk.test.ts`

- [ ] **Step 1:** Failing tests: `POST /api/leads/bulk { ids, action }` for status/tag/archive; archive is soft (`archived_at`, already in `0003_crm.sql`) and has an undo endpoint; bulk delete is not offered.
- [ ] **Step 2:** Implement route; checkbox selection + action bar; saved filters persisted. Verify in browser. Commit.

### Task 3.5: Next-action queue (#41)

**Files:** Create `src/worker/routes/today.ts`, `src/client/pages/Today.tsx`; Modify `src/worker/index.ts`, nav; Test `test/today.test.ts`

- [ ] **Step 1:** Failing test: `GET /api/today` returns items ordered by urgency from `follow_up_at` due/overdue, unanswered drafts (draft history, no activity after), stalled deals (status unchanged N days with `deal_value`); each item has `reason` and `lead_id`. Reply and change-alert sources are added in Phase 6 behind the same item shape.
- [ ] **Step 2:** Implement; page with "done / snooze" actions writing `activity`. Commit.

**Exit criteria:** import a CSV with an ambiguous row, bulk-archive low-fit leads, and see today's list.

---

## Phase 4: Make the pitch distinctively Logan — #32 teaser, #33 case-study matching, #34 scoped proposal

- **#33 first** (needs a curated portfolio): `case_studies` table (title, URL, business model tags, service keys, one factual sentence, approved metrics, `claim_approved`), `matchCaseStudy(business, service)`; only `claim_approved` text is ever inserted into emails/reports. Files: `src/worker/db/caseStudies.ts`, `src/worker/routes/caseStudies.ts`, Settings UI; hook into `drafter/prompt.ts`.
- **#32 teaser:** new public-safe renderer `src/worker/report/teaser.ts` (one screenshot, 2–3 verified issues from Phase 1 provenance filtered to `confidence ≥ medium`, one strength, the Phase 2 best-first-offer) served through the existing `routes/public.ts` share-link mechanism. Every claim links to its evidence.
- **#34 proposal builder:** `proposals` table (lead, selected findings, discovery scope, deliverables, exclusions, timeline assumptions, optional care plan, price range set by Logan), `src/worker/report/proposal.ts` rendering HTML/PDF alongside `report/html.ts`. Price is always manually entered, never generated.
- **Tests:** teaser excludes low-confidence findings; proposal never renders without a price range; case-study matcher returns `null` rather than an unapproved claim.

**Exit criteria:** from a lead: generate teaser → attach matched case study to the email draft → build a scoped proposal.

---

## Phase 5: High-value diagnostics — #14, #15, #17, #18, #24

Each follows the **standard diagnostic module pattern** above.

| # | Module | Notes |
|---|---|---|
| 15 | `audit/local-consistency.ts` | Extends the CRO listing comparison; output is exact mismatched fields (name/address/phone/hours/service area/booking URL). Do first; smallest and reuses existing evidence. |
| 14 | `audit/technical-seo.ts` | sitemap/robots discovery, canonical/indexability, redirect chains, duplicate title/H1 patterns, internal-link depth over a bounded crawl (cap pages per site). Report observed facts only; never "indexed/not indexed". |
| 17 | `cro/evidence/a11y-worklist.ts` | Convert existing axe summary into per-page worklist with screenshot refs, template grouping, likely fix, manual QA checklist. Copy must say "automated scan, not a complete WCAG audit". |
| 18 | `audit/wordpress-public.ts` | Confident-CMS gate first; broken assets, stale content dates, heavy plugin assets; "old version clue" flagged `confidence: medium` and phrased as a question; never names a vulnerable plugin. |
| 24 | `cro/evidence/task-walkthrough.ts` | Extends the primary-CTA probe: named tasks per business model, count steps/dead ends/handoffs; **read-only — never submits forms**. Test asserts no `form.submit`/POST is issued in a fixture run. |

Wire each into the pipeline, map finding types into the Phase 2 catalog, and add rendering to `LeadDetail.tsx` and the report. Order: 15 → 14 → 17 → 24 → 18.

---

## Phase 6: Close the loop — #36 follow-ups, #37 Gmail sync, #35 angle variants, #8 change alerts

- **#37 Gmail conversation sync first** (#36 needs it to stop on reply): read-only Gmail scope addition in `src/worker/google/`, matcher `matchThread(thread, leads)` returning `{ lead, confidence }`; only `confidence: high` auto-logs `activity`; ambiguous threads go to a review list and **never change status** (Review Focus 5). Needs the OAuth scope bump and a re-consent note in Settings.
- **#36 follow-up sequence:** 2–3 drafts generated up front with new value each time, each a Gmail draft created on its due date and surfaced in the Phase 3 `today` queue; sequence state machine `pending → drafted → sent_by_user | stopped`, stopped on reply, opt-out (Phase 3 suppression) or manual stop. Tests cover every stop condition.
- **#35 angle variants:** extend `drafter/prompt.ts` to produce distinct angles (conversion, technical risk, design credibility, local visibility, ongoing care); store chosen angle on the draft; replies recorded against angle for Phase 9's #46. No causal claims in the UI.
- **#8 change alerts:** build on `radar-run.ts` + Phase 1 `diffFindings`; watchlist flag on leads; one digest per run containing only changed items with before/after evidence; items also feed the `today` queue.

---

## Phase 7: Extended diagnostics and context

**7a — site diagnostics (standard module pattern):** #16 CrUX field data (explicit "insufficient field data" state), #20 domain/hosting checks (TLS expiry, DNS/email-auth records, headers; no "site is secure" claims), #21 AI answer readiness, #22 content/IA gap map, #23 design-consistency audit (annotated examples, no single design score), #26 third-party burden (extends CRO marketing-tool detection with byte/blocking attribution).

**7b — prospect context:** #9 comparable peer set (editable 3–5 peers, objective metrics only), #10 growth-signal queue (each signal stores source + date), #12 multi-location account view (`parent_business_id`, location-level records stay distinct), #27 review theme research (source-attributed; stars alone never imply a budget).

**7c — #11 ads-to-site mismatch** (L, own phase): public ad library / ad-visible SERP discovery, then **verify the real landing destination with the existing crawler before any claim**. Spike first: confirm a permitted public data source exists before building.

---

## Phase 8: Client-authorized data — #29, #30, #31, #19, #25

**Gate:** start only when a prospect has become a client and grants access. Add a `connections` model (per-lead, OAuth tokens encrypted in D1 or a vault reference; prospect scans remain public-only — enforced by a test that no prospect-scan code path reads a connection).
- #29 Search Console OAuth + query/page/indexing/sitemap evidence.
- #30 GA4 Data API funnel baselines; unknown tracking states shown as unknown.
- #31 Measurement readiness audit (verify events fire and count).
- #19 Connected WordPress care audit (Site Health, updates, backups, cron, admin hygiene, staging) via an authorized connector.
- #25 Lead-leakage check: synthetic form/booking submissions **only** with a stored client consent record and a client-controlled test inbox; test refuses to run without consent.

---

## Phase 9: Sales intelligence and integrations — #4, #38, #39, #40, #43, #44, #45, #46, #54

Order: #43 sales board (stage criteria) → #44 discovery-call brief → #45 reply/objection library (stores exact conversation) → #4 correction reasons + monthly calibration view (**review only; no auto weight changes**) → #46 source-to-revenue view (needs #35 angle + #43 stages + deal value + time tracking) → #38 recipient intelligence (source-attributed, never invented addresses) → #54 CSV export/webhook with stable IDs and source timestamps → #40 inbound self-audit on LoganIrish.com (consent + source attribution, rate-limited) → #39 visual concept (opt-in, edited before prospect sees it).

---

## Phase 10: Client lifecycle — #47, #48, #49, #50, #51, #52

Order: #47 onboarding handoff (checklist; credentials never stored in notes) → #49 roadmap execution tracker (CRO roadmap items become tasks carrying their original evidence) → #48 maintenance monitor (scheduled uptime/TLS/backups/updates/links/performance/lead-path checks, regression alerts, monthly change log) → #50 before/after results (baseline snapshots from Phase 1; shows what cannot be attributed) → #51 renewal/expansion prompts → #52 referral workflow (client-approved case study feeds Phase 4 matcher; referrals recorded as leads with original source).

---

## Phase 11: Gated, build on demand

- **#13 Market coverage map:** after enough searches exist to make it useful; only if it changes which search Logan runs next.
- **#28 Commerce/complex booking journeys:** non-transactional only, never places an order.
- **#55 Collaborative accounts:** only when a second user exists.

---

## Per-phase definition of done

1. Detailed phase plan written and reviewed before coding.
2. All tasks follow test-first: failing test → minimal implementation → green → commit.
3. `npm run typecheck && npm test` green; new migration applies on a fresh local D1.
4. UI changes verified in `npm run dev` through the Browser pane (golden path + one failure path).
5. `graft build` run; `docs/product-opportunity-map.md` status table updated for the shipped features.
6. Review Focus items for that phase have passing tests.

## Self-review

- **Spec coverage:** every feature #1–#55 appears once in the coverage table; the recommended sequence in the map (restore baseline → daily prospecting → distinct pitch → verticals → close the loop) is preserved, with #53 pulled forward and P3 items gated.
- **Placeholders:** Phases 4–11 are intentionally feature-level; each one is expanded into a code-level plan at its start, because they consume interfaces (`diffFindings`, `serviceForFinding`, `scoreFit`, `matchBusiness`, suppression helper) created earlier.
- **Interface consistency:** names defined in Phases 1–3 are the ones referenced in Phases 4–10.
- **Known unknowns to resolve at phase start:** whether findings are a JSON blob or typed columns (Task 1.1); exact router mount pattern in `src/worker/index.ts`; Gmail OAuth scope re-consent flow (Phase 6); data-source legality for #11 (Phase 7c).
