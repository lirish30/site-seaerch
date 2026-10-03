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
3. `npm run deploy`
4. Sign in, fill in Settings (address + opt-out are required for CAN-SPAM), paste tone notes from `scripts/tone-notes.txt`.
5. The Bright Data test fixture was written by hand, not captured from a live response. Check the first real search for correct field names (name, address, website, category) and fix the parser if results come back empty or misread.

Optional voice check before relying on drafts: `ANTHROPIC_API_KEY=... TONE="$(cat scripts/tone-notes.txt)" npm run prompt-check` (writes `scripts/out/prompt-check.md`).

## Keys
- Bright Data: SERP API zone + API key.
- PageSpeed: Google Cloud API key with PageSpeed Insights API enabled.
- Anthropic: API key.

## Tuning
Scoring weights: `src/worker/scoring/config.ts`. Prices for the spend guard: `src/worker/cost.ts`.
