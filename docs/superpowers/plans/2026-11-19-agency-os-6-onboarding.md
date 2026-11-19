# Agency OS — Plan 6: Onboarding (Welcome, Questionnaire, Content Collection) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** When a client's deposit is paid, start their onboarding: a welcome email (Logan approves it), a questionnaire due in 2 days, and a content-collection page with per-item instructions, phased due dates and file uploads. Escalating reminders and a Friday "waiting on you" email are drafted for approval, and after 14 days of silence the client is marked *Waiting on client*.

**Architecture:** `onInvoicePaid` (Plan 5) calls `startOnboarding`, which freezes a questionnaire and a list of content items from the signed document's packages into an `onboardings` row with its own client token. The welcome mail is a `onboarding.welcome` approval. The client works on a public page (`/o/<token>`, API `/api/public/o/<token>`) that autosaves answers, takes text and file uploads (R2) and records when the client last did anything. A daily sweep derives the stage and drafts reminders as `onboarding.nudge` approvals, never sending. Stage is computed from fields by one pure function, not stored, so Plan 7 (projects) reads the same answer.

**Tech Stack:** Existing stack (Workers, Hono, D1, R2 `RAW`, zod, vitest Workers pool, React SPA). No new npm packages and no Claude calls.

**Spec:** `docs/superpowers/specs/2026-11-17-agency-os-design.md` (source: `/Users/loganirish/Project Sites/agency/docs/specs/2026-11-17-agency-os-design.md`). Implemented: §9.5 (welcome email, questionnaire due in 2 days, content collection with phased due dates, Friday email, escalating reminders, 14-day silence → *Waiting on client*); §5 client-facing pages on `clients.sitelineweb.com`; §12 Phase 2 line "Onboarding, questionnaires, content collection". **Not in this plan:** the site access checklist (§9.5; belongs to Phase 2 "Client and site records with access checklist"), kickoff booking beyond a date Logan types, the "done / next" half of the Friday email (needs projects and tasks, next plan), SOP/project creation, Meetily, the full MCP toolset.

**Phase 2 roadmap:** **6 Onboarding (this plan)** · 7 Projects, SOP engine, tasks, time, change orders · 8 Stripe invoices, subscriptions, reminders and pause · 9 Client and site records, access checklist · 10 Meetily, full MCP, money dashboard v1.

**Starts from:** `main` after PR #26 (Plan 5, merge 1ff3777). Relies on: `onInvoicePaid`/`winDeal` (`documents/deposit.ts`), `Document` and `ProposalContent` (`db/documents.ts`, `documents/proposal.ts`: `content.header`, `content.packages[].key`), `newClientToken`/`isClientToken` (`documents/token.ts`), `clientBase`/`clientLink` (`documents/mail.ts`), `TERMS.silenceDays` (`documents/clauses.ts`), `registerHandler` (`approvals/registry.ts`), `createApproval`, `sendEmail` (`mail/send.ts`), `logActivity`/`logActivityOnce`, `runScheduled` (`schedule.ts`), `clientLimited` and the public-route patterns (`routes/public.ts`), `requireAuth`'s public-path list (`auth.ts`), `getBookingConfig` timezone. Migration numbers are placeholders: take the next free after the last on `main` (0053 at time of writing).

## Global Constraints

- Branch `feat/agency-os-onboarding` from `main`. `npm test && npm run typecheck` pass after every task. Never edit an applied migration. Run from the worktree `../site-search-agency-os`.
- Nothing is sent to a client without Logan's approval (spec §2). Every client-bound mail here (welcome, reminders, Friday) is an approval; the app sends no mail on its own in this plan.
- A **test** onboarding (`test = 1`) mails only Logan's own `settings.contact_email`, never the contact on the document (the Plan 5 lesson: a test copy once mailed the real prospect).
- Store no password, key or login anywhere (spec §2 anti-goal). The client page says so, and a free-text answer that looks like a credential is refused (Task 4).
- Client pages use `CLIENT_LINK_BASE` (spec §5), never `workers.dev`, never the cold-email host. A token that is unknown, malformed or revoked answers 404 for every route; responses are `no-store`, `noindex`, `no-referrer`, `frame-ancestors 'none'`.
- Text from the client (answers, item text, file names) is untrusted: length-capped, control and bidirectional characters stripped, escaped everywhere it is shown. File names never form an R2 key or a response header unescaped.
- Terms: questionnaire due **2 days** after the welcome is sent; back-of-queue after **14 days** of silence (`TERMS.silenceDays`, spec §9.5/§11); reminder days `[2, 4, 7, 10]` after the last client activity; phase 1 content due **7 days** and phase 2 **14 days** after the welcome is sent (Logan's to confirm; the spec gives only "phased due dates", with phase 1 = homepage + one service page). The "plan for client delays of 15–25%" rule (spec §9.5) is a note on the owner panel, not code.
- Times are UTC ISO strings with milliseconds; "Friday" and displayed due dates use the booking config timezone (default America/Los_Angeles). Money is not involved.
- Question wording, item instructions and mail copy are written fresh. Never reuse Webfor wording, and never copy from the course digests in `research/` (private resale material).
- Follow existing patterns: zod, DB helpers in `src/worker/db/*.ts`, pure view helpers in `src/client/*View.ts` tested in `test/*-view.test.ts`.

## Scope decisions (flag to Logan)

- **Onboarding starts when a real deposit is paid**, from `onInvoicePaid`, once per deal (UNIQUE `deal_id`). A "Start a test onboarding" button on a won or test deal makes a `test = 1` copy for rehearsing before the first real client.
- **All client mail is an approval**, including reminders. The spec lets reminders be automatic for invoices; for onboarding it says only "escalating reminders", and §2 forbids unapproved client mail. Cost if wrong: one approval click per reminder; a Settings switch can come later.
- **Two kinds of onboarding.** `build` (Starter, Growth, Subscription): full questionnaire plus content items. `light` (Quick Fix, Care only, Local SEO only): the short questionnaire, no content items (Quick Fix content is on Logan's task list in Plan 7).
- **Welcome video is a pasted https link** Logan records himself (spec: under 1 minute). No upload, no hosting. With no link the welcome is the plain template.
- **Kickoff is a date Logan types** (`kickoffAt`); it shows on the client page. No calendar integration (the Plan 4 booking is discovery/recommendation only).
- **Stage is derived, not stored**: `welcome` → `questionnaire` → `collecting` → `complete`, overlaid with `waiting_on_client`. A client write clears the waiting overlay by itself.
- **Cut line (spec §12 six-week rule):** drop the Today item (Task 9), then the Friday email (Task 8), then file previews. Welcome, questionnaire, content items, uploads and the silence rule stay.

## Review Focus

1. **Someone who must not be mailed, or a mail sent twice.** A test onboarding mailing the real contact; an approval approved twice; the sweep run twice in one day; a reminder approved after the client already finished. Tests in Tasks 3 and 8.
2. **Hostile or careless client input.** `<script>` in an answer, a 5 MB answer, bidi/control characters, a password typed into a free-text box, a file named `../../x.html`, an `.html` or `.svg` renamed `.jpg`, a 3 GB upload, 11 files on one item. Tests in Tasks 4 and 5.
3. **A link that outlives its welcome.** Revoked link, a new link after revoke, a closed onboarding, a token from another client's item id, writes after close. Tests in Tasks 4 and 7.
4. **Timekeeping.** Friday computed in the wrong zone near midnight, the 14-day boundary (13d 23h vs 14d), silence measured from views instead of writes, a client who answers on day 13 and goes quiet again, a due date in a past phase. Tests in Tasks 2 and 8.
5. **Deals that are not what onboarding assumes.** A deposit paid twice (webhook replay), a deal won by something other than a signed document, a signed document with no contact email, a lead deleted or archived mid-onboarding, a package key the templates do not know. Tests in Tasks 1, 3 and 8.

---

### Task 1: Storage

**Files:**
- Create: `migrations/<next>_onboarding.sql`, `src/worker/db/onboardings.ts`
- Test: `test/onboarding-db.test.ts`

**Interfaces:**
- Produces (`db/onboardings.ts`):
  - `OnboardingKind = "build" | "light"`; `ItemKind = "text" | "files"`; `ItemStatus = "waiting" | "received" | "accepted" | "not_applicable"`.
  - `Onboarding { id; businessId; dealId; documentId; kind: OnboardingKind; test: boolean; token: string; revokedAt: string | null; welcomeVideoUrl: string | null; welcomeSentAt: string | null; questionnaireDueAt: string | null; questionnaireSubmittedAt: string | null; kickoffAt: string | null; lastClientActivityAt: string | null; closedAt: string | null; createdAt: string; updatedAt: string }`
  - `OnboardingItem { id; onboardingId; key: string; label: string; instructions: string; kind: ItemKind; phase: 1 | 2; dueAt: string | null; status: ItemStatus; textValue: string | null; custom: boolean; position: number; updatedAt: string }`; `NewItem = Pick<OnboardingItem, "key" | "label" | "instructions" | "kind" | "phase">`
  - `OnboardingFile { id; itemId; r2Key; fileName; contentType; sizeBytes; uploadedAt }`
  - `createOnboarding(db, o: { businessId; dealId; documentId; kind; test: boolean; items: NewItem[] }): Promise<{ onboarding: Onboarding; created: boolean }>` (idempotent per deal: a second call returns the existing row with `created: false` and adds no items).
  - `getOnboarding(db, id)`, `getOnboardingByToken(db, token)` (null when revoked), `getOnboardingForDeal(db, dealId)`, `listOpenOnboardings(db): Promise<Onboarding[]>` (not closed, not revoked-only), `listItems(db, id): Promise<OnboardingItem[]>` (by `position`), `listFiles(db, itemId)`.
  - `getAnswers(db, id): Promise<Record<string, string>>`; `saveAnswers(db, id, answers: Record<string, string>, now: string): Promise<void>` (upsert per question id, in one batch, also sets `lastClientActivityAt`).
  - `submitQuestionnaire(db, id, now): Promise<"submitted" | "already">`; `markWelcomeSent(db, id, o: { sentAt: string; questionnaireDueAt: string; phaseDue: { 1: string; 2: string } }): Promise<boolean>` (true only on the first call; sets each item's `dueAt` by phase and `lastClientActivityAt = sentAt`).
  - `saveItemText(db, itemId, text: string, now): Promise<void>` (status `received` when non-empty, `waiting` when emptied, unless already `accepted`/`not_applicable`); `addFile(db, f: Omit<OnboardingFile, "uploadedAt"> & { now: string }): Promise<void>` (item becomes `received`); `removeFile(db, fileId): Promise<OnboardingFile | null>` (item back to `waiting` when it was the last file); `setItemStatus(db, itemId, s: ItemStatus)`; `addCustomItem(db, id, i: NewItem & { dueAt: string | null }): Promise<OnboardingItem>`.
  - `touchClient(db, id, now)`; `setOwnerFields(db, id, f: { welcomeVideoUrl?: string | null; kickoffAt?: string | null }): Promise<Onboarding>`; `setRevoked(db, id, on: boolean, now): Promise<Onboarding>` (sets or clears `revokedAt`); `newToken(db, id): Promise<Onboarding>` (replaces the token; the old one is dead at once); `closeOnboarding(db, id, now)`.
  - `recordNudge(db, id, key: string, now): Promise<boolean>` (true only for the first insert of `(id, key)`), `attachNudgeApproval(db, id, key, approvalId)`, `forgetNudge(db, id, key)`.

- [ ] **Step 1: Write the failing tests** (`onboarding-db`): `create is idempotent per deal and adds items once`, `items come back in position order`, `getOnboardingByToken is null after revoke and works again after a new link`, `saveAnswers upserts and bumps lastClientActivityAt`, `submitQuestionnaire is submitted once then already`, `markWelcomeSent is true once and sets due dates by phase`, `a file makes its item received and removing the last file makes it waiting`, `text on an accepted item keeps accepted`, `recordNudge is true once per key`, `hasOnboarding is true once one exists`, `the lead delete route refuses a lead that has an onboarding` (the migration has no `ON DELETE CASCADE` on `business_id` or `deal_id`, like `documents`, so a lead with an onboarding is archived, not deleted).
- [ ] **Step 2: Run to verify failure.** Run: `npx vitest run test/onboarding-db.test.ts`. Expected: FAIL (module missing).
- [ ] **Step 3: Migration.** Tables `onboardings` (columns as `Onboarding`, `deal_id` UNIQUE, `token` UNIQUE index), `onboarding_answers (onboarding_id, question_id, answer, updated_at, PK both)`, `onboarding_items`, `onboarding_files (r2_key UNIQUE)`, `onboarding_nudges (onboarding_id, key, approval_id, created_at, PK (onboarding_id, key))`. Header comment states times are UTC ISO and client text is untrusted.
- [ ] **Step 4: Implement `db/onboardings.ts`** to the signatures above, with `hasOnboarding(db, businessId): Promise<boolean>` and the lead-delete guard in `routes/leads.ts` (same place Plan 5 refuses for documents).
- [ ] **Step 5: Run all.** Run: `npm test && npm run typecheck`. Expected: PASS.
- [ ] **Step 6: Commit** — `git add -A && git commit -m "feat(onboarding): storage"`

---

### Task 2: Templates, schedule and mail copy (pure)

**Files:**
- Create: `src/worker/onboarding/templates.ts`, `src/worker/onboarding/schedule.ts`, `src/worker/onboarding/mail.ts`
- Test: `test/onboarding-templates.test.ts`, `test/onboarding-schedule.test.ts`, `test/onboarding-mail.test.ts`

**Interfaces:**
- Consumes: `PackageKey` (`db/packages.ts`), `OnboardingKind`/`OnboardingItem`/`NewItem`/`Onboarding` (Task 1), `TERMS` (`documents/clauses.ts`), `Settings`.
- Produces (`templates.ts`):
  - `Question { id: string; label: string; help?: string; type: "short" | "long" | "choice"; options?: string[]; required: boolean; kinds: OnboardingKind[] }`; `QUESTIONS: Question[]` (about 14: what the business does and for whom; top three services by profit; service area; what makes you different; three sites you like and why; words for your voice; existing logo/brand colors yes/no; who updates the site after launch; anything you do not want on the site; best contact times; a "who registered your domain" question that asks for a name only; `light` kinds get the first 6).
  - `ItemTemplate { key: string; label: string; instructions: string; kind: ItemKind; phase: 1 | 2; appliesTo: (keys: PackageKey[]) => boolean }`; `ITEM_TEMPLATES` (phase 1: logo files, brand colors and fonts text, homepage text, homepage photos, first service page text, service photos; phase 2: about text, team photos, reviews text, service-area/cities text for `growth_site`, extra pages text for `starter_site`, FAQ text, social links text).
  - `onboardingKindOf(keys: PackageKey[]): OnboardingKind`; `questionsFor(kind): Question[]`; `itemsFor(keys: PackageKey[]): NewItem[]` (empty for `light`; unknown keys are ignored, never thrown).
  - `validateAnswers(kind, answers: Record<string, string>, o: { requireAll: boolean }): { problems: string[] }` (unknown id, over cap [short 300, long 3000, choice must match an option], missing required when `requireAll`, `looksLikeCredential` refusal; messages name the question id only, never echo the text); `cleanText(s: string, max: number): string` (strip C0 controls except newline/tab, `\p{Cf}`, trim, cut); `looksLikeCredential(s: string): boolean` (matches `/(pass(word|code|phrase)?|pwd|login|api[ _-]?key|secret|token)\s*[:=]/i`).
- Produces (`schedule.ts`):
  - `REMINDER_DAYS = [2, 4, 7, 10] as const`, `QUESTIONNAIRE_DUE_DAYS = 2`, `PHASE_DUE_DAYS = { 1: 7, 2: 14 } as const`, `SILENCE_DAYS = TERMS.silenceDays`.
  - `Stage = "welcome" | "questionnaire" | "collecting" | "waiting_on_client" | "complete"`; `stageOf(o: Onboarding, items: OnboardingItem[], now: Date): Stage` (`complete` = closed, or questionnaire submitted and no item `waiting`; `welcome` = welcome not sent; `waiting_on_client` = `SILENCE_DAYS` or more since `lastClientActivityAt` while not complete; else `questionnaire` before submit and `collecting` after).
  - `dueDatesFor(sentAt: Date): { questionnaireDueAt: string; phaseDue: { 1: string; 2: string } }`; `silentDays(o, now): number` (whole days since last client write; before the welcome is sent, 0).
  - `Nudge { key: string; kind: "reminder" | "friday"; level: 1 | 2 | 3 | 4 | null; fridayOf: string | null }`; `nudgesDue(o, items, now: Date, tz: string): Nudge[]` (a reminder at level *n* is due when `silentDays >= REMINDER_DAYS[n-1]` and not complete and welcome sent; key `reminder:<n>:<lastClientActivityAt>` so a client who answers resets the ladder; a Friday nudge is due on a Friday in `tz` when there is any waiting item or the questionnaire is unsubmitted; key `friday:<YYYY-MM-DD in tz>`; who receives a test onboarding's nudge is decided in Task 8, not here).
- Produces (`mail.ts`): `renderWelcome(o: Onboarding, c: { clientName; contactName }, link: string, s: Settings): { subject: string; body: string }` (mentions the video link when set, the 2-day questionnaire, "never send passwords"), `renderReminder(level: 1 | 2 | 3 | 4, ctx, link, s)` (level 3 names the back-of-queue date, level 4 says what the 14-day clause means in plain words), `renderFriday(ctx: { waiting: string[]; received: string[]; questionnaireDone: boolean }, link, s)`. Plain text, no markup, client text used only as data after `cleanText`.

- [ ] **Step 1: Write the failing tests.** Templates: `a starter site gets homepage and one service page in phase 1`, `growth adds service-area but starter does not`, `quick fix and care only are light and get no items`, `unknown package keys are ignored`, `required questions block submit`, `a free-text answer with "password: x" is refused and the problem does not echo it`, `an answer with bidi controls is cleaned`, `choice must match an option`. Schedule: `stage is welcome until the welcome is sent`, `13 days 23 hours of silence is not waiting and 14 days is`, `a write 3 days ago resets silence`, `reminder level 1 is due at 2 days, level 4 at 10`, `a client write changes the reminder key so the ladder restarts`, `friday in Los Angeles at 23:30 Thursday UTC-8 is not Friday and 00:30 Friday is`, `no nudge once complete`, `no nudge before the welcome is sent`, `dueDatesFor gives questionnaire +2 days and phases +7/+14`. Mail: `welcome includes the video link only when set`, `every mail contains the link exactly once and no markup`, `level 3 names a date 14 days after last activity`, `client text containing a URL stays inert text`.
- [ ] **Step 2: Run to verify failure.** Run: `npx vitest run test/onboarding-templates.test.ts test/onboarding-schedule.test.ts test/onboarding-mail.test.ts`. Expected: FAIL.
- [ ] **Step 3: Implement the three modules** to the signatures above. Timezone math uses `Intl.DateTimeFormat` with the zone (no library). Question and item text is written by the implementer in plain, direct sentences addressed to the client.
- [ ] **Step 4: Run all.** Run: `npm test && npm run typecheck`. Expected: PASS.
- [ ] **Step 5: Commit** — `git add -A && git commit -m "feat(onboarding): templates, schedule, mail copy"`

---

### Task 3: Start on payment and the welcome approval

**Files:**
- Create: `src/worker/onboarding/start.ts`, `src/worker/approvals/onboardingWelcome.ts`
- Modify: `src/worker/documents/deposit.ts` (`onInvoicePaid`), `src/worker/index.ts` (import the approval for its side effect), `src/worker/mcp/server.ts:13` (`APP_PROPOSED` gains `"onboarding.welcome"`, `"onboarding.nudge"`), `src/worker/types.ts` (`ACTIVITY_KINDS` gains `"onboarding_started"`, `"onboarding_welcome"`, `"onboarding_submitted"`, `"onboarding_received"`, `"onboarding_waiting"`, `"onboarding_resumed"`), `src/client/activityView.ts` (labels) 
- Test: `test/onboarding-start.test.ts`

**Interfaces:**
- Consumes: Tasks 1–2; `Document`; `getDeal`; `getSettings`; `sendEmail`; `clientBase`, `clientLink`, `mainMailboxProblem`.
- Produces:
  - `startOnboarding(env: Env, doc: Document, o?: { test?: boolean }): Promise<Onboarding | null>`: null (and a `note` on the lead) when `doc.status !== "signed"`, the contact email is empty, or `CLIENT_LINK_BASE` is unset (the approval cannot be mailed, so say so on the timeline instead of failing the payment). Otherwise `createOnboarding` with `kind` and items from the document's `content.packages` keys, logs `onboarding_started` once, and calls `createWelcomeApproval`. Safe to repeat. Never throws into `onInvoicePaid`: a failure is logged and the payment path continues.
  - `createWelcomeApproval(env, o: Onboarding): Promise<Approval>`: kind `onboarding.welcome`, payload `{ onboardingId: string }`, `record_type: "deal"`, `drafted_by: "logan"`, preview showing To (the contact, or the owner for a test), subject, body and the video link. One waiting approval per onboarding (a second call returns the first).
  - `onboardingWelcome` handler (registered, label "Send onboarding welcome"): `execute` sends via `sendEmail(env, { mailbox: "main", to, subject, body, includeFooter: false, businessId }, { approvalId, skipLimits: true })` where `to` is `settings.contact_email` when `o.test`, else the document contact; then `markWelcomeSent` with `dueDatesFor(now)` and logs `onboarding_welcome` once. A retry after a sent mail does not send again (`sendEmail` is once-only per approval) and still finishes `markWelcomeSent`.
- Modified `onInvoicePaid`: after `winDeal` and before `setPaid`, for a non-test document call `startOnboarding(env, doc)` inside a try/catch that logs and continues.

- [ ] **Step 1: Write the failing tests.** `a paid real deposit starts one onboarding and one welcome approval`, `a replayed payment starts nothing new`, `a test document starts no onboarding from payment`, `the manual test start mails only the owner address`, `a light package set makes no items`, `no contact email leaves a timeline note and no approval`, `no CLIENT_LINK_BASE leaves a note and the payment still completes`, `approving the welcome mails once, sets due dates and logs once`, `approving twice sends once`, `the welcome link is the client link for the onboarding token on /o/`, `onboarding.welcome cannot be proposed through the MCP tool`.
- [ ] **Step 2: Run to verify failure.** Run: `npx vitest run test/onboarding-start.test.ts`. Expected: FAIL.
- [ ] **Step 3: Implement** `start.ts`, the handler, the `onInvoicePaid` hook and the registry/MCP/activity edits. Add `/o/` to `PUBLIC_PAGE_PREFIXES` (`mail/send.ts:48`) so the link guard accepts onboarding links on the client host only.
- [ ] **Step 4: Run all.** Run: `npm test && npm run typecheck`. Expected: PASS.
- [ ] **Step 5: Commit** — `git add -A && git commit -m "feat(onboarding): start on payment, welcome approval"`

---

### Task 4: Client page API: view, answers, submit

**Files:**
- Create: `src/worker/onboarding/public.ts`
- Modify: `src/worker/routes/public.ts` (routes under `/o/:token`, `clientLimited` on each), `src/worker/auth.ts:61-63` (public path regexes for `/api/public/o/<seg>` GET, PUT `.../answers`, POST `.../submit`, `.../items/<seg>/text`, `.../items/<seg>/files`, DELETE `.../files/<seg>`), `public/_headers` (`/o` and `/o/*` like `/p`)
- Test: `test/onboarding-public.test.ts`

**Interfaces:**
- Consumes: Tasks 1–2.
- Produces (`public.ts`):
  - `PublicOnboarding { businessName: string; contactFirstName: string; stage: Stage; kickoffAt: string | null; welcomeVideoUrl: string | null; questionnaire: { questions: Question[]; answers: Record<string, string>; dueAt: string | null; submittedAt: string | null }; items: { id: string; key: string; label: string; instructions: string; kind: ItemKind; phase: 1 | 2; dueAt: string | null; status: ItemStatus; textValue: string | null; files: { id: string; fileName: string; sizeBytes: number }[] }[]; progress: { done: number; total: number }; closed: boolean; timezone: string }`
  - `onboardingPage(env, token: string, now: Date): Promise<PublicOnboarding | null>` (null for malformed, unknown, revoked; a closed onboarding still reads, with `closed: true`). Records no view row; only writes count as client activity.
  - `saveClientAnswers(env, token, answers: Record<string, string>, now): Promise<{ ok: true } | { ok: false; status: 400 | 404 | 409 | 422; fields?: string[] }>`: 404 unknown, 409 closed or already submitted, 400 shape, 422 refused credential-looking text (field ids only in `fields`), writes only known question ids after `cleanText`, touches activity, logs `onboarding_resumed` once when the stage was `waiting_on_client`.
  - `submitClientQuestionnaire(env, token, now): Promise<same union>`: runs `validateAnswers(kind, stored, { requireAll: true })`, `submitQuestionnaire`, logs `onboarding_submitted` once.
  - `saveClientItemText(env, token, itemId, text, now): Promise<same union>`: item must belong to this onboarding and be `kind: "text"`; cap 5000; logs `onboarding_received` (once per item per day).
  - Routes: `GET /o/:token`, `PUT /o/:token/answers`, `POST /o/:token/submit`, `PUT /o/:token/items/:itemId/text`. Same 404 body for every dead token; body limit via the existing `readJson`.

- [ ] **Step 1: Write the failing tests.** `an unknown, malformed or revoked token is the same 404`, `the page never includes the token's other onboardings or the owner's notes`, `answers autosave and read back`, `unknown question ids are dropped`, `an answer with <script> is stored as text and the API returns it unchanged for escaping at render`, `5 KB in a short answer is refused`, `a password-looking answer is a 422 naming the question id and not echoing the text`, `submit with a required answer missing is a 400 listing ids`, `submit twice is already, not an error`, `writes after close are 409`, `a write after 14 days silence logs onboarding_resumed once and the stage leaves waiting_on_client`, `an item id from another onboarding is a 404`, `text on a files item is a 400`, `no session cookie is needed for these routes but one is not accepted as proof for other /api routes` (assert `/api/public/o/..` public and `/api/deals/x/onboarding` still 401), `responses carry no-store and noindex`.
- [ ] **Step 2: Run to verify failure.** Run: `npx vitest run test/onboarding-public.test.ts`. Expected: FAIL.
- [ ] **Step 3: Implement** `onboarding/public.ts`, the routes and the auth regexes. Reuse the Plan 5 limiter, `TOKEN` check and no-store header helpers in `routes/public.ts`.
- [ ] **Step 4: Run all.** Run: `npm test && npm run typecheck`. Expected: PASS.
- [ ] **Step 5: Commit** — `git add -A && git commit -m "feat(onboarding): client page API"`

---

### Task 5: File uploads

**Files:**
- Create: `src/worker/onboarding/files.ts`
- Modify: `src/worker/routes/public.ts` (`POST /o/:token/items/:itemId/files`, `DELETE /o/:token/files/:fileId`)
- Test: `test/onboarding-files.test.ts`

**Interfaces:**
- Consumes: Task 1 file helpers, `env.RAW`, Task 4 route patterns.
- Produces (`files.ts`):
  - `UPLOAD_LIMITS = { fileBytes: 20 * 1024 * 1024, perItem: 10, totalBytes: 250 * 1024 * 1024 }`; `ALLOWED_TYPES: Record<string, string[]>` (extension → accepted content types: `jpg jpeg png webp gif heic pdf docx txt`; SVG, HTML, ZIP, executables and video are refused).
  - `sniffOk(ext: string, head: Uint8Array): boolean` (magic bytes: JPEG `FF D8 FF`, PNG, GIF, WEBP `RIFF....WEBP`, PDF `%PDF`, DOCX `PK`, HEIC `ftyp` at 4; `txt` must be valid UTF-8 without NUL bytes).
  - `safeFileName(name: string): string` (basename only, `cleanText`, ≤ 120 chars, never empty: falls back to `file.<ext>`).
  - `acceptUpload(env, token, itemId, file: File, now): Promise<{ ok: true; file: { id: string; fileName: string; sizeBytes: number } } | { ok: false; status: 400 | 404 | 409 | 413 | 415; error: string }>`: item must be `kind: "files"` of this onboarding; checks the three limits (counting stored bytes, not the claim), extension allow-list, sniff, then `RAW.put("onboarding/<onboardingId>/<itemId>/<uuid>", bytes, { httpMetadata: { contentType } })` with a server-chosen content type, then `addFile`. If `addFile` fails after the put, the object is deleted.
  - `removeClientFile(env, token, fileId, now): Promise<{ ok: boolean }>` (deletes the row, then the object; a file already received/accepted by Logan can still be removed by the client only while the item is `received`, not `accepted`).
  - Route reads `Content-Length` first and answers 413 before buffering when it exceeds `fileBytes + 64 KiB`.

- [ ] **Step 1: Write the failing tests.** `a png uploads and the item becomes received`, `an html file renamed .jpg is refused by the sniff (415)`, `an svg is refused`, `a 21 MB file is 413 and nothing is stored`, `the 11th file on an item is refused`, `the total cap counts what is stored`, `../../x.png is stored under a server key and the name is cut to its basename`, `the R2 key contains no part of the file name`, `a files upload on a text item is 400`, `an item of another onboarding is 404`, `removing a file deletes the row and the object`, `a failed row insert deletes the stored object`, `the client cannot remove a file once the item is accepted`.
- [ ] **Step 2: Run to verify failure.** Run: `npx vitest run test/onboarding-files.test.ts`. Expected: FAIL.
- [ ] **Step 3: Implement** `files.ts` and the two routes (multipart via `request.formData()`, field name `file`).
- [ ] **Step 4: Run all.** Run: `npm test && npm run typecheck`. Expected: PASS.
- [ ] **Step 5: Commit** — `git add -A && git commit -m "feat(onboarding): client file uploads"`

---

### Task 6: Client page UI

**Files:**
- Create: `src/client/pages/Onboard.tsx`, `src/client/onboardView.ts`
- Modify: `src/client/App.tsx` (`<Route path="/o/*" element={<Onboard />} />`, no shell, like `/p/*`), `src/client/public.css`
- Test: `test/onboard-view.test.ts`

**Interfaces:**
- Consumes: `PublicOnboarding` shape (Task 4) as a client type in `onboardView.ts`.
- Produces (`onboardView.ts`, pure): `dueLabel(iso: string | null, now: Date, tz: string): string` ("Due Fri, Dec 4", "Overdue by 2 days", "No date yet"); `itemStateLabel(s: ItemStatus): string`; `progressLabel(p: { done: number; total: number }): string`; `canSubmit(q: PublicOnboarding["questionnaire"]): { ok: boolean; missing: string[] }`; `formatBytes(n: number): string`; `groupByPhase(items): { phase: 1 | 2; title: string; items: ... }[]` (titles "First: homepage and one service page" and "Then: the rest of the site").
- Page behavior: one column, phone first. Top: welcome (video link if set), kickoff date if set, progress. Questionnaire section with autosave on blur (debounced PUT), a clear "Send answers" button disabled with the missing list; content sections by phase, each item showing its instructions, due label, a text area (autosave) or file picker with per-file remove; every client string rendered as text, never as HTML. A fixed note: "Please don't type any passwords here. We'll ask for access a safer way." A dead token shows a plain "This link is no longer active. Reply to the email you were sent." page. A closed onboarding shows "All done" read-only.

- [ ] **Step 1: Write the failing tests** (`onboard-view`): `dueLabel in the booking zone near midnight`, `overdue is plural-correct`, `canSubmit lists missing required ids`, `groupByPhase puts phase 1 first and drops empty groups`, `formatBytes`, `progressLabel at 0 of 0 is not NaN`.
- [ ] **Step 2: Run to verify failure.** Run: `npx vitest run test/onboard-view.test.ts`. Expected: FAIL.
- [ ] **Step 3: Implement** the view helpers and `Onboard.tsx` (fetch `/api/public/o/<token>`, no cookies needed). Add print-safe, 16 px minimum inputs for iOS.
- [ ] **Step 4: Run all and build.** Run: `npm test && npm run typecheck && npm run build`. Expected: PASS. (Never viewed in a browser by the builder; the open-items note says so.)
- [ ] **Step 5: Commit** — `git add -A && git commit -m "feat(onboarding): client page"`

---

### Task 7: Owner API and the Onboarding panel

**Files:**
- Create: `src/worker/routes/onboarding.ts`, `src/client/pages/OnboardingTab.tsx`, `src/client/onboardingView.ts`
- Modify: `src/worker/index.ts` (`app.route("/api", onboardingRoutes)`), `src/client/pages/Deal.tsx` (a tab beside `ProposalTab`, visible when the deal has an onboarding or is won)
- Test: `test/onboarding-routes.test.ts`, `test/onboarding-view.test.ts`

**Interfaces:**
- Consumes: Tasks 1–5.
- Produces (routes, all behind `requireAuth`):
  - `GET /deals/:id/onboarding` → `{ onboarding: Onboarding | null; stage: Stage | null; items: (OnboardingItem & { files: OnboardingFile[] })[]; answers: Record<string,string>; questions: Question[]; link: string | null; welcomeApproval: { id: string; status: string } | null; silentDays: number }` (`link` is built from `CLIENT_LINK_BASE`; null when unset).
  - `POST /deals/:id/onboarding/test` → starts a `test = 1` onboarding for the deal's latest signed document (409 when none is signed, or one exists).
  - `POST /onboardings/:id/welcome` → re-creates the welcome approval when none is pending and the welcome has not been sent.
  - `PATCH /onboardings/:id` body `{ welcomeVideoUrl?: string | null; kickoffAt?: string | null }` (zod: https URL ≤ 300 chars with no userinfo, no credentials in the query; kickoff an ISO time; both refused after close; changing the video after the welcome is sent is allowed but does not resend).
  - `POST /onboardings/:id/items` body `{ label, instructions, kind, phase, dueAt? }` (custom item, label ≤ 120, instructions ≤ 600).
  - `PATCH /onboarding-items/:id` body `{ status: "accepted" | "not_applicable" | "waiting" }`.
  - `GET /onboarding-files/:id` → streams the object with `Content-Disposition: attachment; filename*=UTF-8''<encoded safeFileName>`, `X-Content-Type-Options: nosniff`, the stored content type.
  - `POST /onboardings/:id/link/revoke` (sets `revokedAt`), `POST /onboardings/:id/link/new` (new token, clears revoked, returns the new link), `POST /onboardings/:id/close`.
  - `onboardingView.ts` (pure): `stageLabel(s: Stage): string`, `stageTone(s: Stage): "neutral" | "good" | "warn"`, `itemRows(items)` (waiting first, then received, then done), `silenceNote(days: number): string` ("No reply for 9 days. The back-of-queue clause applies at 14.").
- Panel shows: stage chip, the welcome approval state with a link to the approval inbox, video link and kickoff fields, the questionnaire answers (read-only, escaped), items with Accept / Not needed / Ask again, files with download links, the client link with copy / revoke / new, and a fixed line "Plan for client delays of 15–25% in every timeline (spec §9.5)".

- [ ] **Step 1: Write the failing tests.** Routes: `GET returns null onboarding for a deal that has none`, `video link must be https and carry no credentials`, `kickoffAt must be a real time`, `accept moves an item from received to accepted`, `a file download is an attachment with nosniff`, `revoke makes the client page 404 and new link makes it live on a different token`, `closing makes client writes 409 and the page read-only`, `all routes are 401 without a session`, `a custom item shows on the client page`, `test start is 409 with no signed document`. View: `stageLabel covers every Stage`, `itemRows order`, `silenceNote at 14 days names the clause as applying`.
- [ ] **Step 2: Run to verify failure.** Run: `npx vitest run test/onboarding-routes.test.ts test/onboarding-view.test.ts`. Expected: FAIL.
- [ ] **Step 3: Implement** the routes, the view helpers and the tab.
- [ ] **Step 4: Run all and build.** Run: `npm test && npm run typecheck && npm run build`. Expected: PASS.
- [ ] **Step 5: Commit** — `git add -A && git commit -m "feat(onboarding): owner routes and panel"`

---

### Task 8: Daily sweep: reminders, Friday email, silence

**Files:**
- Create: `src/worker/onboarding/sweep.ts`, `src/worker/approvals/onboardingNudge.ts`
- Modify: `src/worker/schedule.ts` (a `part("onboarding sweep", ...)` in the daily branch), `src/worker/index.ts` (import the approval)
- Test: `test/onboarding-sweep.test.ts`

**Interfaces:**
- Consumes: `nudgesDue`, `stageOf`, mail renderers (Task 2), Task 1 nudge helpers, `createApproval`, `getBookingConfig` timezone.
- Produces:
  - `sweepOnboardings(env: Env, now: Date): Promise<{ reminders: number; fridays: number; waiting: number }>`: for each open onboarding, compute `nudgesDue`; for each, `recordNudge` (skip when false), `createApproval` (kind `onboarding.nudge`, payload `{ onboardingId, nudgeKey }`, title "Reminder to <client>" or "Friday update to <client>", preview = the mail with its recipient), `attachNudgeApproval`; on approval failure `forgetNudge` so tomorrow retries. For a stage of `waiting_on_client`, `logActivityOnce(…, "onboarding_waiting", "no reply for 14 days: the back-of-queue clause applies")` per silence run (detail includes the last-activity date). Never sends, never throws (each onboarding is isolated and logged).
  - `onboardingNudge` handler (label "Send onboarding reminder"): re-reads the onboarding; if it is closed, revoked, complete, or (for a reminder) the client has been active since the nudge key's timestamp, it **sends nothing and returns** with a timeline note "reminder skipped: <reason>" (it must not throw, or the approval would return to pending forever). Otherwise sends from the `main` mailbox to the contact (owner for a test) and logs `email_sent`-style activity through `sendEmail`'s own path.
  - The Friday email lists the received items and the items still waiting plus the questionnaire state; its "done / next" half is deferred to Plan 7 (`TODO(plan-7)` note in `mail.ts`).

- [ ] **Step 1: Write the failing tests.** `day-2 silence makes one level-1 reminder approval and a second sweep makes none`, `a client write resets the ladder and level 1 can be drafted again`, `friday drafts one approval per friday date`, `friday at the zone boundary` (23:30 Thursday Pacific is not Friday), `no approval for a complete, closed, revoked or welcome-unsent onboarding`, `an archived lead's open onboarding is still swept`, `a test onboarding's nudge goes to the owner address`, `approving a stale reminder sends nothing and notes why`, `approving twice sends once`, `14 days of silence logs onboarding_waiting once`, `the sweep never sends mail by itself` (fake transport sees zero sends), `one broken onboarding does not stop the others`, `the approval failing removes the nudge row so the next sweep retries`.
- [ ] **Step 2: Run to verify failure.** Run: `npx vitest run test/onboarding-sweep.test.ts`. Expected: FAIL.
- [ ] **Step 3: Implement** `sweep.ts`, the handler and the cron part; update the comment on `runScheduled` listing what the daily cron does.
- [ ] **Step 4: Run all.** Run: `npm test && npm run typecheck`. Expected: PASS.
- [ ] **Step 5: Commit** — `git add -A && git commit -m "feat(onboarding): reminders, Friday email, silence rule"`

---

### Task 9: Today item and timeline labels

**Files:**
- Modify: `src/worker/today.ts` (`TODAY_KINDS` gains `"onboarding_attention"`; one candidate pass over `listOpenOnboardings`), `src/client/todayView.ts`, `src/client/activityView.ts` (labels for the six new activity kinds, if Task 3 did not finish them), `test/today.test.ts`
- Test: `test/onboarding-today.test.ts`

**Interfaces:**
- Consumes: `listOpenOnboardings`, `listItems`, `stageOf`, `buildToday`'s `push` pattern (`proposal_follow_up` is the model).
- Produces: one Today item per lead with an open, non-test onboarding when any of: the stage is `waiting_on_client` ("No reply for N days: back of the queue"), items are `received` and not yet accepted ("N items from <client> to review"), or the welcome approval is still unsent for over 1 day ("Welcome email is waiting for you"). Priority 70 (above `proposal_follow_up`, which is 65). Done/snooze work like the other kinds.

- [ ] **Step 1: Write the failing tests.** `a received item shows a review item`, `waiting_on_client shows the silence item`, `an unsent welcome older than a day shows`, `a test or complete onboarding shows nothing`, `done hides it for 7 days like the other kinds`, `a suppressed lead still shows it (it is a client)`.
- [ ] **Step 2: Run to verify failure.** Run: `npx vitest run test/onboarding-today.test.ts`. Expected: FAIL.
- [ ] **Step 3: Implement** the Today pass and labels.
- [ ] **Step 4: Run all.** Run: `npm test && npm run typecheck`. Expected: PASS.
- [ ] **Step 5: Commit** — `git add -A && git commit -m "feat(onboarding): Today item and timeline labels"`

---

### Task 10: End-to-end flow and the open-items note

**Files:**
- Create: `test/onboarding-flow.test.ts`, `docs/superpowers/notes/2026-11-plan-6-open-items.md`
- Modify: `README.md` (a short "Onboarding" section: the three pieces, the sweep, the Worker config it needs)

**Interfaces:**
- Consumes: everything above, plus the fakes `test/close-flow.test.ts` already uses (Stripe, mail transport, PDF browser).

- [ ] **Step 1: Write the flow test.** One test drives real entry points: a signed Starter proposal is paid through `/hooks/stripe`; assert the onboarding and one welcome approval exist; approve it (fake transport sees exactly one mail to the contact, with the `/o/` link on the client host); open the client page; save answers; submit with a required answer missing (400) then complete (200); upload a png and send text for the phase-1 items; assert Today shows a review item; accept the items; sweep on a fixed Friday (phase-2 items still wait): exactly one Friday approval, and a second sweep the same day adds none; then a second onboarding left silent for 14 days shows `waiting_on_client`, one `onboarding_waiting` note, and a client write clears it. Also assert: replaying the Stripe event creates nothing new; the test-start path mails only the owner.
- [ ] **Step 2: Run to verify failure, then pass.** Run: `npx vitest run test/onboarding-flow.test.ts`. Expected: FAIL first only if an earlier task left a seam open; fix the seam, not the test.
- [ ] **Step 3: Write the open-items note** (same headings as `2026-11-plan-5-open-items.md`): *Needs Logan* — apply the new migration remotely before deploying; confirm `CLIENT_LINK_BASE` serves `/o/<anything>` as a 404 page; record a welcome video and test a pasted link; run "Start a test onboarding" on a test deal, approve the welcome, open the link on a phone, answer, upload photos from the camera roll (HEIC), and check the owner panel and Friday approval; read every question and item instruction; *Decisions for Logan* — reminders as approvals vs automatic, the 7/14-day phase due dates, the reminder ladder `[2, 4, 7, 10]`, `light` kinds for Quick Fix/Care/SEO, the file type and size caps, whether the Friday email waits for projects; *Known gaps*; *Rulings made during the run*.
- [ ] **Step 4: Full verification.** Run: `npm test && npm run typecheck && npm run build`. Expected: all pass, test count above 3237.
- [ ] **Step 5: Commit** — `git add -A && git commit -m "docs(onboarding): flow test, README, open items"`
