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
- Score < 20: tagged "low priority"; no auto-draft (manual "Generate draft" available).
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
