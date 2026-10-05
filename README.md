# Site Search

Personal tool: find local businesses, audit their websites, draft outreach emails.

## Setup
1. `npm install`
2. `npx wrangler d1 create site-search` → paste id into `wrangler.jsonc`
3. `npx wrangler r2 bucket create site-search-raw`
4. `cp .dev.vars.example .dev.vars` and fill in keys
5. `npm run db:migrate:local && npm run dev`

## Deploy
1. `npm run db:migrate:remote`. Always run this BEFORE `npm run deploy`. Migrations are applied by name in filename order: 0002-0006 (audit v2, CRM, email voice, Google, CRO) and 0007-0013 (platform, Lighthouse scores, report links + `settings.logo_url`, radar, `radars.claimed_at`, `audits.mail_warning`, `searches.new_only`). All are additive, so the old worker keeps running on the new schema, but the new worker writes columns the old schema lacks. Deploy it first and every audit insert, settings read for reports and every Radar claim fails.
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
- Browser Rendering: the `browser` binding in `wrangler.jsonc` (Workers Paid). Used for screenshots, the AI design review, JS-built pages, and PDF export. Without it audits fall back to raw HTML and rules only, and PDF export returns 501. Local dev downloads a Chromium on first use.

## Google (optional: Gmail drafts + Drive)
1. Google Cloud console → APIs & Services: enable the **Gmail API** and **Google Drive API**.
2. OAuth consent screen: External, add yourself as a test user. Scopes: `gmail.compose`, `drive.file`, `openid`, `email`.
3. Credentials → Create OAuth client ID → Web application. Authorized redirect URIs:
   - `http://localhost:5173/api/google/callback` (dev)
   - `https://<your-worker-domain>/api/google/callback` (prod)
4. Put `GOOGLE_CLIENT_ID` / `GOOGLE_CLIENT_SECRET` in `.dev.vars`, and `npx wrangler secret put` both for prod.
5. Settings → Connect Google. The refresh token is stored AES-GCM encrypted (key derived from `SESSION_SECRET`; rotating that secret means reconnecting).

The app only ever creates **drafts**; it never calls Gmail's send endpoint. Drive files land in a "Site Search reports" folder the app creates.

## Audit + scoring
- Every lead is rendered in a real browser (desktop + 390px phone), crawled (homepage + up to 7 key pages chosen from nav/footer links), timed with PageSpeed, then reviewed by Claude Sonnet 5.5 against a niche rubric (`src/worker/audit/rubrics.ts`).
- **Site Health** (0–100, higher = better): Design 25, Content 20, Conversion 20, Mobile 15, Speed 10, Technical 10. Missing categories are dropped and the rest renormalized.
- **Opportunity** (0–100, higher = better lead) is stored in `audits.score`: low health, critical gaps, plus review count/rating as a sign the business can pay.

## Tuning
- Category weights, rule deductions and thresholds: `src/worker/scoring/config.ts` (`CATEGORY_WEIGHTS`, `DEDUCTIONS`, `THRESHOLDS`). Niche expectations: `src/worker/audit/rubrics.ts`.
- Lighthouse audit id -> plain-English label: `AUDIT_LABELS` in `src/worker/scoring/labels.ts`. Ids not listed there are ignored, never shown raw.
- Domains never treated as the business's own mail domain: `PUBLIC_SUFFIXES` (exact match, so `ace.co.uk` still counts) and `PLATFORM_SUFFIXES` (hosted site builders, and everything under them) in `src/worker/dns.ts`.
- Auto-draft rule: a lead is low priority (no paid draft) when its opportunity is under `lowPriorityBelow` (25) or none of its findings is above "nice" severity. `THRESHOLDS` in `config.ts`.
- Prices for the spend guard: `src/worker/cost.ts`.

## Audit signals
Every finding carries plain-English evidence, a category, a severity (critical / important / nice) and a recommendation. Opportunity (`audits.score`) and Site Health are internal and never shown on the public report.
- With the Browser binding the crawler reads the page as a real browser built it. Without a usable render it reads static HTML only, and where a page looks JavaScript-rendered, "X is missing" findings (tap-to-call, structured data, thin homepage, headline) are suppressed rather than guessed.
- Lighthouse SEO and accessibility scores below 70 become technical findings, worded from `labels.ts`.
- Site-level checks (robots.txt, sitemap, http to https redirect, mail DNS) that fail or time out make no claim.
- Mail DNS checks MX and SPF only, and only for a domain the site itself lists an email address at. DMARC is deliberately not checked or claimed. A domain with no mail records is a note for you on the lead page (`audits.mail_warning`), never a finding, never in a draft or report.

## Shareable report
From a lead page, create a link: public URL `/r/<43-char token>`, expires after 30 days, revocable ("Revoke all" when older links exist). Links made for an earlier audit stay live after a re-audit until they expire or are revoked; the lead page shows how many.
- Contact email, your name, business name and logo URL (https only) from Settings are PUBLIC on shared reports.
- The report shows findings (severity + evidence) only: critical / important / nice are shown as high / medium / low. No internal score, health, points, codes, contacts, notes, drafts, screenshots or CRO audit.
- Unknown, expired, revoked and malformed tokens all return the same 404. Reports are noindex (X-Robots-Tag header, `public/_headers`, a meta tag, `public/robots.txt`).

## Radar
Radar re-runs saved searches on a schedule. Tick "Repeat this search (Radar)" on New Search (interval 7-90 days, default 30), manage radars on the Radar page.
- A Cloudflare Cron Trigger runs daily at 13:17 UTC (`triggers.crons` in `wrangler.jsonc`). Each radar decides whether it is due.
- Same guards as a manual search (mailing settings, monthly spend limit). Spend counting includes searches still running (started in the last 6 hours, at estimated cost) plus recorded usage.
- At most 3 radars start per tick; max 20 radars; a duplicate market (same location + business type, case-insensitive) is rejected. Each radar is claimed atomically before it runs, so there are no double runs; manual "Run now" has a 10 s cooldown and asks for confirmation with the estimated cost.
- Radar-started searches only audit and draft businesses that were never audited before (`searches.new_only`). A business a radar finds again keeps its existing audit and draft (unless its last run failed, which a radar retries); re-audit it from its lead page. Manual searches still refresh leads you have not acted on.
- A blocked radar retries the next day and shows the reason.
- Radar sends no email or push notification. New leads show as a count on the Radar page.
- Test the cron locally: `npx wrangler dev -c wrangler.jsonc --local --test-scheduled`, then `curl "http://localhost:8787/cdn-cgi/handler/scheduled?cron=17+13+*+*+*"`. Keep `-c wrangler.jsonc`: a stale `.wrangler/deploy/config.json` can otherwise redirect to an old build.

## Known limitations
- The PageSpeed test fixture is hand-written, not a live capture. Capture one real PageSpeed response, then verify the Lighthouse audit ids in `src/worker/scoring/labels.ts` and the `viewport` / `font-size` / `tap-targets` audits used for mobile-friendliness (a missing audit counts as passing).
- No email notification for Radar.
- After the first deploy, audits created before this release have no platform, so they appear under "not crawled" in the platform filter until they are re-audited.
- Lead workflows that are mid-run during a deploy can fail at the score step (their cached crawl result predates the new fields). Deploy when no search is running and no re-audit is pending; a failed lead shows a ⚠ and can be re-run with "Re-audit" on its lead page.
- The crawler's extractor gets slow on very large pages (roughly 5 s CPU at 1 MB; a separate task is filed to cap HTML size), and the HTML parser is slow on deeply nested unclosed markup.
