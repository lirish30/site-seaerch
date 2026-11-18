# Agency OS — Plan 2 of 5: Mail + Sequences Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Send cold-email sequences from a separate outreach mailbox, only after Logan approves each email. Read replies back over IMAP, stop sequences on replies, bounces and "stop", and block anyone on the do-not-contact list. Add campaigns with a niche test, per-service spend sub-caps, and the Claude task queue that classifies replies without the paid API.

**Architecture:** One provider-agnostic `src/worker/mail/` module. SMTP send and IMAP read run from the Worker over TCP sockets. Both sit behind injectable functions (`getMailDeps`/`setMailDeps`), so every test uses fakes. Outbound mail exists only as an `email.send` approval kind that Plan 1's registry already supports; its handler re-checks everything at send time. A sequence engine creates approvals when steps fall due (scheduled), and an IMAP sync (scheduled every 15 minutes) stops sequences on replies. Credentials are Worker secrets. Mailbox settings, messages, enrollments, campaigns and the do-not-contact list are D1 tables.

**Tech Stack:** Existing stack plus `worker-mailer@1.3.1` (SMTP over `cloudflare:sockets`, subject to the Task 2 spike), `postal-mime@4.2.1` (parse inbound mail), and an IMAP reader chosen in Task 3 (`imapflow@2.12.1` if it runs in workerd, otherwise a minimal hand-written client).

**Spec:** `/Users/loganirish/Project Sites/agency/docs/specs/2026-11-17-agency-os-design.md`, copied into this repo by Plan 1 at `docs/superpowers/specs/2026-11-17-agency-os-design.md`. Sections this plan implements: §3 (no Workspace; IMAP/SMTP), §5 (mail layer, two mailboxes), §9.1 (niche test, campaigns, conflict gate), §9.3 (outreach), §9.13 (queue without the API, sub-caps), §12 Phase 1 lines "Niche test and campaigns, the conflict gate" and "Sequences … thread sync and reply handling". Plan 1 is merged to `main` (approvals registry, `agent_actions`, spend status, passkeys, MCP at `/mcp`).

**Phase 1 roadmap** (unchanged): 1 Foundations (done) · **2 Mail + sequences (this plan)** · 3 Video audits · 4 Sales · 5 Close.

## Global Constraints

- Branch `feat/agency-os-mail` from `main`. Plan 1's last migration is `0027_passkeys.sql`, so migrations here start at `0028`, one number per file. If `main` has moved, take the next free numbers and keep the order. Never edit an applied migration.
- Nothing is sent to a prospect without an approved `email.send` approval (spec §2). Claude, cron and MCP can only create approvals.
- Mail credentials live in Worker secrets only, never in D1 (spec §5): `MAILBOX_OUTREACH_PASSWORD`, `MAILBOX_MAIN_PASSWORD`.
- Cold mail goes out only from the outreach mailbox, with SPF/DKIM/DMARC set; **no cold sends before warm-up day 30** (spec §16). Send volume stays well under Gmail-class limits: no bulk tool or paid warm-up (spec §9.3).
- Sequence timing (spec §9.3, Web Kit §7): Email 1 day 0 · Email 2 at business day 5 · optional call day 7 · Email 3 at day 12 · 90-day check-in. Each email has variants. A physical address and an opt-out are always included, and any "stop" ends every channel.
- Nothing is ever linked on `workers.dev` (spec §5). Cold links use the host in `OUTREACH_LINK_BASE` (a subdomain of hellositeline.com).
- No Webfor names, content or pricing anywhere. The do-not-contact list is entered by Logan; seed nothing (spec §2, §9.1).
- The paid Claude API is never used by new code (spec §2 goal 5). New AI work goes through the Task 13 queue.
- Total monthly cap stays $150, with per-service sub-caps; warn at 80% (spec §9.13).
- Follow existing patterns: zod validation returning 400 with `fields`, `c.json({ error })`, DB helpers in `src/worker/db/*.ts`, pure view helpers in `src/client/*View.ts` tested in `test/*-view.test.ts`. Run from the worktree. Test: `npm test`. Types: `npm run typecheck`.

## Scope decisions (flag to Logan)

- **Email 1 still comes from today's drafter**, which calls the Claude API. Moving `drafter/draft.ts`, `audit/review.ts`, `cro/*` and `workflows.ts` onto the queue and removing `ANTHROPIC_API_KEY` (spec §9.13) is not in any of the five plans. This plan builds the queue (Task 13) and uses it only for new work. Recommend a short follow-up plan, "2.5: queue migration", before Plan 3.
- **Email 3 timing:** the spec says "day 12"; the Web Kit table says 12 business days. This plan uses business days for both Email 2 and Email 3, editable per campaign step.
- **No PDF attachment on cold mail.** The Gmail-draft path attached the audit PDF; attachments hurt cold deliverability. Email 1 links the audit report page instead; Plan 3 swaps in the video page.
- **Cut line (spec §12):** if Phase 1 runs long, drop Task 13 only. Deterministic stop detection (Task 3) still ends sequences on replies.

## Review Focus

1. **Send exactly once.** A double approve, a retry after a failed DB write, or a crash after SMTP accepted the message must never send a second copy. Tests in Task 4: `retry after sent is a no-op`, `stuck sending row refuses to resend`.
2. **Stop beats approval.** A reply, bounce or "stop" that arrives after an approval was created but before it was approved must prevent the send. Tests: Task 7 `stopped enrollment blocks send`, Task 8 `reply rejects pending step approvals`.
3. **Conflict matching.** Mixed-case emails, `www.` and subdomains of a listed domain, and existing clients (`won`) all block. A blocked lead never gets an approval, and the reason is shown. Tests in Task 5.
4. **Warm-up and daily cap.** Day 0–29 sends nothing to prospects, then 5/10/20 per day by age; a test send to Logan's own mailbox is exempt. Tests in Task 4.
5. **Hostile or odd inbound mail.** Our own footer ("Reply stop…") quoted inside a reply must not count as a stop. Bounces and out-of-office replies are not replies. Mail that matches no lead is ignored and not stored. A message longer than 200 KB is parsed without crashing. Tests in Tasks 3 and 8.

---

### Task 1: Branch, baseline, bindings

**Files:**
- Modify: `src/worker/env.ts`, `vitest.config.ts`, `package.json`

**Interfaces:**
- Produces on `Env`: `MAILBOX_OUTREACH_PASSWORD?: string; MAILBOX_MAIN_PASSWORD?: string; OUTREACH_LINK_BASE?: string`.

- [ ] **Step 1: Branch in the existing worktree.** Run: `cd ../site-search-agency-os && git status --short && git switch -c feat/agency-os-mail`. Expected: clean tree, new branch from `main`.
- [ ] **Step 2: Baseline is green.** Run: `npm test && npm run typecheck`. Expected: all pass (1428 tests at the time of writing). If anything fails, stop and report it.
- [ ] **Step 3: Confirm Plan 1 is live on the remote DB.** Logan runs `npx wrangler d1 migrations list site-search --remote`. Expected: `0024`–`0027` applied. If not, finish Plan 1's Ship task first.
- [ ] **Step 4: Add the three optional `Env` fields** (names above) and, in `vitest.config.ts` bindings, `MAILBOX_OUTREACH_PASSWORD: "pw-out"`, `MAILBOX_MAIN_PASSWORD: "pw-main"`, `OUTREACH_LINK_BASE: "https://go.hellositeline.test"`.
- [ ] **Step 5: Install** `npm i worker-mailer@1.3.1 postal-mime@4.2.1`, then run `npm run typecheck`. Expected: PASS.
- [ ] **Step 6: Commit** — `git add -A && git commit -m "chore: mail plan bindings and dependencies"`

---

### Task 2: Mailbox registry, SMTP sender, connection test (host spike)

**Files:**
- Create: `migrations/0028_mailboxes.sql`, `src/worker/mail/types.ts`, `src/worker/mail/deps.ts`, `src/worker/mail/smtp.ts`, `src/worker/db/mailboxes.ts`, `src/worker/routes/mailboxes.ts`
- Modify: `src/worker/index.ts` (mount `/api/mailboxes`)
- Test: `test/mailboxes.test.ts`

**Interfaces:**
- Produces (`mail/types.ts`):
  - `type MailboxKey = "outreach" | "main"`
  - `interface Mailbox { key: MailboxKey; enabled: 0 | 1; smtp_host: string; smtp_port: number; imap_host: string; imap_port: number; username: string; from_email: string; from_name: string; warmup_started_at: string | null; imap_uid_validity: number | null; imap_last_uid: number | null; last_sync_at: string | null; last_sync_error: string | null }`
  - `interface OutboundMessage { from: { email: string; name: string }; to: string; subject: string; text: string; html: string; messageId: string; inReplyTo?: string; references?: string[]; headers?: Record<string, string> }`
  - `type SmtpSend = (mb: Mailbox, password: string, msg: OutboundMessage) => Promise<void>`
- Produces (`mail/deps.ts`): `interface MailDeps { smtp: SmtpSend; imap: ImapFetch; now(): Date }`, `getMailDeps(): MailDeps` (real implementations by default), `setMailDeps(d: Partial<MailDeps> | null): void` (tests only; `null` restores defaults). `ImapFetch` is defined in Task 3; declare it there and import the type here.
- Produces (`db/mailboxes.ts`): `getMailbox(db, key): Promise<Mailbox>` (both rows exist from the migration), `saveMailbox(db, key, patch: Partial<Omit<Mailbox, "key">>): Promise<Mailbox>`, `mailboxPassword(env: Env, key: MailboxKey): string | null`.
- Routes (all authed):
  - `GET /api/mailboxes` returns both mailboxes plus `passwordSet: boolean`. The password itself is never returned or accepted.
  - `PUT /api/mailboxes/:key` (zod; ports 1–65535; `from_email` is an email)
  - `POST /api/mailboxes/:key/test` returns `{ smtp: { ok: boolean; error?: string }; imap: { ok: boolean; error?: string }; spf: boolean | null }`
  - `POST /api/mailboxes/:key/test-send` sends a message to the mailbox's own `from_email` and returns `{ ok }`
  - `POST /api/mailboxes/:key/start-warmup` sets `warmup_started_at` once; a second call returns 409.
- Migration: table `mailboxes` with the columns above, `key` as primary key with a CHECK for the two values, and two seeded rows (`enabled = 0`, empty strings, `smtp_port 465`, `imap_port 993`).
- SPF comes from the existing `lookupMailDns(domain, fetch)` in `src/worker/dns.ts`.

- [ ] **Step 1: Write the failing tests** in `test/mailboxes.test.ts` (call the routes with `SELF.fetch`; use `setMailDeps` with a fake `smtp` that records calls):
  - `GET never leaks the password`: the response JSON contains no `pw-out`, and `passwordSet` is `true`.
  - `PUT rejects a bad port` gives 400 with `fields`.
  - `test-send uses the smtp dep with the mailbox from address and own address`.
  - `test reports smtp failure text` (the fake throws `"535 auth failed"`): `smtp.ok === false` and `error` contains it.
  - `start-warmup twice gives 409`.
- [ ] **Step 2: Run** `npx vitest run test/mailboxes.test.ts`. Expected: FAIL (modules missing).
- [ ] **Step 3: Implement** the migration, `types.ts`, `deps.ts`, `db/mailboxes.ts`, `smtp.ts` (`sendSmtp: SmtpSend` using `worker-mailer`: implicit TLS on 465, STARTTLS otherwise; set `Message-ID`, `In-Reply-To`, `References`, `List-Unsubscribe: <mailto:{from_email}?subject=stop>` and any `headers`), and the routes. Read the pinned library's README for its connect options.
- [ ] **Step 4: Run all** `npm test && npm run typecheck`. Expected: PASS.
- [ ] **Step 5: Host spike (needs Logan; do not skip).** With the real mailbox on the outreach domain, Logan puts the password in `.dev.vars` as `MAILBOX_OUTREACH_PASSWORD=...` and fills the mailbox row through `PUT /api/mailboxes/outreach`. Run `npm run dev`, then `POST /api/mailboxes/outreach/test` and `…/test-send`. Expected: SMTP `ok`, a test message arrives. Record in `docs/superpowers/notes/2026-11-mail-host.md`: host and ports that worked, whether the host allows a mailbox on the second domain, its send-rate limit, and the SPF result. **Gate:** if the host refuses SMTP/IMAP from a Worker or from outside its network, stop and tell Logan; the spec's fallback (a cheap custom-domain IMAP/SMTP provider, spec §3) needs his choice before Task 3.
- [ ] **Step 6: Commit** — `git add -A && git commit -m "feat(mail): mailbox registry, SMTP sender and connection test"`

---

### Task 3: IMAP reader and inbound parsing

**Files:**
- Create: `src/worker/mail/imap.ts`, `src/worker/mail/inbound.ts`, `test/fixtures/mail/{reply,reply-quoted-footer,stop,bounce-dsn,ooo,huge}.eml`
- Test: `test/inbound.test.ts`, `test/imap.test.ts`

**Interfaces:**
- Produces (`imap.ts`):
  - `type ImapFetch = (mb: Mailbox, password: string, sinceUid: number | null) => Promise<{ uidValidity: number; uidNext: number; messages: { uid: number; raw: Uint8Array }[] }>`. With `sinceUid === null` it returns no messages and only the baseline (`uidValidity`, `uidNext`).
  - `fetchImap: ImapFetch`: the real implementation. Try `imapflow` first inside `wrangler dev`. If `node:net` or the socket connect fails in workerd, write a minimal client on `cloudflare:sockets` with exactly `LOGIN`, `SELECT INBOX`, `UID FETCH n:* (UID BODY.PEEK[])`, `LOGOUT`, plus a response parser that handles `{N}` literals. Export the parser as `parseImapFetch(bytes: Uint8Array): { uid: number; raw: Uint8Array }[]` and test it with a canned server transcript.
- Produces (`inbound.ts`):
  - `interface InboundMessage { messageId: string | null; inReplyTo: string | null; references: string[]; from: string; subject: string; text: string; date: string | null; autoSubmitted: boolean; dsn: { status: string; recipient: string | null } | null }`
  - `parseInbound(raw: Uint8Array): Promise<InboundMessage>` (via `postal-mime`; `text` truncated to 20,000 chars; never throws on malformed input, returns empty fields instead)
  - `type InboundKind = "bounce_hard" | "bounce_soft" | "auto_reply" | "stop" | "reply"`
  - `classifyInbound(m: InboundMessage): InboundKind`, deterministic:
    - DSN status `5.x.x` is `bounce_hard`; `4.x.x` is `bounce_soft`.
    - `Auto-Submitted` other than `no`, or a subject starting `Automatic reply`/`Out of office`, is `auto_reply`.
    - After `stripQuoted(m.text)`, `stop` when the first non-empty line matches `/^(please\s+)?(stop|unsubscribe|no thanks|no thank you|remove me\b.*|(do not|don't|dont)\s+(contact|email)\b.*)[.! ]*$/i`; otherwise `reply`.
  - `stripQuoted(text: string): string` removes `> ` lines and everything from an `On … wrote:` line or a `-----Original Message-----` line onward.

- [ ] **Step 1: Write the failing tests** in `test/inbound.test.ts` against the fixtures:
  - `plain reply is a reply`
  - `"Stop" alone is stop`
  - `"no thanks" is stop`
  - `"Can you stop by tomorrow?" is a reply`
  - `quoted footer saying Reply stop is not a stop`: `reply-quoted-footer.eml` is a reply whose quoted original ends with our footer.
  - `dsn 5.1.1 is bounce_hard, 4.2.2 is bounce_soft` (`bounce-dsn.eml`; add a soft variant inline)
  - `out of office is auto_reply`
  - `huge message parses` (the 200 KB `huge.eml`): `text.length <= 20000`, no throw.
  - `garbage bytes parse to empty fields`.
  - In `test/imap.test.ts`: `parseImapFetch handles literals and multiple messages` from a canned transcript.
- [ ] **Step 2: Run** `npx vitest run test/inbound.test.ts test/imap.test.ts`. Expected: FAIL.
- [ ] **Step 3: Implement** `inbound.ts`, then `imap.ts` as described.
- [ ] **Step 4: Real-host check (needs Logan).** In `npm run dev`, call the real `fetchImap` against the outreach mailbox with `sinceUid: null`. Expected: returns `uidValidity` and `uidNext`. Send the mailbox a message from another account and call again with `sinceUid = uidNext - 1`. Expected: the message comes back and `parseInbound` reads its subject.
- [ ] **Step 5: Run all** `npm test && npm run typecheck`. Expected: PASS.
- [ ] **Step 6: Commit** — `git add -A && git commit -m "feat(mail): IMAP reader and inbound classification"`

---

### Task 4: Message log and the `email.send` approval kind

**Files:**
- Create: `migrations/0029_messages.sql`, `src/worker/db/messages.ts`, `src/worker/mail/limits.ts`, `src/worker/mail/send.ts`, `src/worker/mail/conflictStub.ts`, `src/worker/approvals/emailSend.ts`
- Modify: `src/worker/index.ts` (import `./approvals/emailSend` so it registers)
- Test: `test/email-send.test.ts`

**Interfaces:**
- Consumes: `composeEmail(settings, { subject, body, include_footer })` from `email/render.ts`; `getMailbox`, `mailboxPassword`; `getMailDeps`; `registerHandler`.
- Produces:
  - Table `messages (id TEXT PK, direction 'out'|'in', mailbox_key, business_id TEXT NULL, enrollment_id TEXT NULL, step_index INTEGER NULL, approval_id TEXT NULL UNIQUE, message_id TEXT NULL, in_reply_to TEXT NULL, counterpart TEXT NOT NULL, subject, text, status 'sending'|'sent'|'failed'|'received', kind TEXT NULL, imap_uid INTEGER NULL, created_at, sent_at TEXT NULL)`. Unique index on `(mailbox_key, imap_uid)` where `imap_uid` is not null, and an index on `message_id`.
  - `dailyLimit(mb: Pick<Mailbox, "warmup_started_at">, now: Date): number`: no start → 0; days 0–29 → 0; 30–44 → 5; 45–59 → 10; 60+ → 20.
  - `sentInLast24h(db, key: MailboxKey, now: Date): Promise<number>` counts `direction = 'out'`, `status = 'sent'`, `business_id IS NOT NULL`. Test sends are excluded because they have no business.
  - `EmailSendPayload`: `{ mailbox: MailboxKey; businessId: string; to: string (email); subject: string (1–200); body: string (≥1); includeFooter: boolean; enrollmentId?: string; stepIndex?: number (int ≥ 0); inReplyTo?: string }`
  - `buildEmailSendApproval(p: EmailSendPayload & { title: string; drafted_by: Drafter }, settings: Settings)`: returns the arguments for `createApproval` with kind `"email.send"`, `record_type "enrollment"` when `enrollmentId` is set, and `preview` = `To: …\nSubject: …\n\n` plus the first 400 chars of the composed text.
  - Handler `email.send`, registered. Its `execute` runs these checks **in order** and throws `Error` with a plain message on any failure, so the approval returns to pending with that text:
    1. mailbox enabled and `mailboxPassword` present;
    2. `checkConflict` (wired in Task 5; until then a no-op stub `src/worker/mail/conflictStub.ts`, deleted in Task 5; Task 7 adds the enrollment-status check right after this one);
    3. when `mailbox === "outreach"`: the footer is always on (`includeFooter` is ignored) and `settings.physical_address` must be non-empty, otherwise the message says `add your mailing address in Settings before sending cold email`;
    4. composed text and html contain no `workers.dev` host, and when `mailbox === "outreach"` any link must start with `OUTREACH_LINK_BASE`;
    5. `mailbox === "outreach"`: `sentInLast24h < dailyLimit`, otherwise the message says `warm-up: cold sends unlock on <date>` or `daily limit reached (<n>)`;
    6. idempotent send (see Step 3).
  - `sendEmail(env, p: EmailSendPayload, opts: { approvalId: string | null; skipLimits?: boolean }): Promise<void>` is the shared path; `test-send` from Task 2 is switched to call it with `businessId` omitted and `skipLimits: true` (make `businessId` optional only on this internal type, never in the approval payload).
  - On success for `stepIndex === 0` or undefined: set the lead's `lead_status = 'contacted'` and `contacted_at` through `updateLead`, and `logActivity(db, businessId, "note", "Email sent: <subject>")`.

- [ ] **Step 1: Write the failing tests** in `test/email-send.test.ts` (fake `smtp` via `setMailDeps`, which counts calls; seed a business with `upsertBusiness`; enable the outreach mailbox with `warmup_started_at` set 40 days before `now`):
  - `approve sends once and logs the message`: one fake call, one `messages` row `status 'sent'`, the lead becomes `contacted`.
  - `retry after sent is a no-op`: approve, force the approval back to `pending` in SQL, approve again: still one fake call.
  - `stuck sending row refuses to resend`: insert a `messages` row with this `approval_id` and `status 'sending'`, then approve: `502`, zero fake calls, error mentions "may already have been sent".
  - `smtp failure leaves approval pending and allows retry`: the first call throws, the row ends `failed`, the approval is pending with the error text; the second approve sends.
  - `dailyLimit` table: day 0, 29 → 0; day 30 → 5; day 45 → 10; day 60 → 20; no `warmup_started_at` → 0.
  - `warm-up blocks outreach before day 30` and `daily limit reached after N sends`.
  - `test send is exempt from warm-up`.
  - `workers.dev link blocks send` and `link outside OUTREACH_LINK_BASE blocks send`.
  - `outreach send always carries address and opt-out` (approve with `includeFooter: false`; the fake receives both lines) and `missing mailing address blocks cold send`.
  - `preview shows recipient and subject`.
  - `edited payload is recomposed`: approve with edited `body`; the fake receives the edited text.
- [ ] **Step 2: Run** `npx vitest run test/email-send.test.ts`. Expected: FAIL.
- [ ] **Step 3: Implement.** Idempotent send: `INSERT INTO messages … status 'sending'` keyed on `approval_id`. If the insert conflicts, read the row: `sent` → return; `failed` → set back to `sending` and continue; `sending` → throw. Then call the SMTP dep. On success set `sent`, `sent_at` and `message_id`; on error set `failed` and rethrow. `message_id` is generated before sending as `<uuid@from-domain>`.
- [ ] **Step 4: Run all** `npm test && npm run typecheck`. Expected: PASS.
- [ ] **Step 5: Commit** — `git add -A && git commit -m "feat(mail): email.send approval kind with once-only send, warm-up limits and link guard"`

---

### Task 5: Conflict gate

**Files:**
- Create: `migrations/0030_do_not_contact.sql`, `src/worker/db/doNotContact.ts`, `src/worker/conflict.ts`, `src/worker/routes/doNotContact.ts`, `src/client/dncView.ts`
- Modify: `src/worker/approvals/emailSend.ts` (replace the stub with `checkConflict`), `src/worker/index.ts` (mount `/api/do-not-contact`), `src/client/pages/settings/Suppressions.tsx` (second section)
- Delete: `src/worker/mail/conflictStub.ts`
- Test: `test/conflict.test.ts`, `test/dnc-view.test.ts`

**Interfaces:**
- Produces:
  - Table `do_not_contact (id TEXT PK, kind 'email'|'domain'|'name', value TEXT NOT NULL, reason 'client'|'opt_out'|'competitor'|'active_deal'|'bounced'|'webfor'|'other', note TEXT, created_at TEXT NOT NULL, UNIQUE(kind, value))`. Values are normalized on write: emails and domains lower-cased, domains without `www.`, names lower-cased with punctuation and `llc|inc|co|corp` removed.
  - `addDoNotContact(db, i: { kind; value: string; reason; note?: string }): Promise<DoNotContact>`, `listDoNotContact(db)`, `removeDoNotContact(db, id): Promise<boolean>`
  - `checkConflict(db, c: { email: string; businessId?: string }): Promise<{ blocked: false } | { blocked: true; reason: string; source: "do_not_contact" | "suppression" | "client" }>`. It blocks when any of these hold: the email matches a listed email; the email's domain or the lead's domain equals or is a subdomain of a listed domain; the lead's normalized name matches a listed name; the existing `leadSuppression(db, business)` matches; or the lead's `lead_status === 'won'` (an existing client). `reason` is human-readable, for example `"acme.com is on your do-not-contact list (webfor)"`.
  - `GET/POST /api/do-not-contact`, `DELETE /api/do-not-contact/:id` (zod; the `reason` enum above).
  - `dncView.ts`: `dncReasonLabel(r): string` and `dncValueHint(kind): string` (exact copy: email → `"name@company.com"`, domain → `"company.com"`, name → `"Company name"`).
- The UI section on the Suppressions page lists entries with a delete button and an add form (kind, value, reason, note). No Webfor entries are seeded; the `webfor` reason exists so Logan can enter them himself.

- [ ] **Step 1: Write the failing tests** in `test/conflict.test.ts`:
  - `listed email blocks regardless of case`
  - `listed domain blocks subdomain and www` (list `acme.com`; an email at `mail.acme.com` blocks; a lead with `www.acme.com` blocks)
  - `similar domain does not block` (`acme.com` listed, `notacme.com` free)
  - `listed name blocks normalized name` (`"Acme Plumbing, LLC"` vs `"acme plumbing"`)
  - `suppression list blocks`, `won lead blocks with client source`
  - `email.send execute refuses a conflict and the approval stays pending with the reason`
  - routes: `add and delete round trip`, `duplicate gives 409`, `401 without a cookie`
  - in `test/dnc-view.test.ts`: the labels and hints above.
- [ ] **Step 2: Run** `npx vitest run test/conflict.test.ts test/dnc-view.test.ts`. Expected: FAIL.
- [ ] **Step 3: Implement**, then delete the stub and point `emailSend.ts` at `checkConflict`.
- [ ] **Step 4: Run all + build** `npm test && npm run typecheck && npm run build`. Expected: PASS.
- [ ] **Step 5: Commit** — `git add -A && git commit -m "feat(outreach): conflict gate over do-not-contact, suppressions and clients"`

---

### Task 6: Campaigns and sequence step templates

**Files:**
- Create: `migrations/0031_campaigns.sql`, `src/worker/db/campaigns.ts`, `src/worker/sequence/template.ts`, `src/worker/routes/campaigns.ts`
- Modify: `src/worker/search-start.ts` (`startSearchRun` accepts an optional `campaignId` and stores it on the search), `src/worker/index.ts` (mount `/api/campaigns`)
- Test: `test/campaigns.test.ts`

**Interfaces:**
- Produces:
  - Tables: `campaigns (id, name, niche, region, towns TEXT /* JSON string[] */, status 'testing'|'active'|'archived', est_job_value_usd REAL NULL, created_at)`; `sequence_steps (id, campaign_id, idx INTEGER, kind 'email'|'call'|'checkin', offset_days INTEGER, offset_kind 'business'|'calendar', subject TEXT, variants TEXT /* JSON string[] of bodies */, UNIQUE(campaign_id, idx))`; `ALTER TABLE searches ADD COLUMN campaign_id TEXT`.
  - `interface Campaign { id; name; niche; region; towns: string[]; status; est_job_value_usd: number | null }`, `interface SequenceStep { id; campaign_id; idx; kind; offset_days; offset_kind; subject: string; variants: string[] }`
  - `createCampaign(db, i: { name; niche; region; towns: string[] }): Promise<Campaign>`: also seeds the default steps below.
  - `listCampaigns`, `getCampaign`, `updateCampaign(db, id, patch)`, `listSteps(db, campaignId): Promise<SequenceStep[]>`, `saveStep(db, campaignId, step)`.
  - `renderTemplate(tpl: string, vars: Record<string, string | undefined>): string`: replaces `{Name}`-style fields; throws `MissingFieldError` (with `fields: string[]`) when a field has no value, so a step is never sent with an unfilled field.
  - `pickVariant(variants: string[], seed: string): string` is a stable hash of `seed` modulo the count.
  - Routes: `GET/POST /api/campaigns`, `GET/PATCH /api/campaigns/:id`, `PUT /api/campaigns/:id/steps/:idx`, `POST /api/campaigns/:id/run-searches` (one `startSearchRun` per town, each tagged with `campaignId`; returns `{ started: n; blocked: { town; reason }[] }`).
- **Default steps** (seeded for each new campaign; source copy is Logan's own Web Kit §7, `agency/research/doc-extracts/Logan Irish Web Kit - Agency Plan and Sales Playbook.docx.txt` lines 258–277 and 352–358; merge fields `{Business}`, `{Name}`, `{link}`, `{problem_one}`):
  - idx 0 `email`, offset 0 business: placeholder only; Email 1's body comes from the lead's draft (Task 7).
  - idx 1 `email`, offset 5 business: subject `Re: Quick video about {Business}'s website`, body from "Email 2".
  - idx 2 `call`, offset 7 calendar: optional phone call.
  - idx 3 `email`, offset 12 business: "Email 3".
  - idx 4 `checkin`, offset 90 calendar: "Past contact check-in".
  - Email 2 and 3 each get a second variant (same meaning, different wording, in Logan's voice via the `logan-voice` skill). They contain no prices, so they never go stale against the package ladder. Replace `{video link}` in the Web Kit copy with `{link}`.

- [ ] **Step 1: Write the failing tests** in `test/campaigns.test.ts`:
  - `new campaign gets five default steps in order`
  - `renderTemplate fills fields` and `missing field throws with its name` (`{problem_one}` unset)
  - `pickVariant is stable per seed and varies across seeds` (over 50 seeds both variants appear)
  - `run-searches starts one search per town tagged with the campaign`: stub the workflow starter and check `searches.campaign_id` for each.
  - `run-searches reports a spend-blocked town` and `routes require auth`.
- [ ] **Step 2: Run** `npx vitest run test/campaigns.test.ts`. Expected: FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run all** `npm test && npm run typecheck`. Expected: PASS.
- [ ] **Step 5: Commit** — `git add -A && git commit -m "feat(campaigns): campaigns, default sequence steps and tagged searches"`

---

### Task 7: Sequence engine

**Files:**
- Create: `migrations/0032_enrollments.sql`, `src/worker/sequence/{types,dates,engine,stop}.ts`, `src/worker/schedule.ts`
- Modify: `src/worker/approvals/emailSend.ts` (as check 2 of `execute`, right after the conflict check, throw unless the enrollment's status is `active` or `nurture`; call `advanceAfterSend` on success), `src/worker/index.ts` (route `scheduled` through `runScheduled`), `wrangler.jsonc` (`"crons": ["17 13 * * *", "*/15 * * * *"]`: **keep the daily cron first**, because `test/radar-info.test.ts` reads the first entry)
- Test: `test/sequence.test.ts`, `test/schedule.test.ts`

**Interfaces:**
- Consumes: `createApproval`, `buildEmailSendApproval` (Task 4), `checkConflict` (Task 5), `listSteps`, `renderTemplate`, `pickVariant` (Task 6), `latestDraft`, `contactsFor`, `pickRecipient`, `getSettings`.
- Produces:
  - Table `enrollments (id TEXT PK, business_id, campaign_id, mailbox_key, to_email, status 'active'|'nurture'|'replied'|'stopped'|'bounced'|'completed', next_step_index INTEGER, next_due_at TEXT NULL, started_at, last_sent_at TEXT NULL, last_error TEXT NULL, stopped_reason TEXT NULL)` plus `CREATE UNIQUE INDEX uq_enroll_business ON enrollments(business_id) WHERE status IN ('active','nurture')`.
  - `addBusinessDays(from: Date, n: number): Date` skips Saturdays and Sundays; no holiday table.
  - `startSequence(env, o: { businessId: string; campaignId: string; mailbox?: MailboxKey }): Promise<{ ok: true; enrollmentId: string; approvalId: string } | { ok: false; error: string; status: 400 | 404 | 409 | 422 }>`: errors for a missing draft (400), a conflict (422, with the gate's reason), and an already-active enrollment (409). The recipient is the draft's `to_contact_id` email, else `pickRecipient`. It creates the enrollment (`next_step_index 1`, due per step 1) and the step-0 approval from the lead's current draft, `drafted_by "logan"`. If creating the approval fails, the enrollment row is deleted again.
  - `scanDueSteps(env, now: Date): Promise<{ approvalsCreated: number; calls: number; skipped: number }>`: for each active enrollment with `next_due_at <= now` and no pending approval (`record_type 'enrollment'`, `record_id` = its id): a `call` step sets the lead's `follow_up_at` and logs an activity note, then advances without an approval. An `email` step renders subject and the variant chosen by `pickVariant(variants, businessId + idx)`, with vars `Business`, `Name` (the contact's first name, else `"{Business} team"` per Web Kit §7), `link` (the lead's audit report URL on `OUTREACH_LINK_BASE`), `problem_one` (title of the latest audit's top finding), then creates the approval with `drafted_by "job"`, `inReplyTo` set to the enrollment's last outbound `message_id`. A `MissingFieldError` or conflict sets `last_error` and counts as skipped.
  - `advanceAfterSend(db, enrollmentId, stepIndex, sentAt: Date)`: sets `last_sent_at`, then `next_step_index + 1` and `next_due_at = max(start + offset, sentAt + 3 business days)`. After the last email step it sets `completed`. Called by the `email.send` handler on success.
  - `stopOutreach(db, o: { businessId: string; reason: "replied" | "opt_out" | "bounced" | "manual"; email?: string }): Promise<{ rejectedApprovals: number }>`:
    - `replied` sets the enrollment `replied` and the lead `replied`;
    - `opt_out` sets it `stopped`, calls `suppressLead(reason "opt_out")`, adds the email to `do_not_contact (opt_out)`, and sets the lead `lost`;
    - `bounced` sets it `bounced` and adds the email to `do_not_contact (bounced)`;
    - `manual` sets it `stopped`.
    - Every reason rejects pending approvals tied to the business's enrollments with note `"sequence stopped: <reason>"` and logs an activity row.
  - `runScheduled(env, cron: string, now: Date): Promise<void>`: `"*/15 * * * *"` runs `syncAllMailboxes` (Task 8; until then a no-op export), anything else runs `runDueRadars` then `scanDueSteps`. Each part is wrapped so one failure is logged and never stops the other.

- [ ] **Step 1: Write the failing tests** in `test/sequence.test.ts`:
  - `addBusinessDays skips weekends` (Friday + 1 = Monday; Wednesday + 5 = next Wednesday)
  - `start creates enrollment and step 0 approval for the draft recipient`
  - `start without a draft is 400`, `start on a conflict is 422 and creates nothing`, `second start is 409`
  - `scan creates the step 1 approval only when due`, and `scan twice does not duplicate` (a pending approval exists)
  - `call step sets follow_up_at and advances without an approval`
  - `unfilled merge field skips the step and records last_error`
  - `late approval keeps a 3 business day gap before the next step`
  - `completed after the last email step`
  - `stopped enrollment blocks send`: stop it, then approve a leftover step approval (created directly), expect 502 and no SMTP call.
  - `stopOutreach opt_out suppresses lead, adds do_not_contact and rejects pending approvals`
  - in `test/schedule.test.ts`: `runScheduled with the 15-minute cron does not run radars`, and `a failing scan does not stop the radar run`.
- [ ] **Step 2: Run** `npx vitest run test/sequence.test.ts test/schedule.test.ts test/radar-info.test.ts`. Expected: FAIL; `radar-info` must still pass after the cron change.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run all** `npm test && npm run typecheck`. Expected: PASS.
- [ ] **Step 5: Commit** — `git add -A && git commit -m "feat(sequence): enrollments, due-step scan, stop handling and scheduled routing"`

---

### Task 8: Reply sync

**Files:**
- Create: `src/worker/mail/sync.ts`
- Modify: `src/worker/schedule.ts` (the 15-minute cron calls `syncAllMailboxes`), `src/worker/routes/mailboxes.ts` (`POST /api/mailboxes/:key/sync`), `src/worker/types.ts` (add `"email_sent" | "email_reply" | "email_bounce"` to `ActivityKind`; add their labels in `src/client/activityView.ts` so the lead's Activity tab renders them, with a new `test/activity-view.test.ts` asserting each label is non-empty)
- Test: `test/mail-sync.test.ts`

**Interfaces:**
- Consumes: `fetchImap` through `getMailDeps().imap`, `parseInbound`, `classifyInbound`, `stripQuoted` (Task 3), `stopOutreach` (Task 7), `getMailbox`, `saveMailbox`.
- Produces:
  - `syncMailbox(env, key: MailboxKey): Promise<{ fetched: number; matched: number; replies: number; stopped: number; bounced: number }>`
  - `syncAllMailboxes(env): Promise<void>`: only mailboxes that are `enabled` with a password set; errors are written to `last_sync_error` and never thrown.
  - Behavior:
    - First run (no `imap_last_uid`) saves the baseline `uidNext - 1` and imports nothing (no history).
    - A changed `uidValidity` resets the baseline the same way.
    - **Matching:** by `In-Reply-To`/`References` against `messages.message_id` (direction `out`); fallback by the sender address equal to an enrollment's `to_email`. Unmatched mail is skipped, not stored.
    - Matched mail is stored once (the unique `(mailbox_key, imap_uid)` index) with `kind` from `classifyInbound`.
    - `reply` → `stopOutreach(reason "replied")` and an `email_reply` activity.
    - `stop` → `stopOutreach(reason "opt_out")`.
    - `bounce_hard` → `stopOutreach(reason "bounced")` and an `email_bounce` activity.
    - `bounce_soft` → activity only.
    - `auto_reply` → store, and push the enrollment's `next_due_at` out 7 days. The lead status does not change.
    - Always saves `imap_last_uid`, `last_sync_at`, and clears `last_sync_error`.

- [ ] **Step 1: Write the failing tests** in `test/mail-sync.test.ts` (fake `imap` dep that returns fixture messages; seed a business, an active enrollment, and an outbound `messages` row with a known `message_id`):
  - `first sync saves the baseline and imports nothing`
  - `reply matched by In-Reply-To stops the sequence and marks the lead replied`
  - `reply rejects pending step approvals` (a pending step approval exists beforehand)
  - `stop reply suppresses the lead and adds do_not_contact`
  - `quoted footer reply is a reply, not a stop` (`reply-quoted-footer.eml`)
  - `hard bounce marks bounced and lists the address`; `soft bounce changes nothing`
  - `out of office delays the next step by 7 days and keeps the lead status`
  - `unmatched mail is ignored and not stored`
  - `the same uid is not processed twice`
  - `uidValidity change resets the baseline`
  - `imap error is recorded in last_sync_error and does not throw`
- [ ] **Step 2: Run** `npx vitest run test/mail-sync.test.ts`. Expected: FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run all** `npm test && npm run typecheck`. Expected: PASS.
- [ ] **Step 5: Commit** — `git add -A && git commit -m "feat(mail): IMAP reply sync that stops sequences"`

---

### Task 9: Mailboxes and campaigns screens

**Files:**
- Create: `src/client/mailboxView.ts`, `src/client/campaignView.ts`, `src/client/pages/settings/Mailboxes.tsx`, `src/client/pages/Campaigns.tsx`
- Modify: `src/client/App.tsx` (routes `/settings/mailboxes`, `/campaigns`), the settings home list and `src/client/components/Shell.tsx` (an Outreach sidebar item "Campaigns"), `src/client/types.ts`
- Test: `test/mailbox-view.test.ts`, `test/campaign-view.test.ts`

**Interfaces:**
- Produces (pure):
  - `warmupLine(mb: { warmup_started_at: string | null }, now: Date): string`. Exact copy:
    - not started → `"Warm-up not started"`
    - day `d` of 0–29 → `` `Warm-up day ${d + 1} of 30. Cold sends unlock on ${Mon D}` `` (for example `Dec 18`)
    - after → `` `Warm-up complete. Up to ${limit} a day` ``
  - `syncLine(mb: { last_sync_at: string | null; last_sync_error: string | null }, now: Date): string`. Exact copy: error → `` `Last check failed: ${error}` ``; never → `"Not checked yet"`; else `` `Checked ${n} min ago` `` (whole minutes, `"just now"` under 1).
  - `stepLabel(s: { kind; offset_days; offset_kind }): string`, for example `"Email · business day 5"`, `"Call · day 7"`, `"Check-in · day 90"`.
- UI behavior:
  - **Mailboxes page:**
    - a form per mailbox (hosts, ports, username, from name and address);
    - a "Password secret: set / missing" chip, with the one-line instruction `wrangler secret put MAILBOX_OUTREACH_PASSWORD`;
    - buttons Test connection, Send test, Check for replies now, Start warm-up clock;
    - results shown inline in an `aria-live="polite"` region.
  - **Campaigns page:**
    - list and create (name, niche, region, towns);
    - an editor for each step's offset, subject and variants;
    - "Run searches" with the per-town result;
    - job value field.

- [ ] **Step 1: Write the failing tests** for `warmupLine` (not started; day 1 gives `Warm-up day 1 of 30. Cold sends unlock on <date>`; day 30 gives `Warm-up complete. Up to 5 a day`; day 60 gives `… 20 a day`), `syncLine` (error, never, 3 min, just now) and `stepLabel` (three kinds).
- [ ] **Step 2: Run** `npx vitest run test/mailbox-view.test.ts test/campaign-view.test.ts`. Expected: FAIL.
- [ ] **Step 3: Implement** the helpers, then the pages and routes.
- [ ] **Step 4: Run all + build** `npm test && npm run typecheck && npm run build`. Expected: PASS.
- [ ] **Step 5: Check in the browser** (`npm run dev`): save a mailbox, run Test connection against the real host, create a campaign, edit a step, confirm both pages are keyboard reachable.
- [ ] **Step 6: Commit** — `git add -A && git commit -m "feat(client): mailboxes and campaigns screens"`

---

### Task 10: Start a sequence from a lead; retire Gmail drafts

**Files:**
- Create: `src/worker/routes/sequence.ts`, `src/client/sequenceView.ts`, `src/client/components/SequencePanel.tsx`
- Modify: `src/worker/routes/leads.ts` (delete `POST /:id/gmail-draft` and its imports), `src/worker/google/api.ts` (delete `createGmailDraft`, `buildMime` and their helpers if nothing else uses them), `src/worker/google/oauth.ts` (drop the Gmail scope; Drive and Calendar scopes stay), `src/client/components/EmailComposer.tsx`, `src/client/pages/LeadDetail.tsx`, `src/client/pages/Outreach.tsx` (replace the "Gmail draft" button with "Start sequence…"), `src/worker/index.ts`
- Test: `test/sequence-routes.test.ts`, `test/sequence-view.test.ts`; update `test/google.test.ts` and `test/outreach.test.ts` for the removed route

**Interfaces:**
- Produces:
  - `POST /api/leads/:id/sequence/start` with body `{ campaignId: string }` returns `{ enrollmentId, approvalId }` from `startSequence`, mapping its error statuses; `GET /api/leads/:id/sequence` returns `{ enrollment | null, steps: { step: SequenceStep; state: "sent" | "pending" | "due" | "upcoming" | "skipped"; at: string | null }[], messages: MessageRow[] }`; `POST /api/leads/:id/sequence/stop` calls `stopOutreach(reason "manual")`.
  - `sequenceView.ts`: `stepStateLabel(state, at: string | null, now: Date): string`. Exact copy: `sent` → `` `Sent ${Mon D}` ``, `pending` → `"Waiting for your OK"`, `due` → `"Due now"`, `upcoming` → `` `Due ${Mon D}` ``, `skipped` → `"Skipped"`.
- UI behavior:
  - The lead page "Start sequence…" opens a campaign picker, then shows "Waiting for your OK on Home".
  - `SequencePanel` shows the enrollment status, each step with its state label, and the message list (direction, subject, time), plus a Stop button.
  - The suppressed-lead guard that the old Gmail route had (`suppressedResponse`) is now covered by `checkConflict` inside `startSequence`.
  - After this task `git grep -n "createGmailDraft\|gmail-draft\|gmail.compose"` returns nothing under `src` and `test`.

- [ ] **Step 1: Write the failing tests:**
  - `start returns approvalId and the approval is pending` (via the route)
  - `start with an unknown campaign is 404`, `start on a suppressed lead is 422 with the reason`
  - `GET sequence lists steps with states` (one sent, one pending, others upcoming)
  - `stop route stops the enrollment`
  - `gmail-draft route is gone` (404)
  - in `test/sequence-view.test.ts`: the five labels.
- [ ] **Step 2: Run** `npx vitest run test/sequence-routes.test.ts test/sequence-view.test.ts`. Expected: FAIL.
- [ ] **Step 3: Implement** the routes and the panel, then remove the Gmail-draft code and fix the tests that used it.
- [ ] **Step 4: Prove the removal** `git grep -n "createGmailDraft\|gmail-draft\|gmail.compose" -- src test`. Expected: no output.
- [ ] **Step 5: Run all + build** `npm test && npm run typecheck && npm run build`. Expected: PASS.
- [ ] **Step 6: Browser check:** on a lead with a draft, start a sequence, then confirm the approval appears on Home with the recipient and subject in its preview, and that Edit shows `subject` and `body`.
- [ ] **Step 7: Commit** — `git add -A && git commit -m "feat(outreach): start sequences from a lead; retire Gmail drafts"`

---

### Task 11: Niche test

**Files:**
- Create: `src/worker/niche.ts`, `src/worker/routes/niche.ts`, `src/client/nicheView.ts`, `src/client/pages/NicheTest.tsx`
- Modify: `src/worker/index.ts` (mount `/api/niche`), `src/client/App.tsx` (route `/niche-test`), the Find sidebar (link "Niche test")
- Test: `test/niche.test.ts`, `test/niche-view.test.ts`

**Interfaces:**
- Produces:
  - `interface NicheRow { campaignId: string; name: string; niche: string; audited: number; avgScore: number | null; avgReviews: number | null; jobValueUsd: number | null; opportunity: number | null }`
  - `nicheStats(db): Promise<NicheRow[]>`: for every campaign not archived, over businesses reached through `search_results` → `searches.campaign_id`. `audited` counts businesses with an audit; `avgScore` is the mean of each business's latest audit `score` (0–100, higher is a better site); `avgReviews` is the mean `review_count` of those businesses (the competition signal).
  - `opportunity(avgScore: number, avgReviews: number, jobValueUsd: number): number` is `(100 - avgScore) * jobValueUsd / (1 + avgReviews / 100)`, rounded to a whole number. `[call]` The constants live at the top of `niche.ts` so Logan can retune them.
  - `nicheVerdict(rows: NicheRow[]): { ready: boolean; audited: number; needed: number; leaderId: string | null }`. `ready` is true once total `audited ≥ 50` (`MIN_TOTAL_AUDITS`); `leaderId` is the highest `opportunity` among rows with a job value, else `null`.
  - `GET /api/niche` returns `{ rows, verdict }`. `PATCH /api/campaigns/:id` (Task 6) already stores `est_job_value_usd`.
  - `nicheView.ts`: `verdictLine(v, rows): string`. Exact copy: not ready → `` `${audited} of ${needed} audits. Keep searching before you pick a trade.` ``; ready with a leader → `` `${name} leads on opportunity. Commit to it, or keep testing.` ``; ready with no job values entered → `"Enter a job value for each trade to compare them."`
- The page lists the trades side by side (audited, average site score, average reviews, job value input, opportunity) and shows the verdict line. It never picks a trade for Logan: it only names the leader.

- [ ] **Step 1: Write the failing tests** (`test/niche.test.ts`: seed two campaigns with tagged searches, businesses and audits):
  - `stats use each business's latest audit only`
  - `row without a job value has null opportunity`
  - `opportunity formula`: `opportunity(40, 100, 1000)` is `30000`.
  - `verdict not ready below 50 audits` and `ready names the leader above 50`
  - `archived campaigns are excluded`
  - in `test/niche-view.test.ts`: the three `verdictLine` strings.
- [ ] **Step 2: Run** `npx vitest run test/niche.test.ts test/niche-view.test.ts`. Expected: FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run all + build** `npm test && npm run typecheck && npm run build`. Expected: PASS.
- [ ] **Step 5: Commit** — `git add -A && git commit -m "feat(niche): compare trades by site score, competition and job value"`

---

### Task 12: Per-service spend sub-caps

**Files:**
- Create: `migrations/0033_spend_caps.sql`, `src/worker/db/spendCaps.ts`
- Modify: `src/worker/spend.ts`, `src/worker/radar-run.ts`, `src/worker/routes/spend.ts`, `src/client/pages/settings/Usage.tsx`, `src/client/spendView.ts` if present (otherwise add the helper beside `src/client/spend.ts`)
- Test: `test/spend-caps.test.ts`

**Interfaces:**
- Produces:
  - Table `spend_caps (service TEXT PK, monthly_usd REAL NOT NULL)`, seeded `brightdata 15` and `places 15` (`[call]`: the spec's lead-data estimate is $5–20 total; Logan edits them).
  - `serviceSpend(db, now: Date): Promise<{ service: Service; spentUsd: number; capUsd: number | null; level: SpendLevel }[]>`. A service with no cap row has `capUsd: null` and level `ok`. Levels use the same 80% rule.
  - `allowOptionalJob(db, now, services?: Service[]): Promise<boolean>`: the existing total-cap check **and** false if any listed service is `capped`. With no list, behavior is unchanged.
  - `runDueRadars` passes `["brightdata", "places"]`.
  - `GET /api/spend` gains `services: ReturnType<typeof serviceSpend>`; `PUT /api/spend/caps/:service` takes `{ monthlyUsd: number | null }` (`null` removes the cap).
  - `serviceCapLine(s: { service: string; spentUsd: number; capUsd: number | null }): string`. Exact copy: `` `${service}: $${spent} of $${cap}` `` with whole-dollar rounding, or `` `${service}: $${spent}, no cap` ``.

- [ ] **Step 1: Write the failing tests:**
  - `service over its cap pauses optional radar runs with skipped "spend_cap" even when the total is fine`
  - `service at 80% is warn`, `service without a cap is never capped`
  - `allowOptionalJob without services ignores sub-caps`
  - `PUT caps validates and removes with null`, `GET spend includes services`
  - `serviceCapLine` copy for both forms.
- [ ] **Step 2: Run** `npx vitest run test/spend-caps.test.ts test/spend.test.ts`. Expected: FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run all + build** `npm test && npm run typecheck && npm run build`. Expected: PASS.
- [ ] **Step 5: Commit** — `git add -A && git commit -m "feat(spend): per-service sub-caps that pause optional jobs"`

---

### Task 13: Claude task queue and reply classification (cut line)

**Files:**
- Create: `migrations/0034_claude_tasks.sql`, `src/worker/db/claudeTasks.ts`, `src/worker/sequence/replies.ts`
- Modify: `src/worker/mail/sync.ts` (enqueue on a matched `reply`), `src/worker/mcp/server.ts` (two tools), `src/worker/sequence/engine.ts` (nurture handling), `test/mcp.test.ts` (tool count)
- Test: `test/claude-tasks.test.ts`

**Interfaces:**
- Produces:
  - Table `claude_tasks (id, kind 'reply.classify', payload TEXT, status 'pending'|'claimed'|'done'|'failed', result TEXT, error TEXT, created_at, claimed_at, done_at)`.
  - `enqueueClaudeTask(db, kind: "reply.classify", payload: { messageId: string; businessId: string; enrollmentId: string | null }): Promise<string>`
  - `claimNextClaudeTask(db, now: Date, kinds?: ClaudeTaskKind[]): Promise<ClaudeTask | null>`: a single `UPDATE … WHERE status='pending' OR (status='claimed' AND claimed_at < now-30min) … RETURNING`, oldest first.
  - `completeClaudeTask(env, id: string, result: unknown): Promise<{ ok: true } | { ok: false; error: string }>`: validates by kind, applies effects once, and returns `already done` on a second call.
  - `ReplyResult = { label: "interested" | "question" | "not_now" | "stop" | "other"; draft?: { subject: string; body: string } }`; `draft` is required for `interested` and `question`.
  - Effects of a valid result: `stop` → `stopOutreach(reason "opt_out")`; `not_now` → the enrollment becomes `nurture` and `next_due_at = +90 days`, and `scanDueSteps` then uses the campaign's `checkin` step; `interested` or `question` → an `email.send` approval (`drafted_by "mcp"`, `inReplyTo` the reply's message id, mailbox `outreach`); `other` → an activity note only. Every completion logs `logAgentAction({ actor: "mcp", tool: "complete_claude_task", … })`.
  - MCP tools (extends Plan 1's four, now six): `next_claude_task({ kinds?: string[] })` returns the task plus its context (the unquoted reply text, lead name, the last outbound subject and body, and the campaign's `checkin` template); `complete_claude_task({ id, result })`. There is still no approve, reject or send tool.

- [ ] **Step 1: Write the failing tests** (`test/claude-tasks.test.ts`):
  - `matched reply enqueues one classify task`, `an auto reply or bounce does not`
  - `claim is atomic`: `Promise.all` of two claims returns one task and one `null`.
  - `stale claim is reclaimed after 30 minutes`
  - `interested without a draft is rejected`
  - `not_now moves the enrollment to nurture 90 days out`
  - `interested creates a pending email.send approval and sends nothing`
  - `second completion is rejected`
  - `stop result suppresses the lead`
  - `mcp lists exactly six tools` (update the Plan 1 assertion).
- [ ] **Step 2: Run** `npx vitest run test/claude-tasks.test.ts test/mcp.test.ts`. Expected: FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run all + build** `npm test && npm run typecheck && npm run build`. Expected: PASS.
- [ ] **Step 5: Real client check** (as in Plan 1 Task 8, Step 5). Insert a classify task for a seeded reply, ask Claude Code to "work the next Claude task", and confirm a pending approval appears on Home and an `mcp` row appears in agent actions.
- [ ] **Step 6: Commit** — `git add -A && git commit -m "feat(queue): Claude task queue and reply classification over MCP"`

---

### Task 14: Ship

- [ ] **Step 1: Full verification** — `npm test && npm run typecheck && npm run build`. Expected: PASS.
- [ ] **Step 2: Logan's prerequisites (spec §18), confirm each before the real send:**
  - sitelineweb.com and hellositeline.com are bought;
  - the outreach mailbox exists and its warm-up clock was started in Task 9;
  - a subdomain of hellositeline.com (for example `go.`) is attached to the Worker as a custom domain, and its URL is the value of `OUTREACH_LINK_BASE`;
  - SPF, DKIM and DMARC for the outreach domain are set and pass a check such as mail-tester.com (the connection test only checks SPF).
- [ ] **Step 3: Secrets, var and migrations (Logan runs or OKs each):**

```bash
npx wrangler secret put MAILBOX_OUTREACH_PASSWORD
npx wrangler secret put MAILBOX_MAIN_PASSWORD
npx wrangler d1 migrations apply site-search --remote
```
Set `OUTREACH_LINK_BASE` in `wrangler.jsonc` `vars`. Expected: migrations 0028–0034 applied.
- [ ] **Step 4: Open a PR** from `feat/agency-os-mail` to `main` linking the spec and this plan. Deploy after merge with `npm run deploy`.
- [ ] **Step 5: Production checks, after the warm-up gate allows it or with a test send:**
  - Mailboxes → Test connection passes, and Send test arrives in Logan's inbox;
  - start a sequence on a test lead whose recipient is a second address Logan owns; the approval appears on Home; approving it sends exactly one message;
  - reply "stop" from that address; within 15 minutes the lead shows `lost` and the sequence is stopped;
  - the Mailboxes page shows "Checked N min ago".
