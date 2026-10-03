# Audit v2, Shareable Report, Radar — Implementation Plan

**Date:** 2026-10-03
**Branch:** `feat/audit-v2-report-radar`
**Baseline:** 152 tests passing (`npm test`); `npm run typecheck` has one pre-existing error in `scripts/prompt-check.ts` (missing Node types) — do not fix, do not add new ones.

## Goal

Raise the reply rate of outreach by (a) auditing more of what a prospect's site gets wrong, with evidence, (b) letting Logan send the prospect a branded report link, (c) re-running searches on a schedule so new leads arrive without manual searching.

## Non-goals (decided)

- No screenshots, no AI "ugliness"/visual scoring. Every finding must be evidence-backed and checkable.
- No automated sending. No paid SEO APIs (DataForSEO/Semrush/Ahrefs).
- Deferred: branded-search SERP check, RDAP domain-expiry, CSV export.

## Global rules for every task

1. TDD: write the failing test first, see it fail, implement, see it pass.
2. Commit once per task on branch `feat/audit-v2-report-radar` (never switch branches, never push). Conventional message (`feat:`/`test:`), ending with these two trailer lines after a blank line:
   `Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>`
   `Claude-Session: https://claude.ai/code/session_01PP6UHrXf4PdWZSqcBsAaaF`
3. Verify with `npm test` (all pass, count only goes up) and `npm run typecheck` (only the known pre-existing `scripts/prompt-check.ts` error allowed).
4. Match surrounding style: 2-space indent, double quotes, dense one-line helpers, comments only to explain *why*. D1 via prepared statements; request bodies validated with zod; use `chunks` from `src/worker/db/chunks.ts` for `IN (...)` lists.
5. Migrations: add a new numbered file in `migrations/` (next free number), additive only (`ALTER TABLE ... ADD COLUMN` / `CREATE TABLE`). Tests apply migrations automatically via `test/apply-migrations.ts`.
6. **Findings are quoted by the email drafter.** Evidence text must be plain English a business owner understands: no "LCP", "CLS", "meta description", "JSON-LD", "Lighthouse", "viewport". Drafter rule "no claim without a supporting finding" must stay true.
7. **No false positives from JS-rendered sites.** The crawler parses static HTML only. Any "X is missing" finding derived from crawler HTML must be suppressed when the page looks client-rendered (see Task 4). Prefer Lighthouse (which renders JS) for presence checks.
8. Do not touch unrelated files. No refactors beyond what the task needs.

## Domain model changes at a glance

- `FindingGroup` gains `"seo"` and `"local"`. Offer selection: `seo` and `local` points count toward the `seo_basics` bucket (same as `basics`). Tie-break order unchanged.
- New groups are capped in scoring (`GROUP_CAPS` in `scoring/config.ts`: seo 20, local 15) so score does not inflate. Existing groups stay uncapped so existing scores/tests do not change. Total still capped at 100.

---

## Task 1 — Platform detection

**Files:** `src/worker/crawler/extract.ts`, `src/worker/crawler/crawl.ts`, `src/worker/scoring/scorer.ts` (CrawlFacts type only), `src/worker/types.ts`, `src/worker/db/audits.ts`, `src/worker/pipeline/lead.ts`, `migrations/0002_platform.sql`, tests (`test/extract.test.ts`, `test/crawl.test.ts`, `test/db.test.ts`, `test/pipeline-lead.test.ts`).

**Build:**
- `detectPlatform(html: string): Platform` exported from `extract.ts`, `type Platform = "wix" | "squarespace" | "godaddy" | "wordpress" | "weebly" | "shopify" | "webflow" | "other"`. Signals: `<meta name="generator">` content, and asset/host markers (`static.wixstatic.com`/`wix.com`, `squarespace.com`/`sqsp`, `img1.wsimg.com`/`godaddy` website builder, `/wp-content/`, `weebly.com`, `cdn.shopify.com`, `webflow` classes/`assets.website-files.com`). Return `"other"` when nothing matches. Add `platform` to `PageFacts` (home page only is used).
- `CrawlFacts.platform: Platform` populated from the homepage. Null `facts` (blocked/no site) → audit platform null.
- Migration adds `audits.platform TEXT`. `Audit`/`AuditInsert` get `platform: string | null`. `insertAudit` and `lead.ts` persist it.
- **Does not change scoring.** Metadata only (used for filtering and display).

**Acceptance:** unit tests with small HTML snippets for each platform + `other`; generator-meta wins over asset markers; audit round-trips `platform` through D1; `runLead` persists it.

## Task 2 — Lead table filters

**Files:** `src/client/types.ts`, `src/client/pages/LeadTable.tsx`, new `src/client/leadFilters.ts` (pure, testable), `src/worker/routes/leads.ts` (`leadRows` adds `platform`, `rating`, `reviewCount` flat fields), `test/leadfilters.test.ts` (new), `test/routes.test.ts`.

**Build:**
- `leadRows` returns `platform: string | null` (from latest audit), plus `rating` and `reviewCount` (from the business row) in each row.
- Client `Business` type gains `rating`, `review_count`. `LeadRow` gains `platform`, `rating`, `reviewCount`.
- Pure `applyLeadFilters(rows, f)` in `leadFilters.ts`; `LeadTable` uses it. New filters (keep existing three): **Min reviews** (number), **Max rating** (number, 0–5, empty = off), **Offer** (select: any / new_site / performance / care_plan / seo_basics), **Platform** (select built from platforms present in rows, plus "any"). Rows with null rating/reviews are excluded only when the corresponding filter is set.
- Show platform as a small muted line under the website URL in the table.

**Acceptance:** `applyLeadFilters` unit-tested for each filter, combinations, and null handling; `GET /api/leads` and `GET /api/searches/:id` include the new fields.

## Task 3 — Lighthouse SEO + accessibility categories, new finding groups

**Files:** `src/worker/pagespeed.ts`, `src/worker/scoring/scorer.ts`, `src/worker/scoring/config.ts`, `src/worker/types.ts`, `src/worker/db/audits.ts`, `src/worker/pipeline/lead.ts`, `migrations/0003_lighthouse_scores.sql`, `src/client/pages/LeadDetail.tsx` (display), tests (`test/pagespeed.test.ts`, `test/scorer.test.ts`, `test/db.test.ts`, `test/pipeline-lead.test.ts`).

**Build:**
- `runPageSpeed` requests `category=performance&category=seo&category=accessibility` (repeat the param) in the **same single call**. Extend `PageSpeedFacts` with `seoScore: number | null`, `accessibilityScore: number | null` (0–100, null if category missing), `seoIssues: string[]`, `accessibilityIssues: string[]` — plain-English labels for the failing audits, via an explicit map of Lighthouse audit id → label, e.g. `meta-description` → "no search-results summary", `document-title` → "no page title", `image-alt` → "images without descriptions", `link-text` → "links that just say 'click here'", `is-crawlable` → "blocked from Google", `canonical` → "no preferred page address set", `color-contrast` → "text that's hard to read against its background", `label` → "form fields without labels". Unknown failing audit ids are ignored (never surfaced raw). An audit "fails" when `score !== null && score < 0.9`. Keep existing performance parsing and the `passes()` semantics unchanged.
- Add `"seo" | "local"` to `FindingGroup`; add finding codes `low_seo_score` and `low_accessibility` (group `seo` and `basics` respectively). Weights in `config.ts`: `low_seo_score` 12 when seoScore < 70 (evidence: "Google's own check found problems that hurt how the site shows up in search: <first 3 seoIssues joined>"; if no mapped issues, "Google's own check scored the site's search-friendliness at N/100"); `low_accessibility` 6 when accessibilityScore < 70 (evidence "Parts of the site are hard to read or use for some visitors (<first 2 issues>)" — never say "ADA" or "compliant"). Add `GROUP_CAPS = { seo: 20, local: 15 }` and apply per-group capping in `score()` for capped groups only; existing groups unchanged.
- Offer selection: add seo + local points to the basics bucket.
- Migration adds `audits.seo_score INTEGER`, `audits.accessibility_score INTEGER`; persist via `AuditInsert`/`insertAudit`/`lead.ts`.
- `LeadDetail.tsx`: show SEO and accessibility scores next to the existing PageSpeed figure when non-null.

**Acceptance:** `pagespeed.test.ts` asserts the request URL contains all three categories and parses a fixture response that includes `seo`/`accessibility` categories and failing audits; missing categories → nulls (not 0). Scorer tests: thresholds, evidence text, group cap, offer bucket, all existing scorer tests unchanged and passing.

## Task 4 — Extra HTML facts in the page extractor

**Files:** `src/worker/crawler/extract.ts`, `test/extract.test.ts`, new fixtures in `test/fixtures/html/` as needed.

**Build** — extend `PageFacts` (pure functions on already-fetched HTML; no new fetches):
- `h1Count`, `wordCount` (visible text words, excluding script/style/nav-agnostic — keep simple: `structuredText` words), `imageCount`, `imagesMissingAlt` (img with absent/empty alt, excluding `role="presentation"`/decorative `alt=""` is *counted as having alt* — only a missing attribute counts as missing), `hasTelLink` (`a[href^="tel:"]`), `hasLocalBusinessSchema` (any `script[type="application/ld+json"]` whose parsed JSON — tolerate arrays/`@graph` and invalid JSON — contains an `@type` that is or ends with `LocalBusiness`, or a known LocalBusiness subtype list such as Plumber, Restaurant, Dentist, Electrician, HVACBusiness, RealEstateAgent, LegalService, AutoRepair, BeautySalon, HealthAndBeautyBusiness, Store, ProfessionalService), `mixedContentCount` (on an https page: `src`/`href` of `img|script|link[rel=stylesheet]|iframe` starting `http://`), `datedBuildMarkers: string[]` — any of: `font` tag, `marquee`/`blink` tag, `frameset`/`frame`, `embed`/`object` for Flash (`.swf`), layout tables (a `table` with ≥ 3 nested cells containing block content *and* `cellspacing`/`cellpadding`/`bgcolor` attributes — be conservative), jQuery loaded from a `script src` whose version is < 1.12 or Flash, `<center>` tag. Values are short human labels, e.g. "old-style font tags".
- `isLikelyJsRendered: boolean` — true when visible text is under 200 characters **and** the body contains a typical SPA mount node (`#root`, `#app`, `#__next`, `#___gatsby`, `ng-app`/`<app-root>`), **or** the platform detection says wix/squarespace/webflow/shopify (so absence checks are unreliable there). (Task 1 added `detectPlatform`; reuse it.)

**Acceptance:** one focused unit test per fact plus a negative case; an invalid JSON-LD block does not throw; `isLikelyJsRendered` true for an SPA shell, false for a normal static page. No change to existing exports' behavior; all existing extract tests pass.

## Task 5 — Crawler wiring and new findings

**Files:** `src/worker/crawler/crawl.ts`, `src/worker/scoring/scorer.ts`, `src/worker/scoring/config.ts`, `src/worker/types.ts`, tests (`test/crawl.test.ts`, `test/scorer.test.ts`).

**Build:**
- Extend `CrawlFacts` with: `h1Count`, `wordCount`, `imageCount`, `imagesMissingAlt`, `hasTelLink` (any crawled page), `hasLocalBusinessSchema` (any page), `mixedContentCount` (home), `datedBuildMarkers` (home, de-duplicated), `isLikelyJsRendered` (home), `hasRobotsTxt`, `hasSitemap`, `httpRedirectsToHttps: boolean | null`.
- Site-level checks in `crawlSite`, each with the existing 10 s timeout helper `get()`, failures never fail the crawl: `GET /robots.txt` (treat 200 with non-HTML content or 200 text as present; 404/410 absent; any error → `null` → no finding), `HEAD`/`GET /sitemap.xml` (same logic; also accept a `Sitemap:` line in robots.txt), and for sites whose final URL is https, `GET http://<host>/` with `redirect: "manual"` — `true` if a 301/302/307/308 `Location` starts with `https://`, `false` if it returns 200 HTML, `null` on error. These fetches must go through `o.fetch` so tests can fake them.
- New finding codes, groups, weights, thresholds in `config.ts`:
  - `no_click_to_call` (local, 8): phone number found on site (any page's `phones`) **but** `!hasTelLink`. Evidence: "Their phone number isn't tappable on a phone, so visitors have to copy and paste it". Requires adding "any phone found" to `CrawlFacts` (`hasPhone`).
  - `no_local_schema` (local, 5): `!hasLocalBusinessSchema` and **not** `isLikelyJsRendered`. Evidence: "The site doesn't tell Google its business name, address and hours in a way Google can read".
  - `thin_content` (seo, 5): `wordCount < 150` and not JS-rendered. Evidence: "The homepage has very little text (about N words), which gives Google little to show".
  - `no_h1` (seo, 3): `h1Count === 0` and not JS-rendered. Evidence: "The homepage has no main heading".
  - `missing_alt` (seo, 4): `imageCount >= 4` and missing ≥ 50%, not JS-rendered. Evidence: "N of M images have no description, so Google and screen readers can't tell what they show".
  - `no_sitemap` (seo, 3): `hasSitemap === false`. Evidence: "There's no sitemap, so Google may miss pages".
  - `mixed_content` (basics, 6): `mixedContentCount >= 1`. Evidence: "The page loads some content insecurely, which can trigger browser warnings".
  - `no_https_redirect` (basics, 6): `httpRedirectsToHttps === false`. Evidence: "Visiting the site without https doesn't send people to the secure version".
  - `dated_build` (stale, 10): `datedBuildMarkers.length >= 1`. Evidence: "The site is built with outdated techniques (<up to 2 labels>)".
- `FindingCode` union extended. `GROUP` map in scorer updated. `GROUP_CAPS` (Task 3) already limits seo/local; `no_https_redirect` + `mixed_content` are in `basics` (uncapped) — acceptable.
- No schema change (findings persist as JSON).

**Acceptance:** crawl tests with a fake fetcher cover robots/sitemap/redirect present/absent/error; JS-rendered fixture produces **no** absence-based findings; scorer tests for every new finding incl. suppression rules and group caps; existing tests unchanged and passing.

## Task 6 — Shareable audit report

**Files:** new `migrations/0004_reports.sql`, `src/worker/db/reports.ts`, `src/worker/routes/reports.ts`, `src/worker/index.ts`, `src/worker/auth.ts`, `src/worker/db/settings.ts`, `src/worker/routes/settings.ts`, `src/client/App.tsx`, `src/client/api.ts`, new `src/client/pages/Report.tsx`, `src/client/pages/LeadDetail.tsx`, `src/client/pages/Settings.tsx`, `src/client/types.ts`, tests (`test/reports.test.ts`, `test/auth.test.ts`).

**Build:**
- Table `audit_reports(token TEXT PRIMARY KEY, business_id TEXT NOT NULL, audit_id TEXT NOT NULL, created_at TEXT NOT NULL, expires_at TEXT NOT NULL, revoked INTEGER NOT NULL DEFAULT 0)` + index on `business_id`. Settings gains `logo_url TEXT NOT NULL DEFAULT ''` (same migration). Tokens: 32 random bytes, base64url, from `crypto.getRandomValues`. Default expiry 30 days.
- Authenticated: `POST /api/leads/:id/report` → creates a report for the business's latest audit (404 if no audit; reuse an existing non-expired, non-revoked report for the same audit instead of creating duplicates) → `{ token, url: "/r/<token>", expiresAt }`; `DELETE /api/leads/:id/report` revokes all of that business's reports.
- Public (no cookie): `GET /api/public/report/:token` → 404 for unknown/expired/revoked (same body for all three so tokens can't be probed), else a **sanitized** JSON payload: `{ businessName, auditedAt, score, findings: [{ severity, evidence }] (plain-English evidence only; no codes/points/internal ids), sender: { name, businessName, email, logoUrl }, expiresAt }`. **Never** include contacts, notes, lead status, raw R2 data, place ids, other businesses, or the drafter's output. Response headers: `X-Robots-Tag: noindex, nofollow`, `Cache-Control: no-store`. Public routes are exempted in `requireAuth` by an explicit prefix match on `/api/public/` (add a unit test proving other `/api/*` paths stay protected).
- Client: `/r/:token` route in `App.tsx` that renders `Report.tsx` **outside** the auth gate (check how `App.tsx` currently gates on login and keep everything else gated). Clean, printable, mobile-friendly page: business name, score ring/number, findings list with severity, sender block with logo (only if `logo_url` is an `https://` URL), `<meta name="robots" content="noindex">` set on mount. Score copy must not claim certainty beyond the findings ("Based on a automated check on <date>").
- `LeadDetail.tsx`: "Create report link" button → copies the absolute URL (`location.origin + url`) to clipboard and shows it; "Revoke link" when one exists. `Settings.tsx`: Logo URL field (https only, validated server-side with zod).

**Acceptance:** tests for create/reuse/revoke, public fetch happy path, expired/revoked/unknown identical 404, payload contains no forbidden fields (assert exact key set), auth middleware still blocks other `/api/*` without a cookie, settings rejects non-https logo.

## Task 7 — Radar (saved, scheduled searches)

**Files:** new `migrations/0005_radar.sql`, `src/worker/db/radar.ts`, `src/worker/routes/radar.ts`, `src/worker/radar-run.ts`, `src/worker/index.ts`, `wrangler.jsonc`, `src/client/App.tsx`, new `src/client/pages/Radar.tsx`, `src/client/pages/NewSearch.tsx`, `src/client/api.ts`, `src/client/types.ts`, tests (`test/radar.test.ts`, `test/health.test.ts` if affected).

**Build:**
- Table `radars(id TEXT PRIMARY KEY, location TEXT NOT NULL, business_type TEXT NOT NULL, radius_km REAL NOT NULL, max_results INTEGER NOT NULL, interval_days INTEGER NOT NULL DEFAULT 30, enabled INTEGER NOT NULL DEFAULT 1, next_run_at TEXT NOT NULL, last_run_at TEXT, last_search_id TEXT, last_error TEXT, created_at TEXT NOT NULL)`.
- `radar-run.ts` exports `runDueRadars(env, now)` (injectable deps for tests: db, a `startSearch(searchId)` function, `now`). For each enabled radar with `next_run_at <= now`: skip with `last_error` set (and **do not** advance `next_run_at` beyond a retry in 1 day) if `mailingSettingsMissing` or `checkSpend(estimateSearchCost(max_results))` is not ok; otherwise `createSearch`, start the `SEARCH_WORKFLOW` (`search-<id>`), set `last_run_at`, `last_search_id`, `next_run_at = now + interval_days`, clear `last_error`. One failing radar must not stop the others. Same spend/compliance guards the manual search route uses.
- `src/worker/index.ts` default export becomes `{ fetch: app.fetch, scheduled }` (keep the named workflow exports and keep `app` behavior identical; update any test that imports the default). `scheduled` calls `runDueRadars`. `wrangler.jsonc`: `"triggers": { "crons": ["17 13 * * *"] }` (daily; radars decide if due).
- API (authenticated): `GET /api/radar` (list, with `newLeadCount` for the radar's last search = businesses whose `first_seen_search_id` equals `last_search_id`), `POST /api/radar` (zod: same fields as NewSearch + `intervalDays` 7–90 default 30; first `next_run_at` = now + interval_days unless `runNow: true` → now), `PATCH /api/radar/:id` (`enabled`, `intervalDays`), `DELETE /api/radar/:id`, `POST /api/radar/:id/run` (run now, honoring guards, returns 402 `spend limit`/400 compliance exactly like `POST /api/searches`).
- Client: nav link "Radar"; `Radar.tsx` lists radars (location, type, interval, next/last run, last error, new-lead count linking to `/searches/<last_search_id>`), enable toggle, run-now, delete; `NewSearch.tsx` gets a "Repeat every [30] days (Radar)" checkbox that, when checked, POSTs to `/api/radar` in addition to running the search now.

**Acceptance:** `runDueRadars` tests: due vs not due, spend-limit block (not advanced past retry, error recorded), missing mailing settings block, one failure isolated, success advances `next_run_at` by `interval_days`; route tests incl. validation and 402; `GET /api/health` still passes.

## Task 8 — Email-domain DNS checks (MX / SPF / DMARC)

**Files:** new `src/worker/dns.ts`, `src/worker/pipeline/lead.ts`, `src/worker/crawler/crawl.ts` (only if needed for the domain), `src/worker/scoring/scorer.ts`, `src/worker/scoring/config.ts`, `src/worker/types.ts`, `src/client/pages/LeadDetail.tsx`, tests (`test/dns.test.ts`, `test/scorer.test.ts`, `test/pipeline-lead.test.ts`).

**Build:**
- `lookupMailDns(domain, fetch)` using Cloudflare DNS-over-HTTPS JSON (`https://cloudflare-dns.com/dns-query?name=<n>&type=<MX|TXT>` with `accept: application/dns-json`, 5 s timeout) → `{ hasMx: boolean | null, hasSpf: boolean | null, hasDmarc: boolean | null }` (null = lookup failed; never throw). SPF = a TXT record starting `v=spf1`; DMARC = TXT at `_dmarc.<domain>` starting `v=DMARC1`.
- New `lead.ts` step `dns` (own `step.do`, after crawl, using `business.domain`; skip when there is no domain) feeding the scorer as optional `mailDns`.
- Findings: `no_email_auth` (basics, 4): `hasMx === true` and (`hasSpf === false` or `hasDmarc === false`); evidence "Emails sent from their own address may land in customers' spam folders". `no_mail_records` is **not** a score finding: store a warning string on the lead detail instead — add `mail_warning TEXT` to `audits` via migration `0006_mail_dns.sql`; set to "This domain has no mail records, so emails to its addresses will likely bounce" when `hasMx === false`; `LeadDetail.tsx` shows it with the existing ⚠ style. Do not change recipient ranking.

**Acceptance:** `dns.test.ts` with a fake fetch for MX/TXT present, absent, malformed, timeout → nulls; scorer and pipeline tests for the finding and the warning; the DNS step failing never fails the lead.

## Task 9 — Docs and finish

**Files:** `README.md`, `docs/superpowers/specs/2026-10-02-site-search-design.md` (append a short "v2 additions" section: new finding table, report, radar, cron trigger, new migrations), `scripts/tone-notes.txt` untouched.

**Build:** README gains: Radar cron note (`wrangler.jsonc` triggers, daily), report links (public, noindex, 30-day expiry, revoke), Settings logo URL, and "run `npm run db:migrate:remote` before deploy (migrations 0002–0006)". Spec doc: new findings table with weights, group caps, offer-bucket rule, JS-render suppression rule. Run the full test suite and typecheck one last time.

---

## Execution order

1 → 2 → 3 → 4 → 5 → 6 → 7 → 8 → 9. Strictly sequential (shared files: `types.ts`, `scorer.ts`, `lead.ts`, `audits.ts`). After each task: spec-compliance review, then code-quality review, fixes, re-review. After Task 9: one final whole-branch review.

## Open items to verify with a real response (not blockers)

- The PageSpeed fixture in `test/` is hand-built. `mobileFriendly` depends on Lighthouse audit ids `viewport`, `font-size`, `tap-targets`; `passes()` returns true when an audit id is absent, so if Lighthouse dropped any of them that check silently passes. Capture one real PageSpeed response for a known site and confirm audit ids before relying on `not_mobile_friendly` and the new SEO/accessibility labels.
