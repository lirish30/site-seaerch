# Site Search — Design Spec

**Date:** 2026-10-02
**Status:** Approved in brainstorming, pending written-spec review
**Owner:** Logan Irish (single user)

## 1. Purpose

A personal, hosted tool that finds local businesses whose websites need a web developer/manager, audits those sites, and drafts a tailored cold-outreach email for each — so Logan can find freelance clients faster.

**Success criteria (v1):**
- Enter a location + business type, get a scored lead list within a few minutes.
- Each lead shows concrete, evidence-backed findings and the best contact found.
- Each worthwhile lead has a ready-to-edit email draft that cites real findings, sounds like Logan, and is CAN-SPAM compliant.
- Lead status is tracked so the same business is never pitched twice by accident.

**Decisions made:**
| Topic | Decision |
|---|---|
| Lead type | Cold prospects only (no job boards) |
| Listing data | Paid scraper service; Bright Data first, swappable |
| Interface | Hosted web app, single-user password |
| Platform | Cloudflare (Workers, Workflows, D1, R2) |
| Audit signals | Speed & mobile, stale content, basics & SEO. **No** visual/"dated look" judgment |
| Pitch | Offer chosen from findings |
| Sending | Never automatic — drafts only, user sends manually |

**Out of scope for v1:** automated sending, Hunter/Apollo enrichment, screenshots or visual judgment, job boards, multi-user auth.

## 2. Architecture

```
Browser (React + Vite SPA, password-gated)
   │
   ▼
Worker API (Hono) ──── D1: searches, businesses, audits, contacts, drafts, settings
   │               └── R2: raw HTML + PageSpeed JSON per audit
   │ starts
   ▼
SearchWorkflow (one per search)
   └─ ListingSource.search() → upsert businesses → start one LeadWorkflow each
LeadWorkflow (one per business, each step retried independently)
   1. crawl      → contacts, content dates, basics
   2. pagespeed  → mobile performance metrics
   3. score      → 0–100 + findings + offer
   4. draft      → Claude API (skipped if score < 20)
```

The SPA is served as static assets by the same Worker.

### Components

| Unit | Responsibility | Depends on |
|---|---|---|
| `ListingSource` | Interface: `search({location, businessType, radiusKm, maxResults}) → Listing[]` where `Listing = {placeId, name, category, address, phone, websiteUrl, mapsUrl, rating, reviewCount}`. v1 implementation: `BrightDataListingSource`. | Bright Data API |
| `crawler` | Fetch homepage + up to 5 linked pages (contact, about, team, blog/news). Extract emails (incl. `mailto:` and common obfuscation), contact forms, social links, named people/roles, copyright year, latest dated content, past event dates, internal broken links, HTTPS, `<title>`, meta description, viewport tag. Detect parked domains. HTML parsing only; no headless browser. | `fetch`, HTML parser compatible with Workers |
| `pagespeed` | Call PageSpeed Insights API (mobile strategy), return `{performanceScore, lcpMs, cls, mobileFriendly}`. | PSI API key |
| `scorer` | Pure function: `(crawlResult, pagespeedResult, siteStatus) → {score, findings[], offer}`. Weights in a single config module. No I/O. | none |
| `recipient` | Pure function ranking contacts to choose the best recipient. | none |
| `drafter` | Build prompt from settings + business + top 3 findings + offer + contacts; call Claude; validate structured output. | Anthropic API |
| `auth` | Single password (Worker secret) → HMAC-signed session cookie. | none |

## 3. Data model (D1)

IDs are text UUIDs; timestamps are ISO-8601 text.

**`searches`**: `id`, `location`, `business_type`, `radius_km`, `max_results` (default 50, cap 200), `status` (`running|done|failed`), `error`, `found_count`, `processed_count`, `created_at`.

**`businesses`**: `id`, `place_id` (unique; fallback dedupe key = website domain), `name`, `category`, `address`, `phone`, `website_url`, `maps_url`, `rating`, `review_count`, `first_seen_search_id`, `lead_status` (`new|reviewed|contacted|replied|won|lost|skip`), `notes`, `contacted_at`, `last_error`, `created_at`.

**`search_results`**: `search_id`, `business_id` (composite PK).

**`audits`** (history kept; latest = max `created_at`): `id`, `business_id`, `created_at`, `site_status` (`ok|no_website|unreachable|parked`), `partial` (bool), `pagespeed_mobile`, `lcp_ms`, `cls`, `mobile_friendly`, `https`, `has_title`, `has_meta_description`, `has_contact_form`, `copyright_year`, `latest_content_date`, `broken_link_count`, `score`, `offer`, `findings` (JSON `[{code, severity, points, evidence}]`), `raw_r2_key`.

**`contacts`**: `id`, `business_id`, `type` (`email|form|phone|social`), `value`, `source_url`, `person_name`, `role`, `confidence` (0–1).

**`drafts`** (history kept): `id`, `business_id`, `audit_id`, `to_contact_id` (nullable), `recipient_reason`, `subject`, `body`, `offer` (`new_site|performance|care_plan|seo_basics`), `steering_note`, `edited` (bool), `created_at`.

**`settings`** (single row): `your_name`, `business_name`, `services_blurb`, `signature`, `physical_address`, `opt_out_line`, `tone_notes`, `monthly_spend_limit_usd`.

**`usage`**: `id`, `month` (`YYYY-MM`), `service` (`brightdata|pagespeed|claude`), `units`, `est_cost_usd`.

### Lead status transitions
- Opening a lead's draft: `new → reviewed`.
- "Copy & mark contacted": `→ contacted`, sets `contacted_at`.
- User may set `replied`, `won`, `lost`, `skip` manually.
- `skip`ped businesses are hidden from search results by default.
- Re-running a search that finds an existing business does **not** reset its status.

## 4. Scoring

### Site status shortcuts
| `site_status` | Score | Offer |
|---|---|---|
| `no_website` | 100 | `new_site` |
| `parked` / `unreachable` | 90 | `new_site` |

### Findings for reachable sites (sum, capped at 100)
| Group | Code | Rule | Points |
|---|---|---|---|
| speed | `slow_mobile` | PSI mobile < 50 | 25 |
| speed | `meh_mobile` | PSI mobile 50–69 | 12 |
| speed | `slow_lcp` | LCP > 4000 ms | 10 |
| speed | `layout_shift` | CLS > 0.25 | 5 |
| speed | `not_mobile_friendly` | No viewport meta, or PSI flags tap targets/font size | 20 |
| stale | `old_copyright` | copyright year ≤ current year − 2 | 10 |
| stale | `stale_content` | newest dated post/news > 18 months old | 10 |
| stale | `past_events` | event dates listed that have passed | 5 |
| stale | `broken_links` | ≥ 3 broken internal links | 8 |
| basics | `no_https` | HTTP only or invalid certificate | 15 |
| basics | `no_title_or_meta` | missing `<title>` or meta description | 6 |
| basics | `no_contact_form` | no form and no email found | 6 |

`slow_mobile` and `meh_mobile` are mutually exclusive. Each finding carries human-readable `evidence` (e.g. "Loads in about 8.4s on a phone").

### Offer selection
1. `new_site` if no/parked/unreachable site, or `not_mobile_friendly` plus any `stale` finding.
2. Otherwise the group with the most points: speed → `performance`, stale → `care_plan`, basics → `seo_basics`. Ties break in that order.

### Thresholds
- Score < 20: tagged "low priority"; no auto-draft (manual "Generate draft" available). (v2: a lead is also low priority when none of its findings is worth `autoDraftMinFindingPoints` = 8 points or more, so a pile of small findings on an otherwise healthy site is not pitched; see 12.2.)
- If PageSpeed is unavailable, score from crawl data only and set `partial = true`.

## 5. Recipient selection

Rank contacts, best first:
1. Named person email on the business's own domain (from about/team pages), preferring owner/manager/office roles.
2. Generic inbox on own domain, in order: `owner@`, `info@`, `contact@`, `office@`, any other.
3. Email on a free-mail domain (gmail etc.) listed on the site.
4. Contact form URL.
5. Phone only.

If the best option is not an email, the draft has `to_contact_id = null` and `recipient_reason` explains the fallback ("Use contact form at …" / "Call …").

## 6. Email drafting

**Model:** Claude Sonnet 5.5 (`claude-sonnet-5-5`).

**Inputs:** settings row, business info, top 3 findings by points (with evidence), chosen offer, ranked contacts, optional one-off steering note.

**Prompt rules:**
- Under 120 words in the body; plain text.
- Open with something specific to the business, not a generic pleasantry.
- Mention at most 3 findings in plain English using the evidence; no jargon (no "LCP", "CLS", "meta description").
- Make no claim that is not supported by a provided finding.
- One call to action: a free 5-minute mini-audit or a short call.
- End with signature, physical address, and opt-out line copied verbatim from settings.
- Write in the voice described by `tone_notes` (seeded from Logan's `logan-voice` skill).

**Output (structured JSON):** `{subject, body, to_contact_id, recipient_reason}`.

**Validation:** parse against a schema; retry once on failure. Reject any `to_contact_id` not in the provided contacts. Assert the address and opt-out line appear verbatim; if not, append them.

## 7. Screens

1. **Login** — single password field.
2. **New Search** — location, business type (free text with suggestions), radius, max results; shows estimated scraper cost before submitting.
3. **Search detail** — progress (processed / found), polled every few seconds while running; lead table sortable by score with name, score, top finding, best contact, offer, status; filters: hide skipped, min score, has email.
4. **Lead detail** — left: business info, site + Maps links, contacts with source pages, findings with evidence and points, audit warnings (⚠ partial / errors). Right: editable draft with recipient + reason; actions: Copy email, Open in mail app (`mailto:` with subject/body), Copy & mark contacted, Regenerate (with steering note), Re-audit, Skip, status dropdown, notes.
5. **All Leads** — every business across searches, filterable by status, for follow-ups.
6. **Settings** — profile/signature/address/opt-out/tone fields, monthly spend limit, current-month usage by service.

## 8. Error handling

- Workflow steps retry 3× with exponential backoff. On final failure, record `last_error` on the business, mark the lead with ⚠ and a Retry action; the search continues.
- Listing source failure: search → `failed` with the error message; no partial business writes.
- Crawler: 10 s timeout per page, max 6 pages, honest user-agent identifying the tool, skip non-HTML responses, detect parked/for-sale pages.
- PageSpeed: requests throttled through a queue; on rate limit, the step sleeps and retries; if still unavailable, score with `partial = true`.
- Claude: schema validation + one retry; hallucinated recipients rejected.
- Cost guard: `max_results` ≤ 200; new searches blocked when estimated month spend would exceed `monthly_spend_limit_usd`.

## 9. Testing

- **Unit (Vitest):** scorer (fixture inputs → expected score/findings/offer, including mutual exclusions and tie-breaks); crawler parsers against saved HTML fixtures (copyright, obfuscated emails, `mailto:`, forms, parked pages, dated content); recipient ranking.
- **Integration:** Workflows run in Cloudflare's local test environment (`@cloudflare/vitest-pool-workers`) with fake `ListingSource`, PageSpeed, and Claude.
- **Prompt check:** script runs the drafter on ~5 saved leads; automated assertions for word count, verbatim address + opt-out line, and no findings cited beyond those provided; output saved for manual review.
- **Manual smoke test:** one real search (~10 businesses) in Logan's city before v1 is considered done.

## 10. Secrets and config

Worker secrets: `APP_PASSWORD`, `SESSION_SECRET`, `BRIGHTDATA_API_KEY`, `PAGESPEED_API_KEY`, `ANTHROPIC_API_KEY`.
Scoring weights and thresholds: `src/scoring/config.ts`.

## 11. Compliance notes

- Drafts always include sender identity, physical address, and an opt-out line (CAN-SPAM).
- No automated sending in v1.
- Listing data comes from a third-party scraper provider; the app does not scrape Google Maps directly.
- The crawler only fetches a handful of public pages per site, with a clear user-agent.

## 12. v2 additions (2026-10-03)

Audit signals, platform detection, richer lead filters, a shareable report, Radar (scheduled searches) and a mail DNS check. Sections 1-11 remain the v1 record; where this section differs (more findings, group caps, more tables and screens), this section is current.

### 12.1 New findings

Weights live in `WEIGHTS` and thresholds in `THRESHOLDS` in `src/worker/scoring/config.ts`; rules in `src/worker/scoring/scorer.ts`. Severity is derived from weight: >= 15 high, 8-14 medium, below 8 low.

| Group | Code | Weight | Rule | Evidence says (plain English) |
|---|---|---|---|---|
| seo | `low_seo_score` | 12 | Lighthouse SEO category score < 70 | Google's own check flagged things that can hold the site back in search, listing up to 3 mapped issues; falls back to the score if none map |
| basics | `low_accessibility` | 6 | Lighthouse accessibility category score < 70 | Parts of the site are hard to read or use for some visitors, listing up to 2 mapped issues |
| local | `no_click_to_call` | 8 | A phone number is on the page but no `tel:` link | The number isn't a tap-to-call link, so visitors on phones must copy and paste it |
| local | `no_local_schema` | 5 | No LocalBusiness structured data (JSON-LD or microdata) | Business details (name, address, hours) aren't in a form Google can read |
| seo | `thin_content` | 5 | Homepage under 150 words | The homepage has very little text (about N words) |
| seo | `no_h1` | 3 | No `<h1>` on the homepage | The headline isn't marked as the main heading |
| seo | `missing_alt` | 4 | >= 4 images and >= 50% have no `alt` | N of M images have no description, so Google and screen readers can't tell what they show |
| seo | `no_sitemap` | 3 | No sitemap at any probed location (see 12.3) | The site has no sitemap file |
| basics | `mixed_content` | 6 | >= 1 insecure (http) resource on an https page | The page loads some content over an insecure connection |
| basics | `no_https_redirect` | 4 | The plain-http address serves the page instead of sending people to https | Visiting without the secure version doesn't send people to the secure page |
| stale | `dated_build` | 10 | >= 1 outdated-technique marker in the HTML | The site is built with outdated techniques (up to 2 named) |
| basics | `no_email_auth` | 4 | MX exists and SPF is absent (see 12.6) | Business email lacks sender-verification records, so some messages may land in spam |

Existing v1 findings are unchanged. `not_mobile_friendly` is still emitted at most once.

### 12.2 Score, group caps and offer selection

- The total is `min(100, capGroups(findings))`. `capGroups` sums points per group and caps the groups listed in `GROUP_CAPS` (`seo` 20, `local` 15). `speed`, `stale`, `basics` and `site` stay uncapped.
- Offer selection (section 4) deliberately uses raw, uncapped sums, and adds the raw `seo` and `local` points into the basics bucket. So SEO and local findings can only ever steer the offer to `seo_basics`.
- The score is an INTERNAL opportunity score: higher = worse site = better prospect. It is never shown on the public report.
- Auto-draft: `lowPriority` is `total < lowPriorityBelow` (20) OR no finding is worth at least `autoDraftMinFindingPoints` (8). The second clause exists because the v2 findings are mostly small: five of them (no local schema 5, thin content 5, no https redirect 4, no headline 3, no sitemap 3) add up to 20 on a fast, well-built site, which is not a reason to spend on a draft. A low-priority lead can still be drafted manually. The no_website / parked / unreachable shortcuts are never low priority.

### 12.3 Truthfulness rules

The code only claims what it observed, which is why some findings are suppressed:
- The crawler reads static HTML only. `isLikelyJsRendered` (wix, squarespace or webflow, or a near-empty page with a JS mount point or script and no `<h1>`) suppresses ONLY the absence findings `no_click_to_call`, `no_local_schema`, `thin_content` and `no_h1`. It is never itself a claim. Presence-based findings (`missing_alt`, `mixed_content`) are unaffected.
- Lighthouse failing-audit ids are mapped to plain-English labels in `AUDIT_LABELS` (`src/worker/scoring/labels.ts`). Unmapped ids are ignored; raw ids and Lighthouse's own wording never reach evidence.
- Crawler and Lighthouse findings are de-duplicated by audit id: `image-alt` is dropped from `low_seo_score` (accessibility's), and from `low_accessibility` when `missing_alt` already fired; `document-title` / `meta-description` are dropped when the crawler already reports `no_title_or_meta`; `is-crawlable` is dropped on a bot-blocked site.
- Site-level probes (robots.txt, sitemap at `/sitemap.xml`, `/sitemap_index.xml` and `/wp-sitemap.xml` plus any sitemap declared in robots.txt, http to https redirect) return "unknown" on any error, timeout, challenge page or ambiguous response, and unknown makes no claim. `no_sitemap` needs every probe to say "none".

### 12.4 Platform detection and lead filters

`audits.platform` is one of `wix`, `squarespace`, `godaddy`, `wordpress`, `weebly`, `shopify`, `webflow`, `other`; `null` = not crawled. It is detected from the `generator` meta tag and asset hosts (plus WordPress `/wp-content/` or `/wp-includes/` paths on the site's own host and Webflow's `data-wf-*` html attributes), never from brand-name text, and a footer link to a builder's site counts for nothing. It feeds the platform filter and the JS-render suppression for wix, squarespace and webflow.

Lead tables (Search detail, All Leads) filter client-side on: hide skipped, min score, has email (all v1), plus min reviews, max rating (at or below), offer, and platform (including "not crawled").

### 12.5 Shareable report

- The owner creates a link from the lead page. Public URL `/r/<token>`, token 32 random bytes as 43 base64url characters. Expires after 30 days. "Revoke all" revokes every link for the business.
- Creating a link for an audit that already has a live link returns that link. After a re-audit, older links stay live until expiry or revoke; the lead page shows "N older links still active".
- The public JSON is exactly: `businessName`, `auditedAt`, `counts` (high/medium/low), `findings` (severity + evidence only, high first), `partial`, `sender` (`name`, `businessName`, `email`, `logoUrl`), `expiresAt`. It never includes the internal score, points, codes, contacts, notes or drafts.
- Unknown, expired, revoked and malformed tokens all return the same 404.
- Not indexable: `X-Robots-Tag: noindex, nofollow` on API responses and (via `public/_headers`) on `/r` and `/r/*`, a meta tag on the page, and `Disallow: /r/` in `public/robots.txt`. Responses are `no-store` with `Referrer-Policy: no-referrer`.
- Settings: contact email, your name, business name and logo URL (https only, or empty) are PUBLIC on shared reports; the Settings page says so.

### 12.6 Mail DNS

`lookupMailDns` (`src/worker/dns.ts`, Cloudflare DNS-over-HTTPS) checks MX and SPF only. DMARC is deliberately neither checked nor claimed. The domain comes from an email address the crawler found on the site that belongs to the site's own host (the host itself or a parent of it); free-mail, hosted-platform and public-suffix domains never qualify (`PUBLIC_SUFFIXES` are denied exactly, so `ace.co.uk` still counts; `PLATFORM_SUFFIXES` are denied along with everything under them, so `joe.wixsite.com` does not; `HOSTED_SUFFIXES` is both lists), and with no such address nothing is looked up. Any lookup error is "unknown" and makes no claim.
- `no_email_auth` fires only when MX exists and SPF is absent.
- When a site-listed address is at a domain with no MX, `audits.mail_warning` holds an owner-only note shown on the lead page. It is never scored, and never in drafts or the public report.

### 12.7 Radar

Saved searches re-run by a Cloudflare Cron Trigger (`triggers.crons: ["17 13 * * *"]`, daily 13:17 UTC). Each tick lists enabled radars whose `next_run_at` has passed; interval is per radar (default 30 days, 7-90).
- Starts go through `src/worker/search-start.ts`, the same guards as the manual search route: mailing settings and monthly spend limit. Spend counts recorded usage plus searches still `running` that started within 6 hours, at estimated cost; a recheck after the search row is inserted stops simultaneous starts from overshooting.
- At most 3 radars start per tick; max 20 radars; a duplicate market (location + business type, case-insensitive) is rejected (409).
- A radar is claimed atomically (single-statement compare-and-set that moves `next_run_at` out and stamps `claimed_at`) before it runs: no double runs, and a 10 s cooldown on manual Run now. A crash after the claim skips that interval rather than risking a double spend.
- Searches a radar starts are `new_only` (`searches.new_only = 1`): `runSearch` starts the per-lead pipeline only for businesses with no audit row at all, still excluding skipped/contacted/replied/won/lost leads. Other businesses it finds are linked to the search and counted in `found_count` and `processed_count` but keep their existing audit and draft (re-audit one from its lead page). The spend estimate is unchanged (`maxResults` drafts). Manual searches still re-audit and re-draft leads the owner has not acted on.
- A blocked or failed radar records the reason in `last_error` (shown on the Radar page) and retries the next day. A manual Run now that is blocked (spend limit, missing mailing settings) on a radar that is not yet due keeps its existing schedule; a Run now that starts a search moves `next_run_at` to now + the interval.
- No email or push notification. New leads show as a count (businesses first seen by the last run) on the Radar page.
- Local test: `npx wrangler dev -c wrangler.jsonc --local --test-scheduled`, then `curl "http://localhost:8787/cdn-cgi/handler/scheduled?cron=17+13+*+*+*"`.

### 12.8 At a glance

Migrations (additive; run `npm run db:migrate:remote` BEFORE `npm run deploy`):

| File | Change |
|---|---|
| 0002 | `audits.platform` |
| 0003 | `audits.seo_score`, `audits.accessibility_score` |
| 0004 | `audit_reports` table (`token`, `business_id`, `audit_id`, `created_at`, `expires_at`, `revoked`); `settings.logo_url` |
| 0005 | `radars` table, unique market index |
| 0006 | `radars.claimed_at` |
| 0007 | `audits.mail_warning` |
| 0008 | `searches.new_only` |

Endpoints (all behind the session cookie except the public report):

| Endpoint | Purpose |
|---|---|
| `GET /api/leads/:id/report` | Current link for the latest audit (or null) and count of other live links |
| `POST /api/leads/:id/report` | Create (201) or return the live link for the latest audit |
| `DELETE /api/leads/:id/report` | Revoke every link for the business |
| `GET /api/public/report/:token` | Public report JSON (no auth) |
| `GET /api/radar`, `POST /api/radar` | List radars with new-lead counts; create (optionally `runNow`) |
| `PATCH /api/radar/:id`, `DELETE /api/radar/:id` | Enable/disable or change interval; delete (past searches and leads stay) |
| `POST /api/radar/:id/run` | Run now (manual claim, same guards) |

Screens: **Radar** (`/radar`: list, enable/disable, interval, Run now with cost confirmation, delete) and the "Repeat this search (Radar)" option on New Search; **Report** (`/r/<token>`, public, unauthenticated, noindex); share/revoke controls and the mail warning on Lead detail; new filters on the lead tables. Cron: `scheduled` handler in `src/worker/index.ts` runs `runDueRadars`.

### 12.9 Known limitations

- The PageSpeed test fixture is hand-written, not a live capture; the Lighthouse audit ids in `labels.ts` and the `viewport` / `font-size` / `tap-targets` audits behind mobile-friendliness (a missing audit counts as passing) are unverified against a real response.
- No email notification for Radar.
- The extractor is slow on very large pages (roughly 5 s CPU at 1 MB; HTML size cap filed as a separate task) and the HTML parser is slow on deeply nested unclosed markup.
