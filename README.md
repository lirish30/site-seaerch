# Site Search

Personal tool: find local businesses, audit their websites, draft outreach emails.

## Setup
1. `npm install`
2. `npx wrangler d1 create site-search` → paste id into `wrangler.jsonc`
3. `npx wrangler r2 bucket create site-search-raw`
4. `cp .dev.vars.example .dev.vars` and fill in keys
5. `npm run db:migrate:local && npm run dev`

## Deploy
1. `npm run db:migrate:remote`
2. Set secrets: `npx wrangler secret put APP_PASSWORD` (repeat for SESSION_SECRET, BRIGHTDATA_API_KEY, BRIGHTDATA_SERP_ZONE, PAGESPEED_API_KEY, ANTHROPIC_API_KEY). `BRIGHTDATA_SERP_ZONE` is required: the SERP API will not run without it.
   - `APP_PASSWORD` is the only thing guarding the app: use a long random value, at least 20 characters (e.g. `openssl rand -base64 24`). `SESSION_SECRET` should be similarly long and random.
   - Login attempts are throttled by the `LOGIN_LIMITER` Workers Rate Limiting binding in `wrangler.jsonc` (10 attempts per minute per client IP; over the limit `/api/login` returns 429). Its `namespace_id` (`1001`) just needs to be unique among rate limiters on your account.
3. `npm run deploy`
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
Category weights and rule deductions: `src/worker/scoring/config.ts`. Niche expectations: `src/worker/audit/rubrics.ts`. Prices for the spend guard: `src/worker/cost.ts`.
