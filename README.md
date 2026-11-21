# Site Search

Personal tool: find local businesses, audit their websites, draft outreach emails.

## Setup
1. `npm install`
2. `npx wrangler d1 create site-search` → paste id into `wrangler.jsonc`
3. `npx wrangler r2 bucket create site-search-raw`
4. `cp .dev.vars.example .dev.vars` and fill in keys
5. `npm run db:migrate:local && npm run dev`

## Deploy
1. `npm run db:migrate:remote`. Always run this BEFORE `npm run deploy`. Migrations are applied by name in filename order: 0002-0006 (audit v2, CRM, email voice, Google, CRO) and 0007-0013 (platform, Lighthouse scores, report links + `settings.logo_url`, radar, `radars.claimed_at`, `audits.mail_warning`, `searches.new_only`). 0020-0021 (job-search profile, work samples, signature JSON, draft purpose and variants) are additive too. All are additive, so the old worker keeps running on the new schema, but the new worker writes columns the old schema lacks. Deploy it first and every audit insert, settings read for reports and every Radar claim fails.
2. Set secrets: `npx wrangler secret put APP_PASSWORD` (repeat for SESSION_SECRET, BRIGHTDATA_API_KEY, BRIGHTDATA_SERP_ZONE, PAGESPEED_API_KEY). `BRIGHTDATA_SERP_ZONE` is required: the SERP API will not run without it.
   - `APP_PASSWORD` is the only thing guarding the app: use a long random value, at least 20 characters (e.g. `openssl rand -base64 24`). `SESSION_SECRET` should be similarly long and random.
   - Login attempts are throttled by the `LOGIN_LIMITER` Workers Rate Limiting binding in `wrangler.jsonc` (10 attempts per minute per client IP; over the limit `/api/login` returns 429). Its `namespace_id` (`1001`) just needs to be unique among rate limiters on your account.
3. `npm run deploy` (only after step 1 has succeeded; the cron trigger in `wrangler.jsonc` is registered by this deploy)
4. Sign in and fill in Settings: your profile, a few work samples, and your email signature (the builder takes a graphic and links). Paste tone notes from `scripts/tone-notes.txt`. The mailing address and opt-out line are optional: they only go on an email when you turn the footer on for it (on by default).
5. The Bright Data test fixture (`test/fixtures/brightdata-maps.json`) is a trimmed live capture from 2026-10-03. If Bright Data changes its response shape and results come back empty or misread, re-capture it and update `mapBrightDataItem`.

## Keys
- Bright Data: SERP API zone + API key.
- PageSpeed: Google Cloud API key with PageSpeed Insights API enabled.
- Claude: no key. Claude work (reviews, drafts, reply triage) is queued as tasks and worked through your Claude Code subscription over MCP: run `/work-the-queue` (see "Agency OS setup").
- Browser Rendering: the `browser` binding in `wrangler.jsonc` (Workers Paid). Used for screenshots, the AI design review, JS-built pages, and PDF export. Without it audits fall back to raw HTML and rules only, and PDF export returns 501. Local dev downloads a Chromium on first use.

## Google (optional: Drive export)
Google is connected only to save reports to Drive. It is never used for email.
1. Google Cloud console → APIs & Services: enable the **Google Drive API**.
2. OAuth consent screen: External, add yourself as a test user. Scopes: `drive.file`, `openid`, `email`.
3. Credentials → Create OAuth client ID → Web application. Authorized redirect URIs:
   - `http://localhost:5173/api/google/callback` (dev)
   - `https://<your-worker-domain>/api/google/callback` (prod)
4. Put `GOOGLE_CLIENT_ID` / `GOOGLE_CLIENT_SECRET` in `.dev.vars`, and `npx wrangler secret put` both for prod.
5. Settings → Connect Google. The refresh token is stored AES-GCM encrypted (key derived from `SESSION_SECRET`; rotating that secret means reconnecting).

Drive files land in a "Site Search reports" folder the app creates.

## Email
Nothing is sent without your approval. Start a sequence from a lead; Email 1 waits on Home; each later email step is proposed there too, and call steps appear on the follow-up list instead. Approved mail goes out over SMTP from the mailboxes set up in Settings → Mailboxes. Their passwords are Worker secrets, never stored in the database: `MAILBOX_OUTREACH_PASSWORD` and `MAILBOX_MAIN_PASSWORD` (`.dev.vars` locally, `npx wrangler secret put` for prod). Links in cold email use `OUTREACH_LINK_BASE` (a host you own; never `workers.dev`).

## Audit + scoring
- Every lead is rendered in a real browser (desktop + 390px phone), crawled (homepage + up to 7 key pages chosen from nav/footer links), timed with PageSpeed, then reviewed by Claude (queued, worked via `/work-the-queue`) against a niche rubric (`src/worker/audit/rubrics.ts`).
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

## Agency OS setup
- Generate the MCP bearer token: `openssl rand -hex 32`. Put it in `.dev.vars` as `MCP_TOKEN=` for local runs, and for production run `npx wrangler secret put MCP_TOKEN`.
- Add the MCP server to Claude Code: `claude mcp add --transport http agency-os <url>/mcp --header "Authorization: Bearer <token>"`. `/mcp` is POST only; wrong tokens are rate limited per IP.
- Work the queue: with the `agency-os` MCP server connected, run `/work-the-queue` in Claude Code. It claims the queued Claude tasks (site reviews, drafts, reply triage, CRO) one at a time and completes them on your subscription.
- Passkeys are bound to the domain (`WEBAUTHN_RP_ID` / `WEBAUTHN_ORIGIN`, default the request host). After a domain change, re-register your passkeys.

## Sales: booking, prep and the deck
- **Booking page.** When booking is on, each shared report links to `<OUTREACH_LINK_BASE>/r/<token>/book`, a per-lead page where the guest picks a time and answers the budget question. It uses the same 30-day token as the report; a dead, revoked or do-not-contact link gets the same 404. Guests cancel from the link in their confirmation email (it still works after the report link expires). Settings → Booking holds the availability windows, the budget choices on the form and the minimum engagement (the lowest budget choice cannot be under it). Bookings land on your primary Google Calendar with a Meet link, and appear in the Calls card on the lead page, where you can also cancel or mark no-show.
- **Google scopes.** Booking needs `calendar.events` and `calendar.freebusy` on top of Drive. Existing connections must reconnect once (Settings → Google); both scopes are required, and the OAuth app should be in production mode (a test-mode app drops its refresh token after 7 days; Google shows a one-time unverified-app warning). Until then Settings shows booking as unavailable and the report keeps the old `booking_url` link.
- **Reminders.** The `*/5 * * * *` cron in `wrangler.jsonc` sends the 24-hour, 60-minute and 10-minute reminder emails, once each (`booking_reminders`). It is the third trigger alongside the daily radar one and the 15-minute mail sync. Confirmation and reminders are the one kind of mail sent without an approval. Public booking routes are throttled by the `BOOKING_LIMITER` ratelimit binding (`namespace_id` 1002, 30 per minute per link and IP); without the binding, local runs are not limited.
- **Packages.** Settings → Packages is the price catalog (spec section 8). A price change saves a new version; every price, option and deck in the app reads from it. Care and Local SEO are separate lines.
- **Call prep and recap.** A booking queues a `call.prep` task; once you have saved call notes, the Recap tab queues a `call.recap` task. Both are worked by the same `/work-the-queue` skill. Claude writes the script and the three options; the numbers are yours and come from the catalog.
- **Pipeline and Deal page.** Pipeline (`/pipeline`) is a read-only board of deals by stage, from "Call booked" to "Lost". A deal (`/deals/:id`) has four tabs: Prep, Notes, Recap, Deck.
- **Deck.** The Deck tab opens `/deals/:id/deck`, a slide page built from the recap (slides chosen by lead type, three options, the middle one recommended). The API serves it at `/api/deals/:id/deck.html` and `/api/deals/:id/deck.pdf` (PDF needs the Browser Rendering binding). The first view or PDF freezes prices and inclusions on the deal (`/api/deals/:id/deck/freeze`); editing the options or accepting a new recap makes it a draft again.
- See `docs/superpowers/notes/2026-11-plan-4-open-items.md` for what still needs checking by hand.

## Close: proposal, e-sign and deposit
- **Proposal flow.** A deal at "Recommended" gets a Proposal tab (`/deals/:id`): pick one of the three options, edit the scope notes, read the preview, then "Send a test to me" or send for real. A real send is an approval (`proposal.send`) on Home: approving it freezes the content, stores its SHA-256, countersigns as you, mails the client link from the main mailbox and moves the deal to Proposal sent. Nothing reaches the client without that approval, and real sends are refused until the Oregon lawyer's review is recorded in Settings → Documents.
- **Client page.** The client opens `<CLIENT_LINK_BASE>/p/<token>`: the proposal, an ESIGN disclosure, a consent box and a typed-name signature. The page needs no login; a dead, expired or void link shows a closed page. Signing stores the client signature against the same hash, makes the signed PDF (with an audit page holding both signatures and the hash; needs the Browser Rendering binding), mails the signed copy to the client and a notice to you, and creates the deposit invoice. Public client routes are throttled by the `CLIENT_LIMITER` ratelimit binding (`namespace_id` 1003, 30 per minute per link and IP); without the binding, local runs are not limited.
- **Deposit and Won.** The deposit is a Stripe invoice (card and ACH on Stripe's hosted page) for the deposit in the payment schedule. The Stripe webhook at `/hooks/stripe` marks it paid, moves the deal to Won and the lead to won, and logs it on the timeline. Subscribe the endpoint to `invoice.paid`, `invoice.voided`, `invoice.marked_uncollectible` and `invoice.payment_failed`. A deal marked lost in the meantime is left lost, with a note to check it. Replaying an event changes nothing.
- **Env vars and secrets.** `CLIENT_LINK_BASE` (https host for client links, for example `https://clients.<your domain>`; never `workers.dev` and never the cold-email host; attach it to the Worker as a custom domain). Secrets, set with `npx wrangler secret put` (and `.dev.vars` locally): `STRIPE_SECRET_KEY` (a secret or restricted key; `sk_test_`/`rk_test_` is test mode) and `STRIPE_WEBHOOK_SECRET` (the endpoint's signing secret; unset, the webhook answers 503). A test copy never makes a live charge.
- **Settings → Documents.** The clause library (the exact wording a document will carry, shown for you to hand to your lawyer), the late fee, how many days a proposal stays open, and the record of the lawyer's review. Migrations 0051-0053 add the config, the documents and signatures, and the Stripe customers, events and invoices.
- **Expiry and follow-up.** The scheduled sweep (`src/worker/schedule.ts`) expires a proposal past its date (the deal stays at Proposal sent), and Today lists sent proposals that have gone quiet.
- Milestone and final invoices, subscriptions and change orders are Phase 2. See `docs/superpowers/notes/2026-11-plan-5-open-items.md` for the checks only you can run (Stripe test mode, the custom domain, the lawyer's review).

## Onboarding
- **Welcome approval.** When the deposit is paid (the Stripe webhook), the app starts an onboarding for the deal and queues a "Send the onboarding welcome" approval with the mail and the client's link in its preview. Approving it sends the welcome to the client and sets the due dates. A Deal's Onboarding panel holds the welcome video link, the kickoff date, extra items, accept / not needed / ask again on each item, file downloads, and the link controls (revoke, new link, close). "Start a test onboarding" rehearses the whole thing on a deal that has only a test proposal; its mail goes only to your own address.
- **Client page.** The client opens `<CLIENT_LINK_BASE>/o/<token>`: a questionnaire (answers save as they type, then submit once) and a checklist of things to send (text, or photos and files uploaded to private storage). No login. A dead or revoked link is a 404. Files are never served to the client or inline: only you download them, as attachments.
- **Daily sweep.** The daily cron (`src/worker/onboarding/sweep.ts`) queues reminders (after 2, 4, 7 and 10 days of silence) and a Friday update as approvals, notes a client who has been silent for 14 days on the lead's timeline, and Today lists items to review and clients who have gone quiet.
- **Config.** `CLIENT_LINK_BASE` (the same host as the proposal links; it must answer `/o/<anything>` with a 404 page). Uploads use the existing R2 `RAW` binding. Apply migration `0054_onboarding.sql` before deploying.
- Nothing is sent to a client without your approval. See `docs/superpowers/notes/2026-11-plan-6-open-items.md` for the checks only you can run and the decisions waiting for you.

## Projects
- **Start.** When a deposit is paid (the Stripe webhook), `startProjects` copies an SOP template into a project, one per sold job: a Starter, Growth or website-subscription package starts BUILD, a Quick Fix starts QUICKFIX, and Care starts CARE-0 (right away when there is no build, otherwise when the build finishes). Local SEO has no SOP yet and leaves a note on the lead's timeline. It runs once per (proposal, template), so a replayed payment starts nothing new. "Start projects" on the Deal retries a start that failed, and "Start a test project" rehearses it on a test lead (a test project mails only you and never goes to Claude on its own).
- **SOP templates.** Five are built in (`src/worker/sop/seeds.ts`, inserted by code when missing, never overwritten): BUILD, QUICKFIX, CARE-0, CARE-1 (weekly) and CARE-4 (monthly). They are yours to edit in Settings > SOPs. A client's SOP is that project's own tasks: editing one changes only that project, and "push back to template" saves it as the template's next version after a confirm.
- **Ready and gates.** A step is ready when it is to do, every step it requires is done (a skipped one counts only if the step is marked skippable), and it is in the project's current phase (the first phase with an unfinished step) or an earlier one. A step with unmet requirements cannot be started or finished: the answer names what it waits on (go live, for example, waits on every QA step). You can still work any step by hand. Two steps mark milestones: `design_approved` (BUILD 4.5) and `site_finished` (BUILD 6.8). Each is recorded once and runs the `onMilestone` hooks, which Plan 8 will invoice from.
- **Claude.** A ready step owned by Claude (or Claude drafting for you) is queued as a `sop.step` job for Claude Code to pick up over MCP; a drafts step comes back as a "review" approval, a finished one marks the step done. Dispatch is automatic for real projects only, at most 5 jobs in flight at once, and a step whose jobs failed or expired twice stops being sent on its own ("Ask Claude" always works). A project whose onboarding has been silent for 14 days is waiting on the client and dispatches nothing until the client writes.
- **Timer and timesheet.** One timer runs across the whole app (starting another saves the first). A timer left running is saved at 12 hours, one under 30 seconds is dropped, and time can be typed in after the fact. The timesheet week starts on Monday. A project shows its time, sold and paid amounts, and profit at your cost rate.
- **Change orders.** Small extra work becomes a change order: Claude can flag one over MCP (`change_order.draft`, which only drafts), you edit it, and sending it is an approval (`change_order.send`). A real one needs the legal review recorded in Settings > Documents; a test one mails only you. The client opens `<CLIENT_LINK_BASE>/c/<token>` and signs; its tasks stay locked until it is signed and paid. Until Plan 8 invoices it, "Mark paid" (with a confirm) records the payment and unlocks them.
- **Daily sweep.** The daily cron (`src/worker/projects/sweep.ts`, after the onboarding sweep) makes this week's and month's recurring Care tasks, starts any paid proposal that never got its project, sends ready Claude steps, expires old change orders and saves a stale timer. The Friday onboarding update carries "done this week" and "coming up next" lines built from each step's client summary, never a step's own title.
- **Config.** `CLIENT_LINK_BASE` must also answer `/c/<anything>` with a 404 page. Record the legal review in Settings > Documents before any real change order. Set your cost rate in Settings > Work (cost rate, week start, timer cap). Apply migrations `0055_projects.sql` and `0056_projects_sweep.sql` before deploying.
- Nothing is sent to a client without your approval. See `docs/superpowers/notes/2026-11-plan-7-open-items.md` for the checks only you can run and the decisions waiting for you.

## Meetings, MCP and Money
- **Meetily sync.** The 15-minute cron queues a `meetily.sync` job for the Mac helper when there is a booking or Google Calendar event in the last 72 hours. The helper reads Meetily's recordings read-only, matches them to those windows by time on the Mac, and uploads only the matches. A matched meeting shows in the client's Meetings panel (`/clients/:id`) and queues a `meeting.summarize` task for Claude: a summary, action items (Logan's become tasks), possible change orders (drafts only) and a follow-up email. The follow-up is an approval (`meeting.followup`) and is the only mail it sends, on your approval. Set `meetilyDb` in the helper's config if Meetily's file is elsewhere (see `helper/README.md`). Apply migration `0059_meetings.sql` before deploying.
- **MCP tools.** Beyond the queue tools (`next_claude_task`, `complete_claude_task`, `release_claude_task`, `queue_status`) and the lead and approval tools (`search_leads`, `get_lead`, `list_approvals`, `propose_approval`), the `agency-os` server reads clients and work: `search_clients`, `get_client`, `get_site`, `list_projects`, `get_project`, `list_open_tasks`, `get_deal`, `get_timeline`, `list_invoices`, `list_meetings`, `get_meeting` (the transcript only with `include_transcript`), `get_money_summary` and, for Care, `get_care_overview`, `get_care_updates` and `list_incidents`. The server has 28 tools. It acts through `run_audit`, `log_time`, `add_task` (for Logan only), `add_task_comment` and `add_note`. No tool returns a vault item name, an access note, a client's messages or onboarding answers, a token or a Stripe id (a recording's transcript is returned only by `get_meeting` with `include_transcript`); approval previews have client links cut to a prefix.
- **Money.** `/money` shows cash received this month and the last six, what is owed by age, MRR and churn, signed work booked and not billed, profit per project, lifetime value, and your freedom number (a monthly recurring target, set on the page). Money is integer cents, months are counted in the booking time zone, and test clients are left out of every figure. Profit uses the cost rate in Settings > Work. Apply migration `0060_money_config.sql` before deploying.
- Nothing is sent to a client without your approval. See `docs/superpowers/notes/2026-11-plan-10-open-items.md` for the checks only you can run and the decisions waiting for you.

## Care monitoring
- **Two crons.** The existing 5-minute cron probes each monitored site once per tick (up to 40 sites a tick, the ones checked longest ago first) and records a check; the existing daily cron looks up each monitored domain's expiry (a domain is looked up again after 7 days) and deletes checks older than 35 days. No new cron trigger.
- **What is monitored.** A real, live site with an address, whose client has a live Care subscription, or that you switched on by hand (the switch on the client's Care panel, `PUT /api/sites/:id/monitoring`). Test clients, test sites, archived sites and sites with no address are never probed, and an address on a private or internal network is never fetched (the site shows as "can't be monitored"). The probe is one GET following redirects; it reads no page body and stores only the status code and a fixed phrase.
- **Down rule.** A site is down on a network error, a timeout (10 seconds), a 5xx, a 404 or a 410; a 401 or 403 counts as up, and a response over 5 seconds is up and shown as slow. Two checks in a row failing open one incident; one good check closes it.
- **Domain rule.** Expiry comes from public RDAP (`rdap.org`). A domain within 30 days of expiry (or past it) opens one `domain_expiring` incident; a later answer more than 30 days out closes it. A domain the registry does not answer for shows "unknown" and opens nothing.
- **Today.** A client with an open incident gets one `site_incident` row: a site that is down is priority 90 ("ace.com has been down for 47 minutes"), a domain close to expiring is 66 ("ace.com expires in 12 days").
- **`/care`.** The Care board lists real clients on Care (or with a site switched on by hand), worst health score first, with uptime, each site's state and its open incidents. The client page has a Care panel with the health reasons, each site's state, uptime and domain expiry with the monitoring switch, and the last five incidents. Health is 0 to 100 (good 80 or more, watch 60 to 79, at risk below 60), made from open incidents, domain expiry, uptime, an overdue invoice, a billing hold, a failed subscription payment, missing site access and waiting on the client.
- **MCP.** `get_care_overview` (the board, worst first) and `list_incidents` (open or closed, one client or all) are read only. They show a domain, never an address, and no token, vault name or access note.
- **Nothing is sent to anyone.** Monitoring writes checks, incidents and a timeline line (`site_down`, `site_back`, `domain_expiring`) and nothing else: no mail, no approval, no task. You see an incident on Today, `/care`, the client page and through MCP.
- **Config.** None: no setting, key or secret.
- **When monitoring stops.** An open incident closes by itself, without a timeline line, once its site is no longer monitored: Care ended, the switch turned off, the address cleared, the site archived or marked test. The 5-minute tick does it, and turning the switch off, clearing an address or archiving a site does it at once.
- **Care updates limits.** The weekly update batch only touches WordPress sites with an SSH alias and a folder set, only after you approve each wave, and never imports a database (a rollback puts old code back; the backup file is named for you to restore by hand). It has never run against a real site, SSH, WP-CLI, Chrome, ffmpeg or TLS: see `docs/superpowers/notes/2026-11-plan-12-open-items.md` and `helper/README.md` ("Care updates") before the first client.
- **Rollback.** The Worker can be rolled back safely onto the new schema (the old code ignores the new columns and tables); the schema itself is rolled back only through the D1 Time Travel bookmark recorded before migrating.
- **Migration.** Apply `0061_monitoring.sql` to the remote D1 before deploying. See `docs/superpowers/notes/2026-11-plan-11-open-items.md` for the checks only you can run and the decisions waiting for you.

## Known limitations
- `/care` and the client Care panel have never been viewed in a browser (see the Plan 11 open-items note).
- The PageSpeed test fixture is hand-written, not a live capture. Capture one real PageSpeed response, then verify the Lighthouse audit ids in `src/worker/scoring/labels.ts` and the `viewport` / `font-size` / `tap-targets` audits used for mobile-friendliness (a missing audit counts as passing).
- No email notification for Radar.
- The booking page, Pipeline board, Deal page, deck layout and PDF have not yet been checked in a browser (see the Plan 4 open-items note). The same holds for the Proposal tab, Settings → Documents, the client proposal page and the signed PDF, and Stripe has only been exercised through a fake (see the Plan 5 note).
- After the first deploy, audits created before this release have no platform, so they appear under "not crawled" in the platform filter until they are re-audited.
- Lead workflows that are mid-run during a deploy can fail at the score step (their cached crawl result predates the new fields). Deploy when no search is running and no re-audit is pending; a failed lead shows a ⚠ and can be re-run with "Re-audit" on its lead page.
- The crawler's extractor gets slow on very large pages (roughly 5 s CPU at 1 MB; a separate task is filed to cap HTML size), and the HTML parser is slow on deeply nested unclosed markup.
