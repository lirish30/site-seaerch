# Site Search

Personal tool: find local businesses, audit their websites, draft outreach emails.

## Setup
1. `npm install`
2. `npx wrangler d1 create site-search` → paste id into `wrangler.jsonc`
3. `npx wrangler r2 bucket create site-search-raw`
4. `cp .dev.vars.example .dev.vars` and fill in keys
5. `npm run db:migrate:local && npm run dev`

## Deploy
1. `npm run db:migrate:remote`. Always run this BEFORE `npm run deploy`. Migrations 0002-0007 are additive, so the old worker keeps running on the new schema, but the new worker writes columns the old schema lacks (`audits.platform`, `seo_score`, `accessibility_score`, `mail_warning`; `radars.claimed_at`). Deploy it first and every audit insert and every Radar claim fails.
2. Set secrets: `npx wrangler secret put APP_PASSWORD` (repeat for SESSION_SECRET, BRIGHTDATA_API_KEY, BRIGHTDATA_SERP_ZONE, PAGESPEED_API_KEY, ANTHROPIC_API_KEY). `BRIGHTDATA_SERP_ZONE` is required: the SERP API will not run without it.
   - `APP_PASSWORD` is the only thing guarding the app: use a long random value, at least 20 characters (e.g. `openssl rand -base64 24`). `SESSION_SECRET` should be similarly long and random.
   - Login attempts are throttled by the `LOGIN_LIMITER` Workers Rate Limiting binding in `wrangler.jsonc` (10 attempts per minute per client IP; over the limit `/api/login` returns 429). Its `namespace_id` (`1001`) just needs to be unique among rate limiters on your account.
3. `npm run deploy` (only after step 1 has succeeded; the cron trigger in `wrangler.jsonc` is registered by this deploy)
4. Sign in, fill in Settings (address + opt-out are required for CAN-SPAM; searches, re-audits and draft regeneration are refused until both are set), paste tone notes from `scripts/tone-notes.txt`.
5. The Bright Data test fixture (`test/fixtures/brightdata-maps.json`) is a trimmed live capture from 2026-10-03. If Bright Data changes its response shape and results come back empty or misread, re-capture it and update `mapBrightDataItem`.

Optional voice check before relying on drafts: `ANTHROPIC_API_KEY=... TONE="$(cat scripts/tone-notes.txt)" npm run prompt-check` (writes `scripts/out/prompt-check.md`).

## Keys
- Bright Data: SERP API zone + API key.
- PageSpeed: Google Cloud API key with PageSpeed Insights API enabled.
- Anthropic: API key.

## Tuning
- Scoring weights, thresholds and group caps: `src/worker/scoring/config.ts` (`WEIGHTS`, `THRESHOLDS`, `GROUP_CAPS`). `GROUP_CAPS` limits how many points the `seo` (20) and `local` (15) groups can add to the total; groups not listed are uncapped. Offer selection ignores the caps and counts raw seo + local points as basics.
- Lighthouse audit id -> plain-English label: `AUDIT_LABELS` in `src/worker/scoring/labels.ts`. Ids not listed there are ignored, never shown raw.
- Domains never treated as the business's own mail domain (public suffixes, hosted site builders): `HOSTED_SUFFIXES` in `src/worker/dns.ts`.
- Prices for the spend guard: `src/worker/cost.ts`.

## Audit signals
Every finding carries plain-English evidence. The score is an internal opportunity score (higher = worse site) and is never shown on the public report. The full finding table, rules and truthfulness principles are in section 12 of `docs/superpowers/specs/2026-10-02-site-search-design.md`.
- The crawler reads static HTML only. Where a page looks JavaScript-rendered, "X is missing" findings (tap-to-call, local schema, thin content, headline) are suppressed rather than guessed.
- Site-level checks (robots.txt, sitemap, http to https redirect, mail DNS) that fail or time out make no claim.
- Mail DNS checks MX and SPF only. DMARC is deliberately not checked or claimed.

## Shareable report
From a lead page, create a link: public URL `/r/<43-char token>`, expires after 30 days, revocable ("Revoke all" when older links exist). Links made for an earlier audit stay live after a re-audit until they expire or are revoked; the lead page shows how many.
- Contact email, your name, business name and logo URL (https only) from Settings are PUBLIC on shared reports.
- The report shows findings (severity + evidence) only. No internal score, points, codes, contacts, notes or drafts.
- Unknown, expired, revoked and malformed tokens all return the same 404. Reports are noindex (X-Robots-Tag header, `public/_headers`, a meta tag, `public/robots.txt`).

## Radar
Radar re-runs saved searches on a schedule. Tick "Repeat this search (Radar)" on New Search (interval 7-90 days, default 30), manage radars on the Radar page.
- A Cloudflare Cron Trigger runs daily at 13:17 UTC (`triggers.crons` in `wrangler.jsonc`). Each radar decides whether it is due.
- Same guards as a manual search (mailing settings, monthly spend limit). Spend counting includes searches still running (started in the last 6 hours, at estimated cost) plus recorded usage.
- At most 3 radars start per tick; max 20 radars; a duplicate market (same location + business type, case-insensitive) is rejected. Each radar is claimed atomically before it runs, so there are no double runs; manual "Run now" has a 10 s cooldown and asks for confirmation with the estimated cost.
- A blocked radar retries the next day and shows the reason.
- Radar sends no email or push notification. New leads show as a count on the Radar page.
- Test the cron locally: `npx wrangler dev -c wrangler.jsonc --local --test-scheduled`, then `curl "http://localhost:8787/cdn-cgi/handler/scheduled?cron=17+13+*+*+*"`. Keep `-c wrangler.jsonc`: a stale `.wrangler/deploy/config.json` can otherwise redirect to an old build.

## Known limitations
- The PageSpeed test fixture is hand-written, not a live capture. Capture one real PageSpeed response, then verify the Lighthouse audit ids in `src/worker/scoring/labels.ts` and the `viewport` / `font-size` / `tap-targets` audits used for mobile-friendliness (a missing audit counts as passing).
- Each Radar re-run re-audits and re-drafts leads you haven't acted on (about $0.01 each, within the search estimate). Consider limiting Radar runs to never-audited businesses.
- No email notification for Radar.
- The crawler's extractor gets slow on very large pages (roughly 5 s CPU at 1 MB; a separate task is filed to cap HTML size), and the HTML parser is slow on deeply nested unclosed markup.
