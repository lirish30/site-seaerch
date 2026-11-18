# Agency OS: design

*2026-11-17 · Status: draft for Logan's approval · Agency brand: Siteline (sitelineweb.com) · App working name: Agency OS*

Items marked **[Logan]** were decided by Logan in conversation. Items marked **[call]** are my calls, made with a reason, which Logan can overturn. Everything else is either context or explicitly left to the builder (§17).

Research this design rests on (all in `agency/research/`):
- `kb/pait-digital.md`, `kb/josh-hall-business.md`, `kb/josh-hall-process.md`, `kb/josh-hall-maintenance-seo.md`, `kb/josh-hall-pro-library.md`: course digests, including draft SOPs and app requirements. These are private reference; the source files are a resale copy, so never publish their content.
- `docs-survey.md` and `doc-extracts/`: Logan's Web Kit (packages, 11-stage sales process, outreach cadence, cold-call script, 19-slide deck, Operations.xlsx) and the Document Examples (13 document types).
- `repo-survey.md`: site-search, siteops, life-os, logan-local.
- `oss-and-costs.md`: open-source options and current prices.

---

## 1. What this is, and why

Logan is a web designer/developer employed at Webfor (an agency) who is starting his own solo web design + local SEO business on the side. He has no clients yet. His goal **[Logan]**:
- first client within about 3 months
- leave Webfor at about **$5k MRR**
- eventually run **40–50 clients by himself**, full time

Agency OS is the one app he runs that business from. It covers the whole life of a client:

> find leads → audit their sites → send a personalized narrated video audit → follow up → book a call → recommend → sign → get paid → onboard → deliver (build, Care, Local SEO) from SOPs → report → grow and retain.

**Why it has to exist:** one person can't serve 40–50 clients by hand. The design premise **[Logan]** is that **Claude does the tedious work and Logan stays in the loop.** Claude researches, audits, drafts, fills templates, runs checklists and writes reports. Logan reviews and approves anything that goes to a client or prospect, and does the human parts (calls, design judgment, relationships).

His stated biggest pains **[Logan]**: scope creep and not following up on invoices. Both get first-class treatment (change orders, contract clauses, automatic reminders, work-pause rules).

## 2. Goals, non-goals, anti-goals

**Goals**
1. Outreach running within about 4 weeks of starting the build, so the first client can land in month 3.
2. Every client, project, task, document, invoice, meeting, time entry and Claude action is tied together in one place. **[Logan]** He liked that ActiveCollab ties time, people and projects together "so you can tie it to an invoice."
3. Every piece of delivery work runs from an SOP. A package-level SOP becomes a per-client copy, and each step says who does it (Claude / Logan / Claude drafts → Logan approves) and when it's done.
4. Recurring work batches across clients (for example, all Care updates on one weekday), so 40–50 clients stay manageable.
5. Claude can operate the app two ways **[Logan]**: through an MCP server from Claude Code or the Claude app, and through scheduled background jobs. Anything outbound waits as a draft for Logan's approval.
6. Professional client experience **[Logan: "it needs to be more professional"]**: branded proposals, e-signing, Stripe invoices with card and ACH, private client links.
7. Setup cost close to $0 **[Logan]**, running cost at or under **$150/month** **[Logan]**.

**Non-goals (for now)**
- Multi-user or team features. Single user **[Logan: "just me for now, maybe clients later"]**, but every record is keyed to a client so a client portal with logins can be added later.
- Full accounting. It's a money dashboard only **[Logan]**. Stripe IDs are stored so QuickBooks (or similar) can be connected later.
- A phone-first app. Laptop-first **[Logan]**, phone view read-only.
- Publishing social posts automatically. Drafts only; Logan posts them for now.
- Linear. Dropped **[Logan agreed]**: tasks, time and invoices live inside the app (§9.6).
- Job hunting. **[Logan]** site-search's job-seeking features are removed: the `full-time` draft purpose, the unmerged `feat/job-watch` branch and its career-page watching. Any job-target leads in the live database are exported to a file and deleted from the app. The outreach mailbox never sends job-related mail.

**Anti-goals (failure even if it "works")**
- Building for months before any outreach goes out. Phase 1 is the money path only.
- Claude sending anything to a prospect or client without Logan's approval. Exception: rules Logan explicitly turns on later.
- Storing any password, API key for a client site, or login in the app. Only password-manager item names are stored.
- Using anything from Webfor: its documents' content, client names, results or pricing. Webfor material may inform structure only. Contacting Webfor clients or leads is a hard block.
- A blank-canvas, Notion-style tool. **[Logan: "Notion is too open ended"]** Everything has fixed structure and starts from templates.

## 3. Constraints

- **Budget:** about $0 setup; $150/month running, enforced in-app (§9.13). Free tiers and open source first, Logan's Mac for free heavy compute.
- **Existing app:** extends `~/Project Sites/site-search` (Cloudflare Workers + Hono API, React 19 SPA via Vite, D1, R2, 3 Cloudflare Workflows, Browser Rendering, daily cron, Claude via `@anthropic-ai/sdk`, zod, vitest with the Workers pool). It already handles lead search (Google Places, Bright Data, CSV/URL import), deep site audits, AI review and CRO scoring, a services catalog that maps findings to offers, Gmail *drafts*, suppressions, public audit reports at `/r/<token>`, and a $25/month usage cap. Known issue: two migrations numbered 0022 (`0022_search_fetch_attempts.sql`, `0022_settings_email_defaults.sql`), which must be resolved before new migrations go in.
- **No Google Workspace yet [Logan]:** Logan's email today is WPMU DEV hosted webmail on loganirish.com (MX → hostedemail.com). He doesn't want a $14/month Workspace bill before he has income. So Phase 1 must work **without Workspace [call]**:
  - **Email** goes through standard IMAP/SMTP (send over SMTP from the Worker via TCP sockets, read replies over IMAP). This works with his current host now and with Gmail/Workspace later, with no rework.
  - **Calendar and Meet** use a free Google account. The app reads and writes its calendar through the Calendar API. Free Meet allows long 1:1 calls; group calls are capped at 60 minutes, which is fine for sales calls.
  - **Upgrade to Workspace when the first deposit lands.** The spend tracker shows it as "unlocks at first client".
  - The builder must confirm early that the mail host allows SMTP/IMAP access and a mailbox on a second (outreach) domain, and what that costs. If it can't, fall back to a free or cheap custom-domain mailbox provider that supports IMAP/SMTP.
- **Meetily** **[Logan]**: free local meeting recorder already installed. Its SQLite database is at `~/Library/Application Support/com.meetily.ai/meeting_minutes.sqlite`. Read it read-only and never modify it.
- **Webfor conflict:** Logan still works there. He must check his own employment agreement for non-compete and non-solicit terms; that's his job, not the app's. The app enforces a do-not-contact list (§9.1).
- **Legal:** contract and SOW templates need review by an Oregon lawyer before first use. E-signing must meet the US ESIGN Act basics: intent, consent to do business electronically, record retention, and an audit trail.
- **Privacy:** client and Meetily data stay in Logan's own Cloudflare account and on his Mac. Unmatched meetings never leave the Mac. Logs and reports hold no secrets.

## 4. Approaches considered

| | Approach | Trade-off | Verdict |
|---|---|---|---|
| **A** | Grow site-search into the full app on Cloudflare, plus a small helper on Logan's Mac | One app, one database, one login, $0 extra hosting, starts from the piece needed first (prospecting). Proposals, invoices and the portal get built, not inherited. | **Chosen [Logan]** |
| B | Fork Directus AgencyOS (Nuxt + Directus + Postgres, MIT) for operations, with site-search kept for prospecting | CRM, proposals, invoices, Stripe and a client portal work on day one. But it means two apps in two frameworks (React and Vue) and two databases to keep in sync, a server to run at about $5–10/month, and time → invoice tying split across systems. Directus's license terms need checking. | Rejected. Its data model and portal are used as **reference only**. |
| C | New Next.js + Supabase app on the life-os pattern | Third stack, no reuse of site-search's Cloudflare work. | Dropped |

Also considered and rejected: Linear for tasks (no time tracking, built for software teams); open-source e-sign apps (DocuSeal, Documenso, OpenSign are AGPL and need their own server); Remotion (a paid license once a company has more than 3 people); Cal.com (closed-source as of 2026 per `oss-and-costs.md`).

## 5. Architecture

```
          Logan (laptop browser)            Claude Code / Claude app
                  │                                  │ MCP (authenticated)
                  ▼                                  ▼
 ┌──────────────── Cloudflare (site-search, grown) ─────────────────┐
 │ React SPA  ── Hono API ── D1 (all records) ── R2 (files, media)  │
 │ Workflows (multi-step jobs) · Cron (daily/weekly batches)        │
 │ Browser Rendering (audits, screenshots, PDFs, social images)     │
 │ MCP server endpoint · Public client links (/p/<token> …)         │
 │ Job queue table (work for the Mac helper)                        │
 └─────────┬──────────────────────┬───────────────────┬─────────────┘
           │                      │                   │
   Google APIs             Stripe (invoices,     Claude API
   (Gmail send/sync,       subscriptions,        (scheduled jobs,
   Calendar, Drive)        webhooks)             spend-capped)
           ▲
           │ polls for jobs, uploads results (device token)
 ┌─────────┴──────── Mac helper (Logan's laptop) ───────────────────┐
 │ Voice: Qwen3-TTS via mlx-audio (Logan's cloned voice)            │
 │ Video: HyperFrames (HTML → MP4, headless browser + FFmpeg)       │
 │ Meetily reader (read-only SQLite) · Playwright visual diffs      │
 │ WP-CLI / MainWP calls for Care sites (Phase 3)                   │
 └──────────────────────────────────────────────────────────────────┘
```

- **[call] One repo, one Worker, one D1 database.** Agency OS is site-search, grown. A rename of the repo or app is cosmetic and can happen whenever.
- **[call] The Mac helper is optional infrastructure.** If the laptop is off, its jobs wait in the queue. Nothing client-facing depends on it in real time. Heavy media (voice, video) is produced during Logan's morning session, when the laptop is on anyway.
- **[call] Auth:** single user. Passkey sign-in (WebAuthn, as in life-os), with the current `APP_PASSWORD` kept as a fallback. Google OAuth is used only to connect the Calendar, not to sign in. The MCP server and the Mac helper each get their own revocable tokens.
- **[call] Mail layer:** one provider-agnostic mail module (SMTP send, IMAP sync, per-mailbox settings, credentials stored as Worker secrets, never in D1). It covers two mailboxes: the main brand mailbox (clients, proposals, invoices) and the outreach mailbox (cold sequences). A prospect's thread stays on the outreach mailbox until they book a call; after that, everything comes from the main mailbox.
- **Brand and domains [Logan]:** the agency trades as **Siteline**, with Logan as the visible founder. The name pairs a *sightline* (a clear view from a ridge) with a website. The brand domain is **sitelineweb.com**. **[call]** The outreach domain is **hellositeline.com**. Both were available on 2026-11-18. Buy both through Cloudflare Registrar (~$10–12/yr each) on the same day, so DNS and Workers custom domains are simple. loganirish.com (DNS already on Cloudflare) stays as Logan's personal site and links to Siteline.
  - Pages linked from **cold email** (video audit landing pages, booking) are served on a subdomain of **hellositeline.com**, so cold links never point at the main brand domain.
  - Pages for **signed-up or engaged clients** (proposal, sign, pay, onboarding, reports) are served on `clients.sitelineweb.com`.
  - Nothing is ever linked on `workers.dev`.
  - The brand name and both domains must be settled before Phase 1 week 1, because outreach warm-up can't start without them.
- **Client-facing pages** are public routes with unguessable tokens, extending the existing `/r/<token>` pattern. Pages: audit report + video, proposal, sign, pay, onboarding questionnaire and content upload, monthly report. Tokens can expire and be revoked. Views are tracked.
- Everything multi-step (audit → video → email, onboarding sequences, monthly batches) runs as a Cloudflare Workflow, so steps retry and can wait for an approval.

## 6. How it looks and feels

**[Logan]** HubSpot-style structure and ActiveCollab-style project/time views. Not Notion.

- **Today** (home): drafts waiting for approval (grouped by type, approve in bulk), follow-ups due, overdue invoices, today's tasks across all clients, meetings, spend vs cap, MRR vs the $5k goal.
- **Record pages** for leads, clients, projects and deals, all with the same layout: details on the left, timeline in the middle (emails, calls, meeting summaries, invoices, approvals, Claude actions, newest first), linked things on the right.
- **Boards:** sales pipeline by stage; projects by SOP phase.
- **Projects list** grouped by client, with a progress bar, a label (Build / Monthly / Change order), and last activity.
- **Project tabs:** Tasks · Conversations · Files · Notes · Time · Activity.
- **My Work:** agenda, a weekly timesheet grid by project and task (like ActiveCollab), and an activity feed.
- **Templates everywhere:** new documents, SOPs, emails and reports always start from a template.

```
┌ Acme Plumbing ─────────── Care $129/mo · Health 82 · A-client ┐
│ About            │ Timeline                 │ Linked         │
│ Owner, phone     │ ▸ Today: Claude drafted  │ Project: Site  │
│ Site, host, DNS  │   May report (approve)   │ Invoices (2)   │
│ Logins: 1Pass    │ ▸ Nov 3 meeting summary  │ Docs: SOW v2   │
│   item names     │ ▸ Nov 1 invoice paid     │ Tasks (4 open) │
│ Package & terms  │ ▸ Oct 28 change order    │ Next: renewal  │
└──────────────────┴──────────────────────────┴────────────────┘
```

## 7. Core records (data model outline)

The builder owns the exact schema. These are the things the app must know about and how they connect. Existing site-search tables (`businesses`, `audits`, `contacts`, `people`, `activity`, `drafts`, `cro_audits`, `services`, `suppressions`, `audit_reports`, `usage`, `settings` …) are reused and extended rather than duplicated.

- **Organization**: a lead or a client. Same record; the stage changes. It carries niche, location, grade (A/B/C), health score, and do-not-contact flags.
- **Contact**: people at an organization, with roles (owner, decision-maker, billing).
- **Site**: one or more per organization. Fields: URL, CMS, host, registrar, DNS provider, admin URL, hosting tier (Logan-hosted / client-hosted), access method (SSH+WP-CLI / MainWP / none), **password-manager item names only**, Care status, monitoring status.
- **Audit**: exists. Extended with a link to its video and its landing page.
- **Video audit**: script, annotations, narration audio, render status, MP4/GIF in R2, landing page token, view events.
- **Sequence / Message**: outbound emails (from drafts), sent messages, synced Gmail threads, replies, stop events.
- **Deal**: pipeline stage, recommended option, value, source, close date, lost reason.
- **Package / Price**: the catalog in §8, editable, versioned. Old deals keep the price they were sold at.
- **Document**: proposal, SOW, contract, change order, report, deck … Has a template, version, status (draft / sent / viewed / signed / void), content, PDF, and signature records.
- **Signature**: signer, timestamp, IP, user agent, consent text, document hash (SHA-256), PDF with an audit page.
- **Project**: build, Care onboarding, SEO onboarding, change order. Linked to a deal or package and an SOP instance.
- **SOP template / SOP instance / Step**: see §9.6.
- **Task**: a step instance or an ad-hoc task. Fields: assignee (Logan / Claude), due date, estimate, billable flag, status, checklist, comments.
- **Time entry**: task, minutes, billable, note, invoiced-on reference. Covers both timer and manual entries.
- **Edit-time ledger**: monthly Care allowance per client, used, remaining. No rollover.
- **Invoice / Subscription / Payment**: mirrors Stripe (stores Stripe IDs), plus the reminder schedule and pause state.
- **Meeting**: calendar event, attendees, matched organization, transcript (if matched), summary, action items, scope-change flags.
- **Approval**: anything waiting for Logan. Fields: what, preview, who drafted it (Claude job / MCP session), decision, edits made.
- **Agent action log**: every Claude action (MCP or scheduled), with inputs summary, outputs, cost, and the record it touched.
- **Do-not-contact list**: names, domains and emails, including Webfor clients that Logan enters himself.

## 8. Packages and pricing **[Logan approved]**

Stored as editable settings (the package catalog). Prices end in 7 for one-time work and 9 for monthly.

| Rung | Price | What's in it | SOP |
|---|---|---|---|
| Free video audit | $0 | Outreach hook. Each finding maps to the paid rung that fixes it (extends the existing `services` mapping). | PROSPECT |
| Quick Fix | $797 one-time | Fixed scope: top 3–5 audit problems fixed. | QUICKFIX |
| Starter Site | from $3,997 | Up to 5 pages. 50% to start; final 50% due when the site is **finished**, not at launch. | BUILD |
| Growth Site | from $6,997 | Up to 12 pages, service + city pages, copywriting, review-request setup. 40/30/30. | BUILD (+content) |
| Website Subscription | $297/mo × 24 + $497 setup | Site + hosting + Care. Early exit owes the remaining term. Month 25 converts to Care automatically unless the client picks a refresh. | BUILD + CARE |
| Care | $129/mo or $1,290/yr | Hosting included; weekly updates, backups, uptime, security, monthly report, 1 hr edits/mo (no rollover). | CARE-0…7 |
| Care Plus | $249/mo | Adds daily backups, staging for updates, 3 hrs edits, quarterly call, form/booking monitoring, priority. | CARE-0…7 |
| Care (fallback) | $79/mo | Unpublished; offered only to a client about to cancel. | CARE |
| Client-hosted surcharge | +$30/mo | When a Care client keeps their own host. | |
| Local SEO | $750 setup + $797/mo, 6-month first term | GBP routine, review requests and replies, citations, 2 content pieces a month, rank reporting. | SEO-0…3 |
| Local SEO Growth | $1,497/mo | Plus 4 content pieces a month, links, schema, call tracking. | SEO-0…3 |
| Reviews add-on | $99/mo | Review requests and reply drafts (already included in Local SEO). | REVIEWS |
| Hourly | $125, or $95 for Care clients | Billed in 30-minute blocks; used for change orders. | |

**Rules the app enforces:**
- Care is on by default on every new-site SOW.
- SEO is never bundled into Care.
- Discounts apply only to setup fees, never to monthly prices.
- After every 2–3 closes at a price, the app suggests a ~10% raise.
- Grandfathered prices stay on existing clients.

**Payment defaults [Logan, carried from earlier]:**
- Deposit before work starts.
- Retainers on monthly autopay.
- Change orders paid upfront or on the next invoice.
- Reminders before the due date, on it, and at +3 and +7 days.
- Work pauses at +14 days overdue, per the contract.

**Freedom-number tracker:** MRR vs $5,000. Example mix: 15 Care + 3 Local SEO + 3 Subscriptions = $5,217 from about 21 clients. It also shows lifetime value per client, and capacity vs 40–50 clients.

## 9. Modules

### 9.1 Prospecting and audits (exists; extend)
- Keep: searches, Places/Bright Data sources, deep audit, AI review, CRO, scoring, radar cron, saved filters.
- Add a **niche test**:
  - search 4–5 home-service trades around Sherwood, Tigard, Tualatin and Wilsonville
  - compare the trades on average site score, job value (Logan enters or Claude estimates) and competition
  - after about 50 audits, show which trade to commit to **[Logan: home services; pick the trade from data]**
- Add **campaigns**: a niche + region + message set. Leads, scripts, deck examples and audit emphasis are per campaign, so a second niche (e.g. manufacturing) is cheap later.
- Add the **conflict gate**: every lead is checked against the do-not-contact list, suppressions and existing clients before any outreach step. A hit blocks outreach and shows the reason.

### 9.2 Video audit pipeline
1. Browser Rendering captures full-page desktop and mobile screenshots plus a scroll capture (exists in part).
2. **Annotation editor**: Claude pre-places markup (circles, arrows, blur, callout text) on the findings it plans to talk about. Logan adjusts and adds comments.
3. Claude writes the script in Logan's voice (`logan-voice` skill): hook, 3 problems with their business result, the offer, a CTA to book a call. About 90–120 seconds.
4. Narration: **[Logan]** an AI clone of his voice by default, with the option to record himself in the browser and re-record single lines.
   - Engine **[call]**: free, open-source models only, run on the Mac ($0). **[Logan: no paid voice service]** Before Phase 1 ends, A/B test three of them on Logan's real voice and let him pick:
     - Qwen3-TTS (Apache-2.0) via mlx-audio
     - Chatterbox (Resemble AI, MIT)
     - OpenVoice V2 (MyShell, MIT)
   - If none sounds right, Logan records the narration himself.
5. HyperFrames renders the MP4 on the Mac: zooms and callouts timed to the narration, plus an animated GIF thumbnail.
6. A landing page (extends `/r/<token>`) shows the video, the audit report and a booking link, and tracks views and watch depth. The email embeds the GIF linking to the page.
7. Footer note "Narrated with an AI version of my voice" is on by default **[Logan agreed earlier]**.
8. The same pipeline is reused later for monthly client report videos.

### 9.3 Outreach
- Sending is from a **mailbox on a separate outreach domain** (a variation of the brand domain), through the mail layer in §5, with SPF/DKIM/DMARC set. There is a **30–60 day warm-up**, so start it in Phase 1, week 1. **[call]**
- Volume: about 15–25 video audits a week. That's under Gmail's limits, so no bulk tool or paid warm-up is needed. **[call]**
- Sequence **[Web Kit]**:
  - Email 1 on day 0 (video)
  - Email 2 on business day 5
  - optional call on day 7
  - Email 3 on day 12
  - a 90-day check-in
  - Each email has variants. A physical address and an opt-out are always included. Any "stop" ends every channel.
- **Change from today:** the app sends over SMTP after Logan approves in the app. Today it only creates Gmail drafts, and that Gmail-drafts code is retired. **Thread sync** over IMAP detects replies, bounces and out-of-office messages, then stops the sequence and moves the deal to *Replied*.
- Reply handling: Claude classifies each reply (interested / question / not now / stop) and drafts a response for approval.

### 9.4 Sales: call, recommend, close
- **Booking [call]:** a booking page built into the app on top of the Google Calendar API. It checks free/busy, creates the event with a Meet link, and attaches the booking straight to the lead record. This avoids needing a higher Workspace plan for booking-form questions and reminders, and matches bookings to leads exactly. The booking form asks qualifying questions, and the lowest budget option sits at or above the minimum engagement **[Pait]**. Reminders go out 24h / 60m / 10m before, sent by the app.
- **Call prep, generated per lead:** a custom call script from the 20-minute discovery structure and 10 questions in the Web Kit, the audit's top flags, and pushback answers for the campaign's niche.
- **After the call:** if the call was recorded in Meetily and matched (§9.10), Claude drafts the recap and recommendation. If not, Logan types notes.
- **Recommendation:** a deck built from the 19-slide template. Slides are chosen by lead type, with three options and the middle one recommended **[Web Kit]**. It's an HTML deck with PDF export.
- **Proposal / SOW:** generated from templates and the clause library.
  - The doc header holds version, reference number, expiry (30 days) and signatures.
  - Scope blocks, an assumptions and out-of-scope list, phases with payment milestones, and change control.
  - **[Pait/Josh]** Send the agreement directly and book the kickoff before hanging up.
- **E-sign [call]:** built in, click-to-sign with typed name, consent checkbox, ESIGN-style disclosure, SHA-256 hash of the final document, and an audit page added to the PDF (pdf-lib). PDFs come from Browser Rendering's PDF endpoint.
- **Pay:** signing triggers the Stripe deposit invoice (card + ACH) on the same page. Payment moves the deal to *Won* and starts onboarding.

### 9.5 Onboarding
- **[Josh/Pait]** Three steps, one small step at a time:
  1. A welcome email with a personal video under 1 minute (Logan records it, or a template).
  2. A questionnaire due within 2 days, through a client link.
  3. Kickoff within 3–4 days.
- **Content collection:**
  - a client upload page with per-field instructions and phased due dates (phase 1 = homepage + one service page)
  - a Friday "done / next / waiting on you" email, auto-drafted for approval
  - escalating reminders
  - after 14 days of silence, the back-of-queue clause applies and the project moves to *Waiting on client*
- **Site access checklist:** host, DNS, registrar, admin, GBP and analytics access. Stored as password-manager item names only.
- Plan for client delays of 15–25% in every timeline estimate **[Pait]**.

### 9.6 Projects, tasks, SOPs, time (replaces Linear) **[Logan]**
- **SOP template** (per package or service): phases → steps. Each step has:
  - owner tag: `Claude` | `Logan` | `Claude drafts → Logan approves`
  - estimated time and a done-when
  - optional linked document template or email template
  - cadence for recurring steps (weekly, monthly, quarterly)
- **SOP instance**: a per-project copy that Logan can edit for that client (the "more detailed per-client SOP"). Changes can be pushed back to the template.
- Steps become **tasks**. `Claude` steps run as agent jobs and post results; `Claude drafts → Logan approves` steps create Approvals.
- **Recurring cadences** generate one checklist task per client per period (e.g. "Care — November" with that month's steps as its checklist), like ActiveCollab's recurring "Monthly Project Review" but with the SOP built in instead of a linked Google Doc.
- **Batch views:** run a step type across all clients at once (e.g. Wednesday update batch, monthly reports on days 1–5).
- **Time:** a start/stop timer on any task, manual entry, a weekly timesheet grid, estimate vs actual, and a billable flag. Time feeds:
  - hourly and change-order invoices
  - the Care edit-time ledger
  - profit per project (revenue minus time × an internal cost rate, plus API spend)
- **Change orders:** if a client request falls outside scope (Logan flags it, or Claude flags it from an email or meeting), the app drafts a small change-order document. It holds the Josh/Webfor-structure "small feature proposal" fields, an hourly estimate and a price. The client signs and pays through a client link, and only then does the task unlock.
- **Capacity:** hours booked per week vs a limit Logan sets; warn before accepting new work.
- Seed SOPs (sources in parentheses):
  - **PROSPECT** (Web Kit 11-stage process)
  - **BUILD**: the about-55-step draft in `kb/josh-hall-process.md` §7, merged with Josh Business §5 and Pait onboarding. Includes the review rule: show only header, footer, home and 1–2 inner pages first, with a ≤5-minute walkthrough video; build the rest after approval; final review mid-week, launch Friday; forms tested early; "go live" stays blocked until the launch checklist is green.
  - **QUICKFIX**
  - **CARE-0…7** and **SEO-0…3** (`kb/josh-hall-maintenance-seo.md` §10)
  - **REVIEWS**
  - **OFFBOARD / GROW**: the post-launch ladder (§9.12)

### 9.7 Billing (Stripe)
- Stripe Invoicing for one-time invoices: deposit, milestones, final, change orders, hourly. Hosted pages accept card + ACH (ACH ~0.8% capped at $5).
- Stripe Billing subscriptions for Care, Local SEO, Subscription, Reviews; monthly or annual.
- Webhooks update the app: paid, failed, overdue, cancelled.
- The reminder schedule is per §8. At +14 days: tasks for that client are paused, Logan is notified, and Claude drafts a pause notice for approval.
- Subscription term tracking: 6-month SEO first term, 24-month Subscription term end with automatic conversion to Care, early-exit balance.
- Branding: Logan's logo, colors and business details on invoices and documents.
- Store every Stripe ID, so an accounting tool can be connected later.

### 9.8 Care fleet (Phase 3)
- **Logan-hosted sites [Logan: ideally his own; accept client hosts]:**
  - one managed platform
  - Claude runs updates, backups and checks via WP-CLI over SSH
  - MainWP free core as the dashboard
  - uptime checks from Cloudflare cron (UptimeRobot free tier as backup)
- **Client-hosted sites:** allowed if SSH+WP-CLI or a MainWP child plugin works. If not, the onboarding checklist flags it, and Claude drafts a "let me move you" recommendation.
- **Weekly update batch [Josh]:**
  - Run on one fixed weekday, grouped by site type.
  - Major updates wait a week, then go to one or two sites first. Big changes use staging. No unattended auto-updates.
  - After updates, the Mac helper runs Playwright before/after screenshot diffs (siteops idea), and the app checks that forms still work.
  - Failures create incidents (CARE-5).
- **Monthly report:** generated per client from monitoring data, edit time used and work done. Claude drafts it, Logan approves, and it's sent as a client link with a short summary email.
- **Hack cleanup:** offered only if the client joins Care (~$250–499) **[Josh]**.
- Care contract clauses: 24–48 business-hour response, one point of contact, full control on exit, liability release on decline or cancel **[Josh]**, plus the non-payment suspension Josh lacks.

### 9.9 Local SEO delivery (Phase 3)
- SEO-0 baseline:
  - GBP audit and rebuild
  - citations/NAP
  - service + city pages plan (5–8 service-area towns)
  - footer NAP linked to the Maps URL
  - tracking
  - AI-search readiness (schema, llms.txt, AI-visibility check)
- SEO-1 monthly batch:
  - 3–5 GBP photos and one post
  - review requests and reply drafts
  - 2 (or 4) content pieces drafted by Claude, approved by Logan
  - rank and GBP reporting
  - a strategy note
- No ranking promises, ever.
- Expectations are set at the sale: a 6-month first term and a known results timeline.

### 9.10 Meetings (Meetily)
- The Mac helper reads Meetily's SQLite **read-only** on a schedule.
- It matches each meeting to a client or lead by Google Calendar event time and attendee emails.
- **Only matched meetings** are uploaded (transcript + Meetily's notes). Unmatched ones (e.g. Webfor meetings) never leave the Mac.
- Claude summarizes each matched meeting, extracts action items into tasks, flags anything that sounds out of scope as a possible change order, and drafts the follow-up email.

### 9.11 Studio
- **For Logan's own agency marketing [Logan]:** social images built from real work:
  - before/after posts
  - audit-tip carousels from real findings, anonymized unless the client agreed
  - case studies once results exist

  These are HTML templates rendered to PNG via Browser Rendering. Claude drafts the copy and Logan approves. Posting is manual for now.
- **Client-facing:** recommendation decks, proposal/SOW PDFs, audit reports, monthly reports, kickoff deck (our responsibilities vs yours, per phase), strategy memo.
- **Decks [call]:** HTML decks with PDF export. PPTX/Google Slides export is optional later.
- **Videos:** audit videos (§9.2); report videos later.

### 9.12 Grow and retain
- Post-launch ladder **[Josh]**:
  1. Google review request at launch
  2. video testimonial at +1–2 weeks
  3. thank-you package at about +1 month
  4. 3-month check-in
  5. case study at 3–6 months
  6. annual December letter

  Each one is a scheduled draft for approval.
- Referral ask (Web Kit).
- Client grade A/B/C, set by Logan with a suggestion from Claude.
- Health score: payment history, responsiveness, scope-change frequency, plan tier, site status. Low health shows on Today.
- Renewals and term-end alerts. Price-raise suggestions.

### 9.13 Agent layer
- **MCP server** (on the Worker, life-os `mcp-handler` pattern as reference). Tools:
  - read: search records, read a record and its timeline
  - act: run an audit, create drafts, complete `Claude` steps, log time, attach files
  - **Outbound actions only ever create Approvals.**
- **Scheduled jobs:** cron + Workflows call the Claude API for batch work: morning prospect prep, follow-up drafts, Friday updates, monthly reports, meeting summaries.
- **Approval inbox:** every outbound item (email, invoice send, document send, social draft, client-link publish) waits here. Bulk approve, edit-then-approve, reject with a note. Later, Logan can turn on auto-approve rules per type (e.g. "invoice reminders on schedule").
- **Action log:** every agent action is logged with cost and the records it touched, and shows on those records' timelines.
- **Spend control:** one tracker across Claude API, lead data, Cloudflare, Workspace seats (once active) and domains.
  - total cap $150/month, with per-service sub-caps
  - warn at 80%
  - at the cap, optional jobs pause (radar searches, re-renders); approved and in-flight work continues
  - extends site-search's existing `usage` table and $25 Claude cap
- **Prompts:** role prompts may borrow from `msitarzewski/agency-agents` (MIT; already installed in Logan's Claude setup). For example, SEO Specialist and AI Citation Strategist for SEO work, Accessibility Auditor for audits, Evidence Collector for QA. Client-facing copy is written in Logan's voice (`logan-voice` skill).

### 9.14 Money dashboard
Revenue, AR aging, MRR and churn, booked-not-billed, profit per project, LTV per client, the freedom-number tracker, monthly running costs vs the $150 cap.

## 10. Documents and templates

Each of these is a template with merge fields from records. Structure is informed by the Document Examples; content is written fresh, and Webfor content is never copied.

| Document | Notes |
|---|---|
| Audit report | Exists (`/r/<token>`); add the video and the option mapping |
| Recommendation deck | 19-slide template, modular by lead type |
| Proposal + SOW | Header block, scope, assumptions, out of scope, phases/milestones, change control, expiry, signatures |
| Master service agreement / contract | Clause library (§11) |
| Care agreement | Josh's 15 clauses + suspension |
| Liability release | Sent on Care decline or cancel |
| Change order | "Small feature proposal" structure |
| Onboarding questionnaire / intake | Plus Josh's 10 design-strategy and 6 SEO intake questions |
| Kickoff deck | Responsibilities per phase |
| Sitemap / strategy memo | |
| Monthly Care report / Local SEO report | Traffic and rank structure |
| Launch pack / "Moving forward" page | Josh |
| Pause / overdue notices, welcome, Friday update, follow-ups | Email templates |

## 11. Contract clause library **[Logan approved the additions]**

All clauses need review by an Oregon lawyer before first use. They include:
- scope and exclusions
- change orders at the hourly rate
- 2 revision rounds
- content delays: back of the queue after 14 days of silence, re-quote after 6 months
- payment terms per package; final payment due when the site is finished, not at launch
- late fee
- work pause at 14 days overdue
- 25% kill fee
- ownership transfers on full payment
- 30-day warranty
- 30-day termination notice
- Care opt-out sign-off (client accepts hosting/security responsibility)
- client-supplied content and legal pages
- AI-generated content disclosure
- accessibility disclaimer
- site credit link
- no ranking guarantees

## 12. Phasing

**Phase 1: Money path (target about 4 weeks of build).** Exit criterion: the first 25 video audits have been sent from the warmed domain, and a test lead can go all the way to *signed + deposit paid* on a test Stripe account.
- Resolve the duplicate 0022 migrations. Add Google sign-in. Set up the outreach domain and mailbox, and **start warm-up in week 1**.
- Niche test and campaigns, the conflict gate.
- Video audit pipeline, including the Mac helper (voice + HyperFrames) and the voice A/B test.
- Sequences with Gmail send after approval, thread sync and reply handling.
- Booking, call prep, recommendation deck.
- Proposal/SOW, e-sign, Stripe deposit.
- Today + approval inbox, basic MCP server (read, draft), spend tracker.

**Then:** about 8 weeks of outreach while still employed. Logan approves drafts for about 20 minutes each morning.

**Phase 2: First client (built while outreach runs; must be ready by the first signature).**
- Onboarding, questionnaires, content collection.
- Projects, SOP engine, tasks, time, change orders.
- Stripe invoices and subscriptions with reminders and pause.
- Client and site records with access checklist.
- Meetily integration. Full MCP toolset. Money dashboard v1.

**Phase 3: Clients 5–10.**
- Care fleet automation, Local SEO delivery, monthly reports (and report videos).
- Health, grade, capacity. Post-launch ladder.
- Studio social images and remaining decks. Batch views. Auto-approve rules.

**Anti-goal check:** if Phase 1 runs past about 6 weeks, cut scope (e.g. ship sequences without reply classification) rather than delay outreach.

## 13. Running costs (from `oss-and-costs.md`; builder re-verifies)

| Item | Monthly |
|---|---|
| Cloudflare Workers Paid (needed for Workflows/Browser Rendering limits) | ~$5 |
| Email: existing WPMU DEV hosted mail until first client (builder confirms any extra-mailbox cost) | ~$0 |
| Google Workspace, 2 seats, **only from the first deposit** (counts toward the cap then) | $0 now, ~$14 later |
| Brand domain + outreach domain | ~$2 (about $20–24/yr) |
| Claude API (capped) | ~$15–60 |
| Lead data (Places / Bright Data pay-as-you-go) | ~$5–20 |
| Voice: local open-source models (Qwen3-TTS, Chatterbox, OpenVoice V2) | $0 |
| MainWP core, HyperFrames, mlx-audio, Playwright, Uptime checks | $0 |
| **Lean before first client / comfortable after** | **~$25–35 / ~$148** |

Stripe fees are per transaction and paid out of client revenue; the Stripe Invoicing/Billing percentage fees still need checking. Client hosting costs begin with clients and are covered by Care pricing.

## 14. Decided by Logan (summary)

- Solo, single-user, laptop-first.
- Approach A. Linear dropped for in-app tasks.
- Home services niche, with the trade chosen from data.
- Studio social is for his own marketing.
- AI voice clone with an option to record himself.
- Stripe only, no Venmo. Money dashboard, not accounting.
- Both ways for Claude access, with approval drafts.
- No Google Workspace until there's income; Google Meet for calls. Meetily.
- No job-hunting features in Agency OS.
- Hosting: his own, but client hosts accepted.
- $150/month running, about $0 setup with open source.
- The package ladder and contract additions.
- Goals: first client in about 3 months, leave at $5k MRR, 40–50 clients eventually.

## 15. My calls (Logan to check while reading)

1. Separate outreach domain, no bulk tool or paid warm-up.
2. Passkey sign-in; Google OAuth only for the Calendar (free Google account). Email over IMAP/SMTP until Workspace arrives at the first deposit.
3. Mac helper with a job queue for voice, video, Meetily, diffs and WP-CLI; jobs wait when the laptop is off.
4. Voice from free open-source models only, run locally: Qwen3-TTS, Chatterbox and OpenVoice V2, A/B tested on Logan's voice. No ElevenLabs. **[Logan]**
5. Built-in click-to-sign instead of an e-sign product.
6. Booking page built into the app over the Calendar API, not Google's appointment schedules (keeps it on the cheapest Workspace plan and ties bookings to leads).
7. HTML decks with PDF export.
8. Profit per project uses an internal hourly cost rate Logan sets.
9. Unmatched Meetily meetings never leave the Mac.
10. The Phase 1 exit criterion and the 6-week scope-cut rule.
11. Domains: cold-email links on the outreach domain; client pages on `clients.loganirish.com`.
12. Every Workspace seat counts toward the $150 cap.

## 16. Risks and open items

- **Deliverability:** a new domain with too little warm-up gets cold mail spam-foldered. Start warm-up in week 1, and don't send before day 30.
- **Voice clone quality** may not pass with any of the three free models. The fallback is Logan recording the narration himself in the browser, which is still $0.
- **Webfor:** non-compete/non-solicit terms are Logan's to check before outreach starts.
- **Legal:** templates need review by an Oregon lawyer; also check Oregon auto-renewal rules for subscriptions and sales-tax treatment.
- **Laptop dependency:** media jobs need the Mac on. That's acceptable for a laptop-first solo user.
- **Mail host limits:** the current host must allow SMTP/IMAP and a second-domain mailbox at an acceptable send rate. Confirm this in week 1. Cheap shared mail hosts can also hurt deliverability, so watch bounce and spam rates from the first sends.
- **Google Calendar scope on a free account:** the OAuth app runs in production as an unverified app for Logan's own use. He'll see a one-time warning, which is acceptable. Testing mode is not acceptable, because its refresh tokens expire after 7 days.
- **Unverified research claims** (Cal.com licensing, exact API prices, MainWP Pro needs): re-check at build time.

## 17. Left to the builder

- Exact schema and migrations, and how existing tables are extended vs added.
- UI component choices within the existing React app.
- Workflow boundaries and retry policies.
- Which Claude model handles which job, within the spend cap.
- MCP tool names and shapes, and the auth mechanism details.
- How the Mac helper is packaged (launchd agent, CLI, menu-bar app) and its polling interval.
- Health-score formula.
- Test strategy (vitest + Workers pool already in place).
- Repo/app rename timing.

## 18. Before Phase 1 starts (Logan's to-dos)

- **Siteline name checks.** Search the USPTO trademark database and the Oregon Secretary of State business registry for "Siteline". On 2026-11-18, a web search found no agency using the name.
- **Buy sitelineweb.com and hellositeline.com** on the same day. The 30–60 day warm-up starts once the outreach mailbox exists.
- **Webfor employment agreement:** check the non-compete and non-solicit terms before any outreach goes out.
