# Agency OS — Plan 5 of 5: Close (Proposal, Sign, Deposit) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Take a deal from "recommended" to "won": a proposal + SOW + services agreement built from the deal's frozen prices and a clause library, sent after Logan's approval, signed by click-to-sign on a client page, and followed at once by a Stripe deposit invoice. The signed PDF carries an audit page. Payment moves the deal to Won.

**Architecture:** A pure builder (`buildProposal`) turns a deal, one chosen option and the clause library into frozen `ProposalContent` JSON; a document row stores it with its SHA-256. The `proposal.send` approval (Logan's countersignature) mints a client token and mails the link from the `main` mailbox. The client page (`/p/<token>`, host `CLIENT_LINK_BASE`) records views, takes the signature (typed name, consent, hash check), then creates a Stripe deposit invoice over REST and links its hosted page (card + ACH). A Stripe webhook marks it paid and moves the deal. No new dependencies: Stripe is `fetch` plus WebCrypto, the PDF is Browser Rendering.

**Tech Stack:** Existing stack (Workers, Hono, D1, R2, Browser Rendering, zod, vitest Workers pool, React SPA) plus the Stripe REST API. No new npm packages.

**Spec:** `docs/superpowers/specs/2026-11-17-agency-os-design.md` (source: `/Users/loganirish/Project Sites/agency/docs/specs/2026-11-17-agency-os-design.md`). Sections implemented: §9.4 "Proposal / SOW", "E-sign", "Pay"; §9.7 first half (Stripe invoice for the deposit, webhooks, stored Stripe IDs); §10 the "Proposal + SOW" row; §11 the whole clause library; §8 payment defaults ("Deposit before work starts") and the Care-on-by-default rule; §3 Legal (ESIGN basics, Oregon lawyer review); §7 Document, Signature, Invoice records; §12 Phase 1 line "Proposal/SOW, e-sign, Stripe deposit". Not in this plan (Phase 2): onboarding, milestone and final invoices, Stripe subscriptions, reminders and the +14-day pause, change orders, Care agreement and liability release as separate documents.

**Phase 1 roadmap:** 1 Foundations · 2 Mail + sequences · 2.5 Queue migration · 3 Video audits · 4 Sales (all merged) · **5 Close (this plan)**. Phase 1 exit criterion (spec §12): a test lead goes all the way to *signed + deposit paid* on a test Stripe account. Task 12 runs that path.

**Starts from:** `main` after PR #25 (Plan 4, merge f6af462). Relies on Plan 4's `Deal`, `moveDeal`, `Option`, `PackageSnapshot`, `validateOptions`, `formatPrice`, `htmlToPdf`, `deckFileName`, `lastBookingFor`; Plan 2's `sendEmail`, `stopOutreach`, `checkConflict`, the `main` mailbox; the approvals registry (`registerHandler`, `createApproval`). Migration numbers below are placeholders: take the next free number after the last on `main` (0050 at time of writing), in order.

## Global Constraints

- Branch `feat/agency-os-close` from `main`. `npm test && npm run typecheck` pass after every task. Never edit an applied migration.
- Claude is not used in this plan (no queue kind, no API). The proposal is deterministic; Logan edits its free-text fields.
- Prices, package names and inclusions come only from the deal's `priceSnapshot` (frozen at recap, spec §7 "old deals keep the price they were sold at") and `getPackage(db, key, version)`. Never read the current catalog for a deal that has a snapshot. Never hard-code a price in a clause or template; the hourly rates in the change-order clause come from the snapshot or catalog.
- Clause numbers, verbatim from spec §11: 2 revision rounds; back of the queue after 14 days of silence; re-quote after 6 months; work pause at 14 days overdue; 25% kill fee; 30-day warranty; 30-day termination notice; proposal expiry 30 days (spec §9.4); Subscription term 24 months with early exit owing the remaining term and automatic conversion to Care in month 25; Local SEO first term 6 months. Final payment is due when the site is **finished**, not at launch (spec §8).
- Every clause is marked draft until an Oregon lawyer has reviewed the library (spec §3, §11). The app refuses to send a real proposal until Settings records that review.
- ESIGN basics (spec §3): intent (typed name + sign button), consent to do business electronically (checkbox + disclosure text), record retention (signed documents are never deleted by the app), audit trail (signature row + audit page).
- Stripe secrets (`STRIPE_SECRET_KEY`, `STRIPE_WEBHOOK_SECRET`) are Worker secrets, never in D1, never in a log, an error message or a response. Store every Stripe ID (spec §9.7).
- Client pages use `CLIENT_LINK_BASE` (e.g. `https://clients.sitelineweb.com`, spec §5), never `workers.dev`, never the cold-email host. Public routes answer an unknown, malformed or dead token the same way (404) and are `no-store`, `noindex`, `no-referrer`, like `/r/<token>`.
- Nothing prospect-visible is sent without Logan's approval (spec §2), with one decided exception: the signed-copy mail to the person who just signed (a fixed template, like Plan 4's booking confirmation).
- Text from a prospect or a website (business name, contact name, typed signer name, user agent) is untrusted: escaped in every page, PDF and mail, length-capped on input.
- Times are UTC ISO strings with milliseconds. Money is integer cents.
- No Webfor names, content or pricing. Follow existing patterns: zod, DB helpers in `src/worker/db/*.ts`, pure view helpers in `src/client/*View.ts` tested in `test/*-view.test.ts`. Run from the worktree.

## Scope decisions (flag to Logan)

- **Plan 5 ends at Won.** The payment schedule is stored in the signed document so Phase 2 can invoice milestones and start subscriptions from it; this plan only invoices the deposit.
- **One combined document** (proposal + SOW + services agreement, using the §11 clauses). Care terms are clauses inside it. The separate Care agreement, liability release and change-order documents (spec §10) wait for Phase 2.
- **Deposit rules are my calls (spec gives only "deposit before work starts" and the split for Starter/Growth):** Quick Fix 100% at signing; Starter Site 50% at signing and 50% when the site is finished; Growth Site 40% at signing, 30% when design is approved, 30% when finished; Website Subscription and Local SEO: the setup fee at signing, monthly billing later; Care-style monthly items start at launch when the option includes a build, otherwise the first month is prepaid at signing. Logan: confirm or change in `documents/schedule.ts`.
- **The send approval is Logan's countersignature.** Approving `proposal.send` records the provider signature (name from Settings, time, the same hash). One click does both; there is no separate countersign step.
- **Legal gate.** Real sends are refused until Settings → Documents records "an Oregon lawyer reviewed these clauses" (date + reviewer). "Send a test to myself" works before that and creates a test document that never moves a deal.
- **No pdf-lib.** The spec names it for the audit page; Browser Rendering already renders the PDF, so the audit page is the last page of the same HTML. The hash (SHA-256 of the canonical frozen content) is what the signature binds to; the PDF's own SHA-256 is stored too.
- **Stripe over REST with the hosted invoice page.** "Pay on the same page" becomes: the sign page shows a Pay button the moment the signature lands and opens Stripe's hosted invoice (card + ACH). An embedded Payment Element is not built. Invoicing's per-invoice fee is a Logan check (spec §13).
- **Late fee has no number in the spec.** It is a setting (`lateFeePercentMonthly`, default 1.5) for the lawyer to set.
- **Care is on by default.** A site-build option with no Care line is refused unless Logan ticks "client declined Care", which adds the Care opt-out sign-off clause (spec §8, §11).
- **Cut line (spec §12 six-week rule):** drop the Today follow-up item (Task 11), then the signed-copy mail (Task 8), then test-send (Task 6). Build, send, sign, pay and the webhook stay.

## Review Focus

1. **A document that changes after it was sent, or is signed twice.** Edit after send, a stale hash on the sign request, a replaced or voided version, an expired link, two signers at once, a double click. Tests in Tasks 4 and 7: `sign with a stale hash is refused`, `two simultaneous signs leave one signature`, `a sent document cannot be edited`.
2. **Prospect text turns into markup or a wrong signature.** `<script>` in a business name, a 5 KB contact name, a typed name with control or bidi characters, a huge user agent. Tests in Tasks 5, 7 and 8.
3. **Money that does not add up.** Cents rounding across 40/30/30, setup discounts, a replayed or forged webhook, an event for another invoice, a different amount or currency, the invoice created twice on a retry, a test document in live mode. Tests in Tasks 3, 9 and 10.
4. **Contact with someone who must not be contacted, and deals that moved on.** A do-not-contact or already-won lead at send time; a deal marked lost after the proposal went out; a signature or payment arriving after that; a lead deleted while it has a signed document. Tests in Tasks 4, 6 and 10.
5. **Prices that drift or terms that are missing.** A catalog change after recap, a snapshot entry absent for an option item, Care left out of a build, Care on a non-WordPress site, the 30-day expiry boundary, a proposal built from an option that was edited after the deck was frozen. Tests in Tasks 3, 6 and 11.

---

### Task 1: Branch and baseline

**Files:** none (git and the progress ledger only).

- [ ] **Step 1: Confirm the input landed.** Run: `git log --oneline main | head -5 && git grep -n "export function validateOptions\|export async function lastBookingFor\|export async function htmlToPdf" -- src`. Expected: Plan 4's merge (f6af462) is on `main` and all three exist.
- [ ] **Step 2: Branch in the worktree.** Run: `cd ../site-search-agency-os && git switch main && git pull && git switch -c feat/agency-os-close`. Expected: clean tree.
- [ ] **Step 3: Baseline is green.** Run: `npm test && npm run typecheck`. Expected: all pass; otherwise stop and report.
- [ ] **Step 4: Note the next free migration number** in the ledger `.superpowers/sdd/2026-11-19-agency-os-5-close/progress.md`. No commit.

---

### Task 2: Documents settings and the clause library

**Files:**
- Create: `migrations/<next>_documents_config.sql`, `src/worker/documents/config.ts`, `src/worker/documents/clauses.ts`, `src/client/pages/settings/Documents.tsx`
- Modify: `src/worker/db/settings.ts` (`FIELDS` gains `documents_config`), `src/worker/types.ts` (`Settings.documents_config: string`), `src/worker/routes/settings.ts` (zod for the field), `src/client/App.tsx` (route `/settings/documents`), `src/client/settingsPagesView.ts`
- Test: `test/documents-config.test.ts`, `test/documents-clauses.test.ts`

**Interfaces:**
- Produces (`documents/config.ts`): `DocumentsConfig { legalReviewedAt: string | null; legalReviewer: string; lateFeePercentMonthly: number; expiryDays: number }`, `DocumentsConfigSchema` (zod: `lateFeePercentMonthly` 0–10, `expiryDays` 7–90, `legalReviewedAt` ISO or null, `legalReviewer` ≤ 120 chars and non-empty when `legalReviewedAt` is set), `DEFAULT_DOCUMENTS_CONFIG` (`null`, `""`, `1.5`, `30`), `parseDocumentsConfig(raw: string): DocumentsConfig` (`""`/`"{}"` → defaults), `legalGate(c: DocumentsConfig): string | null` (the reason a real send is refused, or null).
- Produces (`documents/clauses.ts`):
  - `CLAUSE_LIBRARY_VERSION = 1`; `TERMS = { revisionRounds: 2, silenceDays: 14, requoteMonths: 6, pauseDays: 14, killFeePercent: 25, warrantyDays: 30, terminationDays: 30, subscriptionMonths: 24, seoFirstTermMonths: 6 }` (the only place these numbers live).
  - `ClauseId = "scope_exclusions" | "change_orders" | "revisions" | "content_delays" | "payment_terms" | "late_fee" | "work_pause" | "kill_fee" | "ownership" | "warranty" | "termination" | "client_content" | "ai_content" | "accessibility" | "site_credit" | "no_ranking" | "care_terms" | "care_opt_out" | "subscription_term" | "seo_term" | "client_hosted"`.
  - `ClauseCtx { providerName: string; clientName: string; keys: PackageKey[]; careDeclined: boolean; hourlyCents: number; hourlyCareCents: number | null; config: DocumentsConfig }`; `RenderedClause { id: ClauseId; title: string; text: string }`.
  - `clausesFor(ctx: ClauseCtx): RenderedClause[]`: fixed order. Always: every id up to `no_ranking`. Conditional: `care_terms` when `care`, `care_plus` or `care_fallback` is in `keys`; `care_opt_out` only when `careDeclined`; `subscription_term` with `website_subscription`; `seo_term` with `local_seo` or `local_seo_growth`; `client_hosted` with `client_hosted_surcharge`. Text is written fresh (never Webfor wording), plain sentences, no markup, naming the parties by `providerName` / `clientName`. `change_orders` states the hourly rate and the Care-client rate from the context, formatted with `formatPrice`'s dollar helper; `late_fee` states `lateFeePercentMonthly`; `payment_terms` says deposit before work starts, final payment due when the site is finished, not at launch, and points to the schedule table. `ownership` transfers on full payment. `termination` and `warranty` use `TERMS`.

- [ ] **Step 1: Write the failing tests.** `documents-config`: `empty settings parse to the defaults`, `a review date without a reviewer is rejected`, `legalGate refuses until a review is recorded`, `legalGate passes once reviewed`, `expiryDays outside 7-90 is rejected`. `documents-clauses`: `every clause named in spec 11 is present for a build option` (assert the ids list), `care_opt_out appears only when careDeclined`, `subscription_term states 24 months and conversion to Care in month 25`, `seo_term states 6 months`, `numbers come from TERMS` (text contains "2 revision rounds", "14 days", "25%", "30 days"), `the hourly rate in change_orders is the one in the context` (ctx 13000 → "$130", ctx 12500/9500 → "$125" and "$95"), `no other dollar figure appears in any clause text`, `client name with markup stays plain text in the clause` (the function does not escape; the renderer does: assert the raw name is passed through unchanged so Task 5 owns escaping), `care_terms absent when no care key`.
- [ ] **Step 2: Run to verify failure.** Run: `npx vitest run test/documents-config.test.ts test/documents-clauses.test.ts`. Expected: FAIL (modules missing).
- [ ] **Step 3: Implement `config.ts`** and the migration (`settings.documents_config TEXT NOT NULL DEFAULT '{}'`).
- [ ] **Step 4: Implement `clauses.ts`** to the signatures above. Each clause is a function of `ClauseCtx`; keep the texts short and literal. A comment on `CLAUSE_LIBRARY_VERSION` says to bump it on any text change.
- [ ] **Step 5: Settings page.** `Documents.tsx`: the legal-review record (date, reviewer, an unchecked-by-default "reviewed by an Oregon lawyer" confirm), late fee %, expiry days, and a read-only list of every clause with its current text (so the lawyer reads the same text the app uses). Stripe mode shows here later (Task 9).
- [ ] **Step 6: Run all.** Run: `npm test && npm run typecheck`. Expected: PASS.
- [ ] **Step 7: Commit** — `git add -A && git commit -m "feat(close): documents settings and the clause library"`

---

### Task 3: Payment schedule and the proposal builder

**Files:**
- Create: `src/worker/documents/schedule.ts`, `src/worker/documents/proposal.ts`, `src/worker/documents/hash.ts`
- Test: `test/documents-schedule.test.ts`, `test/documents-proposal.test.ts`, `test/documents-hash.test.ts`

**Interfaces:**
- Consumes: `Option`, `OptionItem`, `optionTotals`, `validateOptions` (`sales/options.ts`); `PackageSnapshot`, `Package`, `PackageKey` (`db/packages.ts`); `Deal` (`db/deals.ts`); `clausesFor`, `CLAUSE_LIBRARY_VERSION`, `RenderedClause` (Task 2); `formatPrice` (`client/packagesView.ts`).
- Produces (`schedule.ts`):
  - `Milestone { id: string; label: string; dueOn: "signing" | "design_approved" | "site_finished"; amountCents: number }`
  - `Recurring { key: PackageKey; name: string; monthlyCents: number; startsOn: "signing" | "launch" | "kickoff"; termMonths: number | null; firstMonthPrepaid: boolean }`
  - `PaymentSchedule { milestones: Milestone[]; recurring: Recurring[]; depositCents: number }`
  - `class ScheduleError extends Error`
  - `paymentSchedule(option: Option, snapshot: PackageSnapshot[]): PaymentSchedule`. Rules in the scope decisions. Setup discounts (`OptionItem.setupDiscountCents`) reduce the one-time amount before the percentages split it. Percent splits round down and the remainder goes on the last milestone. `depositCents` = milestones due at `signing` + first months marked prepaid. Throws `ScheduleError` when an item's key is missing from the snapshot (never drops it silently), when the deposit would be 0, or when the milestones plus discounts differ from `optionTotals(option, snapshot).upfrontCents`.
- Produces (`hash.ts`): `canonicalJson(value: unknown): string` (keys sorted at every level, no whitespace); `sha256Hex(text: string): Promise<string>` (WebCrypto).
- Produces (`proposal.ts`):
  - `ProposalContent` (zod `ProposalContentSchema`): `{ header: { reference: string; version: number; preparedOn: string; sentOn: string | null; expiresOn: string | null; clientName: string; contactName: string; contactEmail: string; providerName: string; providerBusiness: string; providerEmail: string }; optionId: "a" | "b" | "c"; packages: { key: PackageKey; version: number; name: string; priceLine: string; includes: string[] }[]; scopeNotes: string; assumptions: string[]; outOfScope: string[]; phases: { name: string; summary: string; milestoneId: string | null }[]; schedule: PaymentSchedule; careDeclined: boolean; clauses: RenderedClause[]; clauseLibraryVersion: number }`. Text caps: `scopeNotes` 4000, each list item 300, 20 items per list.
  - `ProposalEdits { scopeNotes?: string; extraAssumptions?: string[]; extraOutOfScope?: string[]; careDeclined?: boolean }`
  - `class ProposalError extends Error`
  - `buildProposal(i: { deal: Deal; optionId: "a" | "b" | "c"; client: { name: string; contactName: string; contactEmail: string }; settings: { your_name: string; business_name: string; contact_email: string }; packages: (PackageSnapshot & { includes: string[] })[]; catalogHourly: { hourlyCents: number; hourlyCareCents: number | null }; edits: ProposalEdits; config: DocumentsConfig; platform: "wordpress" | "other"; now: Date; version: number }): ProposalContent`. Refuses with `ProposalError`: no `deal.options`; unknown option id; deal stage not in `recommended`, `proposal_sent`, or `discovery_done` with `skipCall`; `validateOptions` problems for that option's platform; a build option (`starter_site`, `growth_site`, `website_subscription`) without any Care key and `careDeclined` false ("Care is on by default"); an empty contact email. Reference is `SL-` + first 6 chars of `deal.id` upper-cased. Default assumptions and out-of-scope lists are fixed text arrays in the file (content supplied by the client, 2 revision rounds, third-party fees excluded, no ranking promise); `phases` come from the package kinds (build: discovery and sitemap, design, build, review, finished; Quick Fix: the fixes, then done; recurring-only: setup, then monthly work). `milestoneId` links a phase to the milestone due when it ends.
  - `freezeProposal(c: ProposalContent, now: Date, expiryDays: number): ProposalContent` sets `sentOn` and `expiresOn` (`now + expiryDays` days, both ISO).

- [ ] **Step 1: Write the failing tests.** `documents-schedule`: `quick fix is 100% at signing`, `starter splits 50/50 and ends when the site is finished` (399700 → 199850/199850), `growth is 40/30/30 and the remainder lands on the last milestone` (699700 → 279880 + 209910 + 209910), `a setup discount lowers the amount before the split`, `subscription bills only the setup at signing and the monthly from launch`, `local seo bills the 75000 setup at signing and monthly from kickoff`, `care alone prepays the first month at signing`, `care with a build starts at launch and is not prepaid`, `an item missing from the snapshot throws`, `milestones plus discounts always equal optionTotals upfront` (loop over every valid option in a fixture set). `documents-hash`: `key order does not change the hash`, `one changed character changes the hash`, `canonicalJson sorts nested keys`. `documents-proposal`: `a build option without care is refused unless careDeclined`, `careDeclined adds the care_opt_out clause`, `an unknown option id is refused`, `a deal without options is refused`, `a deal that is not recommended is refused`, `skipCall deals at discovery_done are allowed`, `prices come from the snapshot, not the catalog` (snapshot Starter 399700 while the passed package list says 499700 → content shows $3,997), `care on an other-platform site is refused`, `freezeProposal sets sentOn and expiresOn 30 days later`, `a 5000-character scopeNotes is rejected`, `the reference is stable across versions`.
- [ ] **Step 2: Run to verify failure.** Run: `npx vitest run test/documents-schedule.test.ts test/documents-hash.test.ts test/documents-proposal.test.ts`. Expected: FAIL.
- [ ] **Step 3: Implement `hash.ts`, `schedule.ts`, `proposal.ts`.** The per-package rules are one table keyed by `PackageKey` in `schedule.ts`; packages not in it are recurring.
- [ ] **Step 4: Run all.** Run: `npm test && npm run typecheck`. Expected: PASS.
- [ ] **Step 5: Commit** — `git add -A && git commit -m "feat(close): payment schedule, proposal builder, content hash"`

---

### Task 4: Documents, signatures and views (storage)

**Files:**
- Create: `migrations/<next>_documents.sql`, `src/worker/db/documents.ts`, `src/worker/documents/token.ts`
- Modify: `src/worker/types.ts` (`ACTIVITY_KINDS` gains `proposal_sent`, `proposal_viewed`, `proposal_signed`, `proposal_void`, `deposit_paid`), `src/worker/today.ts` (`NOT_CONTACT` gains `proposal_viewed`, `proposal_signed`, `proposal_void`, `deposit_paid`; `proposal_sent` is contact and stays out), the lead-delete route in `src/worker/routes/leads.ts`
- Test: `test/documents-db.test.ts`, `test/documents-lead-delete.test.ts`

**Interfaces:**
- Consumes: `ProposalContent` (Task 3), `canonicalJson`, `sha256Hex`.
- Produces (`documents/token.ts`): `newClientToken(): string`, 43 chars (32 random bytes, base64url), the same format and generator as report tokens (reuse theirs if exported).
- Produces (`db/documents.ts`):
  - `DocumentStatus = "draft" | "sent" | "viewed" | "signed" | "void" | "expired"`
  - `Document { id: string; dealId: string; businessId: string; version: number; status: DocumentStatus; test: boolean; optionId: "a" | "b" | "c"; content: ProposalContent; contentSha256: string | null; token: string | null; sentAt: string | null; expiresAt: string | null; firstViewedAt: string | null; signedAt: string | null; paidAt: string | null; voidReason: string | null; pdfKey: string | null; pdfSha256: string | null; pdfError: string | null; approvalId: string | null; createdAt: string; updatedAt: string }`
  - `SignatureRecord { id: string; documentId: string; role: "provider" | "client"; signerName: string; signerEmail: string; signedAt: string; ip: string | null; userAgent: string | null; consentText: string; consentVersion: number; contentSha256: string }`
  - `class DocumentStateError extends Error`
  - `createDraft(db, o: { dealId: string; businessId: string; optionId: "a" | "b" | "c"; content: ProposalContent; test?: boolean }): Promise<Document>` (version = highest for the deal + 1; replaces an existing draft for the deal; throws `DocumentStateError` when the deal already has a `sent`, `viewed` or `signed` document: void it first).
  - `updateDraft(db, id: string, content: ProposalContent): Promise<Document>` (draft only, else `DocumentStateError`).
  - `markSent(db, id: string, o: { token: string; content: ProposalContent; contentSha256: string; sentAt: string; expiresAt: string; approvalId: string | null; provider: Omit<SignatureRecord, "id" | "documentId" | "role"> }): Promise<Document>`: one batch: the draft becomes `sent` with the frozen content, hash and token, and the provider signature row is inserted. A document that is not a draft throws `DocumentStateError`; calling it again on an already-sent document with the same `approvalId` returns it unchanged (a retried approval).
  - `recordView(db, id: string, o: { now: string; userAgent: string | null }): Promise<void>`: inserts a view row at most once per 10 minutes per document; the first view moves `sent` → `viewed` and sets `firstViewedAt`.
  - `signDocument(db, id: string, sig: Omit<SignatureRecord, "id" | "documentId" | "role">, now: string): Promise<"signed" | "already_signed" | "not_open">`: one batch of a conditional insert (only while the document is `sent` or `viewed` and `expiresAt > now` and its `contentSha256` equals `sig.contentSha256`) and the status update. A second call returns `already_signed`. A void, expired or draft document returns `not_open`.
  - `voidDocument(db, id: string, reason: string): Promise<Document>` (draft/sent/viewed → void; a signed document throws), `expireDue(db, now: string): Promise<number>`, `getDocument(db, id)`, `getByToken(db, token)`, `listForDeal(db, dealId): Promise<Document[]>` (newest first), `signaturesFor(db, id): Promise<SignatureRecord[]>`, `setPdf(db, id, o: { key: string; sha256: string } | { error: string })`, `setPaid(db, id, at: string)`, `countViews(db, id): Promise<number>`.
  - Indexes: one open (`draft`/`sent`/`viewed`) document per deal; one signature per (document, role); unique token. `documents.business_id` and `deal_id` have no `ON DELETE CASCADE`.
- `routes/leads.ts` delete: refuses with 409 `{ error: "this lead has signed documents" }` when any document is not a draft; otherwise removes the lead's drafts and views first (follow how deals and bookings are cleaned up).

- [ ] **Step 1: Write the failing tests.** `documents-db`: `createDraft numbers versions per deal`, `createDraft replaces an existing draft`, `createDraft refuses while a sent document is open`, `a sent document cannot be edited`, `markSent freezes content and inserts the provider signature in one step`, `markSent twice with the same approval id returns the same document`, `recordView moves sent to viewed once and rate-limits rows`, `signDocument stores the client signature and moves to signed`, `sign with a stale hash is refused`, `sign after expiry is refused`, `sign on a void document is refused`, `two simultaneous signs leave one signature` (two `Promise.all` calls), `a signed document cannot be voided`, `expireDue expires only sent and viewed documents past expiresAt`, `only one open document per deal`. `documents-lead-delete`: `a lead with a signed document cannot be deleted`, `a lead with only drafts is deleted with them`. A small test pins that the new `deal_*`-style kinds sit in `NOT_CONTACT` as listed.
- [ ] **Step 2: Run to verify failure.** Run: `npx vitest run test/documents-db.test.ts test/documents-lead-delete.test.ts`. Expected: FAIL.
- [ ] **Step 3: Migration and `db/documents.ts`.** Tables `documents` (JSON `content`, `test` 0/1, `UNIQUE(token)`, partial unique index on `deal_id WHERE status IN ('draft','sent','viewed')`, `UNIQUE(deal_id, version)`), `document_signatures` (`UNIQUE(document_id, role)`), `document_views`. Statuses and roles under `CHECK`. The sign insert is `INSERT … SELECT … WHERE EXISTS (…open, unexpired, same hash…)`, followed in the same `db.batch` by the status update guarded by the existence of that signature row.
- [ ] **Step 4: Implement `token.ts`, extend `ACTIVITY_KINDS` and `NOT_CONTACT`, change the lead-delete route.**
- [ ] **Step 5: Run all.** Run: `npm test && npm run typecheck`. Expected: PASS.
- [ ] **Step 6: Commit** — `git add -A && git commit -m "feat(close): documents, signatures and views storage"`

---

### Task 5: Rendering the proposal, the audit page and the letter PDF

**Files:**
- Create: `src/worker/documents/render.ts`, `src/worker/documents/consent.ts`
- Modify: `src/worker/render/render.ts` (`htmlToPdf` gains an optional options argument), `src/worker/routes/deck.ts` (export a generic `safeFileName` that `deckFileName` calls, so deck tests stay green)
- Test: `test/documents-render.test.ts`, `test/documents-consent.test.ts`, extend `test/render.test.ts` and the deck filename tests

**Interfaces:**
- Produces (`consent.ts`): `ESIGN_VERSION = 1`; `ESIGN_DISCLOSURE: string` (plain text, paragraphs separated by blank lines) covering the five ESIGN topics: consent to use electronic records and signatures; the right to a paper copy on request by email; how to withdraw consent (close the page before signing); what is needed (a current web browser and an email address); that typing the name is intended as a signature. `CONSENT_LABEL: string` (the checkbox text) and `AUTHORITY_LABEL: string` ("I am authorized to sign for <business>" uses `authorityLabel(clientName: string): string`).
- Produces (`render.ts`):
  - `renderProposalHtml(c: ProposalContent, o: { mode: "screen" | "pdf"; status: DocumentStatus; contentSha256: string | null; signatures: SignatureRecord[]; auditPage: boolean; draftBanner: boolean }): string`: one self-contained HTML document (inline CSS, no scripts, no network). Sections in order: header block (reference, version, dates, parties), packages and prices, scope notes, assumptions, out of scope, phases with the payment schedule table (milestones, recurring lines, deposit), the clauses (numbered), the signature block (typed names and dates once signed; "awaiting signature" otherwise), and, when `auditPage`, a final page break plus the audit page (each signature: role, name, email, time, IP, user agent, consent version and text, the document hash, "Signed electronically under the US ESIGN Act"). `draftBanner` adds a "DRAFT — clauses pending legal review" band (shown when the library is not marked reviewed and in every preview).
  - Every dynamic string goes through one `esc()`; the user agent is truncated to 200 chars in the audit page.
  - `PROPOSAL_CSP` string: `default-src 'none'; style-src 'unsafe-inline'; img-src data:; frame-ancestors 'self'`.
- `htmlToPdf(binding: Fetcher, html: string, o?: { format?: "slide" | "letter" }): Promise<Uint8Array>`: `"letter"` prints portrait Letter with 0.75 in margins; default stays the deck's 1280×720.

- [ ] **Step 1: Write the failing tests.** `documents-render`: `escapes markup in every dynamic field` (client name, contact name, scope notes, an assumption, a signer name and user agent all `<script>alert(1)</script>`), `shows the reference, version, expiry and every clause title`, `prices appear exactly as the content's priceLine and schedule amounts`, `an unsigned document says awaiting signature`, `a signed document shows both typed names and the hash`, `the audit page is present only when auditPage is true and lists both signatures`, `the user agent is truncated to 200 characters`, `no script tag and no external URL in the output`, `draftBanner renders the banner`. `documents-consent`: `the disclosure covers consent, paper copy, withdrawal, requirements and signature intent` (one assertion per topic keyword). `render`: `htmlToPdf letter passes portrait letter options and slide keeps the deck size` (fake puppeteer as the existing test does). Deck: `deckFileName output is unchanged`.
- [ ] **Step 2: Run to verify failure.** Run: `npx vitest run test/documents-render.test.ts test/documents-consent.test.ts test/render.test.ts`. Expected: FAIL.
- [ ] **Step 3: Implement `consent.ts`, `render.ts`, the `htmlToPdf` option, and the `safeFileName` extraction.**
- [ ] **Step 4: Run all.** Run: `npm test && npm run typecheck`. Expected: PASS.
- [ ] **Step 5: Commit** — `git add -A && git commit -m "feat(close): proposal and audit-page rendering, letter pdf"`

---

### Task 6: Owner API, the send approval and the Deal page tab

**Files:**
- Create: `src/worker/routes/documents.ts`, `src/worker/approvals/proposalSend.ts`, `src/worker/documents/mail.ts`, `src/worker/documents/service.ts`, `src/client/proposalView.ts`, `src/client/pages/ProposalTab.tsx`
- Modify: `src/worker/index.ts` (mount `/api`; register the approval handler where `videoPublish` is imported), `src/worker/env.ts` (`CLIENT_LINK_BASE?: string`), `src/worker/routes/deals.ts` (move route refuses `proposal_sent` and `won`), `src/client/pages/Deal.tsx` (a Proposal tab)
- Test: `test/documents-service.test.ts`, `test/documents-routes.test.ts`, `test/proposal-send-approval.test.ts`, `test/documents-mail.test.ts`, `test/proposal-view.test.ts`

**Interfaces:**
- Consumes: Tasks 2–5; `checkConflict`, `mainMailboxProblem`, `sendEmail`, `lastBookingFor`, `getSettings`, `getDeal`, `moveDeal`, `logActivity`, `createApproval`, `registerHandler`, `getPackage`, `listCurrentPackages`.
- Produces (`documents/service.ts`):
  - `draftProposal(env: Env, dealId: string, o: { optionId: "a" | "b" | "c"; edits: ProposalEdits; contact?: { name: string; email: string }; test?: boolean }, now?: Date): Promise<Document>`: loads the deal, business, discovery booking (default contact name and email; an explicit `contact` wins), the snapshot packages with `includes` from `getPackage(db, key, version)`, the hourly rates, settings, config and the platform from the latest audit (`"wordpress"` or `"other"`), calls `buildProposal`, then `createDraft` or `updateDraft`. `ProposalError` and `DocumentStateError` surface as 409/422 in the route.
  - `sendProblems(env: Env, doc: Document): Promise<string[]>`: why a real send is refused: legal gate (skipped for `doc.test`), main mailbox problem, conflict gate on the contact email and lead, document not a draft, deal not in an allowed stage, a snapshot entry's price differing from `getPackage(key, version)` (data corruption check).
- Produces (`documents/mail.ts`): `renderProposalMail(c: ProposalContent, link: string, s: Settings): { subject: string; body: string }`: fixed plain-text template: greets the contact by first name, one sentence naming the business, the link, the expiry date, "open it, read it, type your name to sign", then the deposit amount and that the payment step follows signing, signed with the settings signature name. No Claude text, no price other than the deposit from the schedule. `clientLink(base: string | undefined, token: string): string | null` (null when the base is not https).
- Produces (`approvals/proposalSend.ts`): kind `proposal.send`, label "Send proposal", payload `{ documentId: string }`. `createSendApproval(env, doc): Promise<Approval>` (title `Send the proposal to <business>`, preview = the mail body + the schedule lines + "countersigned as <your_name>"; one pending approval per document). `execute`: re-runs `sendProblems` (throws the first problem), mints the token with `newClientToken`, `freezeProposal`, hashes the canonical frozen content, `markSent` (provider signature: `your_name`, `contact_email`, consent text `"Approved for sending"`), mails the link from the `main` mailbox with the approval id as the idempotency key (`sendEmail(env, …, { approvalId: a.id, skipLimits: true })`, so a retried approval cannot send twice), moves the deal to `proposal_sent` (skipping stages is allowed), writes `proposal_sent` activity. Idempotent on retry: a document already sent with this approval id only repeats the mail step.
- Routes (`routes/documents.ts`, authenticated): `GET /api/deals/:id/proposal` → `{ current: Document | null; history: Document[]; legalGate: string | null; clientBase: string | null }`; `POST /api/deals/:id/proposal` `{ optionId, edits, contact?, test? }` → the draft; `PUT /api/documents/:id` `{ edits }` (draft only); `GET /api/documents/:id/preview.html` (CSP header, `draftBanner` on); `POST /api/documents/:id/send` → creates the approval, returns `{ approvalId, problems }`; `POST /api/documents/:id/test-send` (sends the link to `settings.contact_email` only, marks the document `test`, no approval, no deal move, refused for a non-draft); `POST /api/documents/:id/void` `{ reason }` (reason required, ≤ 300 chars; writes `proposal_void`). `POST /api/deals/:id/move` returns 409 for `proposal_sent` and `won` (those moves belong to the proposal and the payment).
- Produces (`proposalView.ts`): `proposalSteps(doc: Pick<Document, "status" | "sentAt" | "firstViewedAt" | "signedAt" | "paidAt" | "voidReason" | "expiresAt">): { label: string; at: string | null; done: boolean }[]` (Drafted, Sent, Viewed, Signed, Deposit paid; void and expired replace the tail with one line), `sendBlockers(g: { legalGate: string | null; clientBase: string | null; doc: Document }): string[]`.

- [ ] **Step 1: Write the failing tests.** `documents-service`: `draftProposal defaults the contact from the discovery booking`, `an explicit contact wins`, `a deal with no snapshot item for an option key is refused`, `editing after a send is refused until the sent version is voided`, `a catalog price change after recap does not change the draft`. `proposal-send-approval`: `execute refuses before the legal review is recorded`, `execute refuses when the main mailbox is not set up`, `execute refuses a do-not-contact contact`, `execute refuses a lead that is already won`, `execute freezes content, stores the hash, signs as provider, mails the link, and moves the deal to proposal_sent`, `a retried approval does not mail twice`, `a deal marked lost after the draft refuses to send`, `a test document is never sent through the approval`. `documents-mail`: `the mail contains the link, the expiry date and the deposit amount and nothing else priced`, `a contact name with markup stays plain text in the body`, `clientLink is null for a non-https base`. `documents-routes`: `test-send mails only the owner's address and leaves the deal alone`, `move to proposal_sent is a 409`, `move to won is a 409`, `void requires a reason`, `preview carries the CSP and the draft banner`, `a second draft request replaces the draft`. `proposal-view`: `proposalSteps shows void in place of the later steps`, `sendBlockers lists the legal gate and a missing client base`.
- [ ] **Step 2: Run to verify failure.** Run: `npx vitest run test/documents-service.test.ts test/proposal-send-approval.test.ts test/documents-mail.test.ts test/documents-routes.test.ts test/proposal-view.test.ts`. Expected: FAIL.
- [ ] **Step 3: Implement the service, mail, approval handler and routes.**
- [ ] **Step 4: Deal page tab.** `ProposalTab.tsx`: option picker (recommended preselected), scope notes, extra assumptions and out-of-scope lists, the "client declined Care" toggle with its explanation, contact name and email, an iframe of the preview, buttons "Save draft", "Send a test to me", "Send for approval" (disabled with the blockers listed), then the status steps, the client link (copy button) once sent, "Void and start a new version" and the history list. Keep state lifted to the Deal page as Plan 4's notes form does.
- [ ] **Step 5: Run all.** Run: `npm test && npm run typecheck`. Expected: PASS.
- [ ] **Step 6: Commit** — `git add -A && git commit -m "feat(close): proposal drafting, send approval and the deal tab"`

---

### Task 7: The client page and click-to-sign

**Files:**
- Create: `src/worker/documents/public.ts`, `src/client/pages/Proposal.tsx`, `src/client/proposalPageView.ts`
- Modify: `src/worker/routes/public.ts` (three routes), `src/worker/env.ts` (`CLIENT_LIMITER?: RateLimit`), `wrangler.jsonc` (`ratelimits` gains `CLIENT_LIMITER`, `namespace_id` 1003, 30 per 60), `src/client/App.tsx` (route `/p/*`, public like `/r/*`)
- Test: `test/documents-public.test.ts`, `test/documents-public-routes.test.ts`, `test/proposal-page-view.test.ts`

**Interfaces:**
- Consumes: `getByToken`, `recordView`, `signDocument`, `signaturesFor`, `renderProposalHtml`, `ESIGN_DISCLOSURE`, `CONSENT_LABEL`, `authorityLabel`, `ESIGN_VERSION`.
- Produces (`documents/public.ts`):
  - `PublicProposal { state: "open" | "signed" | "closed"; html: string; contentSha256: string; expiresAt: string | null; clientName: string; disclosure: string; consentLabel: string; authorityLabel: string; signed: { name: string; at: string } | null; payment: PublicPayment }` and `PublicPayment = { state: "none" } | { state: "open"; amountCents: number; url: string } | { state: "paid"; amountCents: number } | { state: "unavailable" }` (Task 10 fills it; this task returns `none`). A `closed` page (void or expired) carries only `state` and `clientName`.
  - `proposalPage(env: Env, token: string, o: { now: Date; userAgent: string | null }): Promise<PublicProposal | null>` (null for a malformed or unknown token, a draft, or a test document whose deal is gone; records the view; a signed document stays viewable).
  - `SignFormSchema` (zod): `{ name: string (trimmed, 2–120 chars, no control or bidi-override characters, at least one letter); consent: true; authority: true; sha256: string (64 hex) }`.
  - `signProposal(env: Env, token: string, form: SignForm, o: { now: Date; ip: string | null; userAgent: string | null }): Promise<{ ok: true; page: PublicProposal } | { ok: false; status: 400 | 404 | 409; error: string }>`: unknown token 404; stale hash 409 "this proposal changed, reload"; closed 409; second sign by the same document returns `ok: true` with the existing signature (no new row); stores IP (`CF-Connecting-IP`), user agent capped at 300, the consent text actually shown (`ESIGN_DISCLOSURE` + both labels) and `ESIGN_VERSION`; writes `proposal_signed` activity; then calls `afterSign` (Tasks 8 and 10 hook in here; this task leaves it a no-op function `afterSign(env, doc): Promise<void>` in `documents/public.ts` that never throws).
- Routes (all under `/api/public`, same headers as the report routes, `CLIENT_LIMITER` keyed by token + client IP, 429 when exceeded; the limiter is optional like the others): `GET /p/:token` → `PublicProposal`; `POST /p/:token/sign` (body capped at 4 KB with `readCapped`) → `PublicProposal`.
- Produces (`proposalPageView.ts`): `signReady(f: { name: string; consent: boolean; authority: boolean }): string | null` (the reason the button is disabled), `formatExpiry(iso: string, now: Date): string` ("expires in 12 days" / "expires today" / "expired").

- [ ] **Step 1: Write the failing tests.** `documents-public`: `unknown, malformed and draft tokens are a 404; void and expired tokens show the closed page with no content`, `viewing records one view and moves sent to viewed`, `a signed document stays viewable and says who signed`, `sign stores name, ip, user agent, consent text and the hash`, `sign with a stale hash is refused`, `sign with consent false or authority false is a 400`, `a name with a bidi override or control character is a 400`, `a 5000-character name is a 400`, `a second sign returns the first signature and adds no row`, `two simultaneous signs leave one signature`, `sign after expiry is a 409`, `the user agent is capped at 300 characters`, `the page html escapes a business name with markup`. `documents-public-routes`: `GET and POST carry no-store, noindex and no-referrer`, `the limiter returns 429`, `an oversized body is a 413`, `a worker-only token path never reaches the database when the token is not 43 characters`. `proposal-page-view`: `signReady lists the first missing thing`, `formatExpiry boundaries`.
- [ ] **Step 2: Run to verify failure.** Run: `npx vitest run test/documents-public.test.ts test/documents-public-routes.test.ts test/proposal-page-view.test.ts`. Expected: FAIL.
- [ ] **Step 3: Implement `public.ts`, the routes, and the limiter binding.**
- [ ] **Step 4: The page.** `Proposal.tsx` (no app chrome, mobile-first): the proposal HTML in a sandboxed iframe (`srcDoc`, `sandbox=""`), the expiry line, the disclosure text above the two checkboxes, a name field, the Sign button; after signing, the signed state with a Download PDF link (Task 8) and the payment block (Task 10). A closed page says the link is no longer open and to contact the sender, using `settings` contact data returned in the payload.
- [ ] **Step 5: Run all.** Run: `npm test && npm run typecheck`. Expected: PASS.
- [ ] **Step 6: Commit** — `git add -A && git commit -m "feat(close): client proposal page and click-to-sign"`

---

### Task 8: Signed PDF and the signed copy

**Files:**
- Create: `src/worker/documents/signed.ts`
- Modify: `src/worker/documents/public.ts` (`afterSign`, a `GET /p/:token/pdf` route in `routes/public.ts`), `src/worker/routes/documents.ts` (`GET /api/documents/:id/pdf`)
- Test: `test/documents-signed.test.ts`

**Interfaces:**
- Consumes: `renderProposalHtml` (with `auditPage: true`), `htmlToPdf(…, { format: "letter" })`, `setPdf`, `safeFileName`, `sendEmail`, `checkConflict`.
- Produces (`signed.ts`):
  - `ensureSignedPdf(env: Env, docId: string, deps?: { pdf?: typeof htmlToPdf }): Promise<{ ok: true; key: string; sha256: string } | { ok: false; status: 404 | 409 | 501 | 502; error: string }>`: only for a `signed` document (409 otherwise); 501 without the `BROWSER` binding; renders, stores in R2 at `documents/<docId>/signed.pdf`, records `pdfKey`/`pdfSha256`; failure records `pdfError` and returns 502; idempotent (an existing `pdfKey` returns without rendering).
  - `signedFileName(clientName: string, now: Date, o?: { ascii?: boolean }): string` ("<Business> - Proposal - <YYYY-MM-DD>.pdf", via `safeFileName`).
  - `sendSignedCopy(env: Env, doc: Document): Promise<void>`: fixed-template mail from `main` to the signer's email with the client link (the link serves the PDF), and a short notice to `settings.contact_email`. Never throws: a failure (no mailbox, do-not-contact address, SMTP error) is logged to the lead's timeline as a `note` and the Worker log; the signature stands.
- `afterSign` (in `public.ts`) now calls, in order and each guarded: `ensureSignedPdf`, `sendSignedCopy`. A PDF failure never fails the signature.
- Routes: `GET /api/public/p/:token/pdf` streams the PDF for a signed document (404 for any other state; `ensureSignedPdf` first when `pdfKey` is missing; `Content-Disposition` with `signedFileName`, `no-store`); `GET /api/documents/:id/pdf` is the owner's copy.

- [ ] **Step 1: Write the failing tests.** `ensureSignedPdf renders once and stores key and sha256` (fake pdf returns fixed bytes, assert R2 object and the hash), `a second call does not render again`, `an unsigned document is refused with 409`, `no BROWSER binding is a 501 and records nothing`, `a render failure records pdfError and the signature remains`, `the html handed to the renderer has the audit page and both signatures`, `sendSignedCopy mails the signer from main and notifies the owner`, `sendSignedCopy swallows a do-not-contact address and logs a note`, `the file name keeps letters of any script in filename* and folds the ascii one`, `the public pdf route is a 404 before signing and streams after`.
- [ ] **Step 2: Run to verify failure.** Run: `npx vitest run test/documents-signed.test.ts`. Expected: FAIL.
- [ ] **Step 3: Implement `signed.ts`, wire `afterSign`, add the two routes.**
- [ ] **Step 4: Run all.** Run: `npm test && npm run typecheck`. Expected: PASS.
- [ ] **Step 5: Commit** — `git add -A && git commit -m "feat(close): signed pdf with audit page and signed copy"`

---

### Task 9: Stripe client, webhook and billing records

**Files:**
- Create: `migrations/<next>_billing.sql`, `src/worker/stripe/client.ts`, `src/worker/stripe/webhook.ts`, `src/worker/db/invoices.ts`, `src/worker/routes/stripeWebhook.ts`
- Modify: `src/worker/env.ts` (`STRIPE_SECRET_KEY?`, `STRIPE_WEBHOOK_SECRET?`), `src/worker/index.ts` (mount `/hooks/stripe` before `app.use("/api/*", requireAuth)`), `wrangler.jsonc` (`run_worker_first` gains `"/hooks/*"`), `src/client/pages/settings/Documents.tsx` (shows Stripe mode and whether the webhook secret is set; values never shown)
- Test: `test/stripe-client.test.ts`, `test/stripe-webhook.test.ts`, `test/invoices-db.test.ts`

**Interfaces:**
- Produces (`stripe/client.ts`):
  - `stripeMode(key: string | undefined): "test" | "live" | null` (`sk_test_`/`rk_test_` → test, `sk_live_`/`rk_live_` → live, else null).
  - `encodeForm(o: Record<string, unknown>): string` (Stripe's bracket encoding: `payment_settings[payment_method_types][0]=card`, `metadata[document_id]=…`; arrays by index; skips `undefined`).
  - `class StripeError extends Error` (message is Stripe's `error.message` capped at 200 chars; never contains the key).
  - `createCustomer(f: Fetch, key: string, o: { name: string; email: string; businessId: string }, idempotencyKey: string): Promise<{ id: string }>`
  - `createDepositInvoice(f: Fetch, key: string, o: { customerId: string; amountCents: number; description: string; documentId: string; dealId: string; businessId: string }, idempotencyKey: string): Promise<{ invoiceId: string; hostedUrl: string; status: string }>`: in order, `POST /v1/invoices` (`collection_method=send_invoice`, `days_until_due=7`, `auto_advance=false`, `payment_settings[payment_method_types]` card and us_bank_account, metadata `document_id`, `deal_id`, `business_id`, `kind=deposit`), `POST /v1/invoiceitems` with `invoice=<id>` (amount, `currency=usd`, description), `POST /v1/invoices/<id>/finalize`. Each call carries `Idempotency-Key: <key>:<step>`. Reads `hosted_invoice_url` from the finalize response.
  - `retrieveInvoice(f: Fetch, key: string, invoiceId: string): Promise<{ id: string; status: string; amountDue: number; amountPaid: number; currency: string; hostedUrl: string | null }>`.
- Produces (`stripe/webhook.ts`):
  - `verifyStripeSignature(rawBody: string, header: string | null, secret: string, nowSec: number, toleranceSec?: number): Promise<boolean>`: parses `t=` and every `v1=`, HMAC-SHA256 over `${t}.${rawBody}` with WebCrypto, constant-time compare, tolerance 300 s, false for a missing or malformed header.
  - `handleStripeEvent(env: Env, event: StripeEvent, deps?: { onPaid?: (env: Env, inv: InvoiceRow) => Promise<void> }): Promise<"applied" | "duplicate" | "ignored" | "mismatch">`: inserts the event id into `stripe_events` first (`INSERT OR IGNORE`; a repeat returns `duplicate`); handles `invoice.paid`, `invoice.voided`, `invoice.marked_uncollectible`, `invoice.payment_failed`; finds our row by `stripe_invoice_id` (unknown → `ignored`); for `invoice.paid` requires `amount_paid` equal to the row's `amountCents`, `currency` `usd` and `metadata.document_id` equal to the row's document, otherwise records `mismatch` on the row and returns `mismatch` without calling `onPaid`.
- Route (`routes/stripeWebhook.ts`, **unauthenticated**): `POST /hooks/stripe` reads the raw body (capped at 1 MB), requires `STRIPE_WEBHOOK_SECRET` (503 if unset), verifies the signature (400 on failure, with no detail), parses, calls `handleStripeEvent`, answers 200 for `applied`, `duplicate`, `ignored` and `mismatch` (so Stripe stops retrying), 500 only when our own write fails (so Stripe retries).
- Produces (`db/invoices.ts`): `InvoiceRow { id: string; businessId: string; dealId: string; documentId: string; kind: "deposit"; stripeCustomerId: string; stripeInvoiceId: string; amountCents: number; status: "open" | "paid" | "void" | "uncollectible" | "failed"; hostedUrl: string; mismatch: string | null; createdAt: string; paidAt: string | null }`, `getInvoiceForDocument(db, documentId)`, `getInvoiceByStripeId(db, stripeInvoiceId)`, `insertInvoice(db, row: Omit<InvoiceRow, "id" | "createdAt" | "paidAt" | "mismatch" | "status">)` (one deposit invoice per document: unique index), `markInvoice(db, id, patch)`, `getStripeCustomer(db, businessId)`, `saveStripeCustomer(db, businessId, stripeCustomerId)`, `recordEvent(db, eventId, type): Promise<boolean>` (false on repeat). Tables: `stripe_customers(business_id PK, stripe_customer_id, created_at)`, `invoices`, `stripe_events(id PK, type, received_at)`.

- [ ] **Step 1: Write the failing tests** with a fake `Fetch` and a signing helper. `stripe-client`: `stripeMode reads the key prefix`, `encodeForm nests metadata and arrays`, `createDepositInvoice calls invoices, then invoiceitems with the invoice id, then finalize`, `each call carries a distinct idempotency key derived from the base key`, `the invoice asks for card and us_bank_account`, `a Stripe error message is capped and never contains the key`, `createDepositInvoice returns the hosted url`. `stripe-webhook`: `a valid signature passes`, `a wrong secret fails`, `a tampered body fails`, `a timestamp older than 5 minutes fails`, `a header with two v1 values passes when one matches`, `a missing header fails`, `invoice.paid with the right amount marks the invoice paid and calls onPaid once`, `a replayed event id is a duplicate and calls nothing`, `a different amount is a mismatch and does not call onPaid`, `a different currency is a mismatch`, `metadata for another document is a mismatch`, `an unknown invoice id is ignored`, `invoice.voided marks the row void`. Route: `no secret configured is a 503`, `bad signature is a 400 with an empty body`, `the route works without a session cookie`. `invoices-db`: `one deposit invoice per document`, `recordEvent is false on a repeat`.
- [ ] **Step 2: Run to verify failure.** Run: `npx vitest run test/stripe-client.test.ts test/stripe-webhook.test.ts test/invoices-db.test.ts`. Expected: FAIL.
- [ ] **Step 3: Migration, `db/invoices.ts`, `stripe/client.ts`, `stripe/webhook.ts`, the route and the mount** (before `requireAuth`, like `/helper`).
- [ ] **Step 4: Settings display.** `GET /api/documents/config` returns `{ stripeMode, webhookConfigured, clientBase }` (booleans and the mode only); the Documents settings page shows them as "Stripe: test mode · webhook secret set · client links on https://…".
- [ ] **Step 5: Run all.** Run: `npm test && npm run typecheck`. Expected: PASS.
- [ ] **Step 6: Commit** — `git add -A && git commit -m "feat(close): stripe client, webhook and billing records"`

---

### Task 10: Deposit on signing, the pay block, and Won

**Files:**
- Create: `src/worker/documents/deposit.ts`
- Modify: `src/worker/documents/public.ts` (`afterSign` creates the invoice; `PublicPayment` filled in; `POST /p/:token/pay` in `routes/public.ts`), `src/worker/stripe/webhook.ts` (production `onPaid`), `src/client/pages/Proposal.tsx` (pay block), `src/client/pages/ProposalTab.tsx` (invoice line)
- Test: `test/documents-deposit.test.ts`, `test/documents-paid.test.ts`

**Interfaces:**
- Consumes: Task 9, `getBusiness`, `moveDeal`, `stopOutreach`, `logActivity`, the lead status writer already used by the leads route (find it; do not add a second one).
- Produces (`deposit.ts`):
  - `ensureDepositInvoice(env: Env, docId: string, deps?: { fetch?: Fetch }): Promise<PublicPayment>`: idempotent. A signed document only. Returns the existing row's state if one exists (re-checking Stripe with `retrieveInvoice` when the row is `open`, so a webhook that never arrived still resolves). Otherwise: `STRIPE_SECRET_KEY` unset → `unavailable`; a `test` document with a live key → `unavailable` (a test document never creates a live charge); reuse or create the Stripe customer (`saveStripeCustomer`), create the invoice for `content.schedule.depositCents` with the description `<Business> — deposit (<reference> v<version>)`, `insertInvoice`. Any Stripe failure writes a `note` activity "deposit invoice not created: <capped reason>" and returns `unavailable`; it never throws and never leaves a half row.
  - `onInvoicePaid(env: Env, inv: InvoiceRow): Promise<void>` (the production `onPaid`): `setPaid` on the document, `proposal` activity `deposit_paid`. For a non-test document whose deal is `proposal_sent`: `moveDeal(…, "won")`, set the lead to `won`, `stopOutreach({ reason: "manual" })`. A deal that is no longer `proposal_sent` (lost, or already won) is left alone and gets a `note`: "deposit paid but the deal is <stage>: check it". A test document marks paid and does nothing else.
- Routes: `POST /api/public/p/:token/pay` → `PublicPayment` (signed documents only, else 404; rate-limited like the others; this is the retry when the first attempt was `unavailable`).
- `PublicProposal.payment` is now `open` with the hosted URL while unpaid, `paid` once the row is paid, `unavailable` after a failed attempt (the page shows "We couldn't open the payment page. Try again." and a button that calls the route), and `none` before signing.
- Pay block (`Proposal.tsx`): amount, "Pay deposit" opening the hosted page in a new tab, a plain note that ACH can take a few days to clear, and the paid state.

- [ ] **Step 1: Write the failing tests** (fake Stripe fetch). `documents-deposit`: `signing creates exactly one deposit invoice for the schedule's depositCents`, `a retried afterSign does not create a second invoice or a second customer`, `an unavailable Stripe leaves the signature and reports unavailable`, `the failure note holds no key and is capped`, `a test document with a live key is unavailable`, `a second pay request reuses the open invoice`, `an open invoice that Stripe reports paid is marked paid on the next request`, `the deposit amount is the schedule's, including a prepaid first month`. `documents-paid`: `invoice.paid on a proposal_sent deal moves it to won, sets the lead won and stops outreach`, `a test document marks paid and leaves the deal`, `a deal already lost gets a note and is not reopened`, `a duplicate webhook delivery moves the deal once`, `a paid event for a document of another deal is a mismatch and moves nothing`, `after won the lead is blocked by the conflict gate as an existing client`.
- [ ] **Step 2: Run to verify failure.** Run: `npx vitest run test/documents-deposit.test.ts test/documents-paid.test.ts`. Expected: FAIL.
- [ ] **Step 3: Implement `deposit.ts`, wire `afterSign` (after the PDF and signed copy) and the pay route, and set the webhook's production `onPaid`.**
- [ ] **Step 4: Pay block and the Deal tab's invoice line** ("Deposit $X: open / paid / not created, retry").
- [ ] **Step 5: Run all.** Run: `npm test && npm run typecheck`. Expected: PASS.
- [ ] **Step 6: Commit** — `git add -A && git commit -m "feat(close): deposit invoice on signing, payment moves the deal to won"`

---

### Task 11: Expiry sweep, Today follow-up and the deal timeline

**Files:**
- Modify: `src/worker/schedule.ts` (the daily branch calls `expireDue`), `src/worker/today.ts` (one new item kind), `src/client/pages/Deal.tsx` and `src/client/pages/ProposalTab.tsx` (timeline lines), `src/client/todayView.ts` if it lists kinds
- Test: `test/documents-expiry.test.ts`, extend `test/today.test.ts`

**Interfaces:**
- Consumes: `expireDue`, `listForDeal`, the existing Today item builder in `today.ts` (follow how Plan 4 added the booking items).
- Produces: in the daily run, `expireDue(db, now)` writes one `proposal_void` activity (`"expired"`) per document it expires. Today gains kind `proposal_follow_up`: a deal at `proposal_sent` whose open document was sent 3 or more days ago and is unsigned. Reason line: "Proposal sent <n> days ago, not opened" or "…opened, not signed"; priority between the booking items and routine drafts; it clears when the document is signed, voided or expired, and the existing "done"/"snooze" actions work on it like on other kinds.

- [ ] **Step 1: Write the failing tests.** `documents-expiry`: `the daily run expires a sent document past its expiry and logs it once`, `a document expiring exactly now is still open and one a millisecond later is expired`, `a signed document is never expired`, `running the sweep twice logs once`. `today`: `a proposal sent 3 days ago and unsigned appears`, `one sent 2 days ago does not`, `a signed one does not`, `a lost deal's proposal does not`, `the reason says opened or not opened`.
- [ ] **Step 2: Run to verify failure.** Run: `npx vitest run test/documents-expiry.test.ts test/today.test.ts`. Expected: FAIL.
- [ ] **Step 3: Implement the sweep call and the Today item.**
- [ ] **Step 4: Deal tab timeline** shows Drafted / Sent / Viewed (with the view count) / Signed / Deposit paid with times, using `proposalSteps`.
- [ ] **Step 5: Run all.** Run: `npm test && npm run typecheck`. Expected: PASS.
- [ ] **Step 6: Commit** — `git add -A && git commit -m "feat(close): proposal expiry, Today follow-up and the deal timeline"`

---

### Task 12: Ship

**Files:**
- Modify: `README.md` (close section), `.superpowers/sdd/2026-11-19-agency-os-5-close/progress.md`
- Create: `docs/superpowers/notes/2026-11-plan-5-open-items.md`
- Test: `test/close-flow.test.ts` (one end-to-end test with fakes)

- [ ] **Step 1: The flow test.** `test/close-flow.test.ts`: `a recommended deal goes from draft to won`: seed a deal at `recommended` with options and snapshot, legal review recorded, main mailbox fake; `draftProposal` → `createSendApproval` → `approve` → fetch `proposalPage` by token (viewed) → `signProposal` → fake Stripe creates the invoice → deliver a signed `invoice.paid` through `handleStripeEvent` → assert the deal is `won`, the lead is `won`, two signatures exist with the same hash, the PDF is stored, the mail log shows the proposal link and the signed copy, and the document's content hash equals the hash of its stored content. A second test: `a deal marked lost after sending is not reopened by a late payment`.
- [ ] **Step 2: Full verification.** Run: `npm test && npm run typecheck && npm run build`. Expected: all pass.
- [ ] **Step 3: Whole-branch review.** Run `/code-review high` against `main`; fix every finding, re-run Step 2. Run `/security-review` too: this plan adds a public signing surface and a public webhook.
- [ ] **Step 4: Write the open-items note**: Logan-run checks below, known gaps found in review, deferred minors, and every judgment call made during the build.
- [ ] **Step 5: README** gets the proposal flow, the new env vars and secrets, the webhook URL, the client host, and the new limiter binding.
- [ ] **Step 6: Commit** — `git add -A && git commit -m "docs: Plan 5 open items and README"`. Do not push, deploy or apply remote migrations; give Logan the list below.

**Logan-run checks (record results in the open-items note; none can run in tests):**
1. Apply the new remote migrations in order, then deploy (migrations first). The deploy creates the `CLIENT_LIMITER` binding (namespace 1003).
2. Stripe account in **test mode**: set secrets `STRIPE_SECRET_KEY` (restricted key with invoices, invoice items, customers write is enough) and `STRIPE_WEBHOOK_SECRET`; add a webhook endpoint `https://<app host>/hooks/stripe` listening to `invoice.paid`, `invoice.voided`, `invoice.marked_uncollectible`, `invoice.payment_failed`. Turn on ACH (US bank account) in Stripe's payment-method settings and add logo and colors under Branding. Check what Stripe Invoicing charges per paid invoice (spec §13) and note it.
3. Set `CLIENT_LINK_BASE` (https://clients.sitelineweb.com) and attach that hostname to the Worker as a custom domain; open `/p/<anything>` there and confirm a 404 page, not an error.
4. Settings → Documents: read every clause. **Send them to an Oregon lawyer** (also ask about auto-renewal rules for the 24-month Subscription, sales-tax treatment, the late fee and the kill fee) and only then record the review. Until then real sends are refused.
5. On a test lead with a recap: draft the proposal for each of the three options, read the preview, "Send a test to me", open the link on a phone (Safari) and a desktop, sign, check the signed copy mail, the PDF (page breaks, the audit page with both signatures and the hash) and that the Pay button opens Stripe's hosted invoice.
6. Pay the deposit with Stripe's test card, then again on a second test lead with the test US bank account; confirm the deal moves to Won and the lead turns blocked in the conflict gate. Replay the webhook from the Stripe dashboard and confirm nothing changes.
7. Edit a package price after a recap and confirm the new proposal still shows the frozen price. Let a test proposal pass its expiry (set `expiryDays` to 7 and backdate in the dashboard console) and confirm the link shows the closed page.
8. Decide: the deposit rules in `documents/schedule.ts`, the 1.5% late-fee default, and whether "countersign by approving the send" is enough.

---

## Self-review (run while writing; results)

- **Spec coverage:** §9.4 proposal/SOW with header, scope, assumptions, out-of-scope, phases and payment milestones, change control and 30-day expiry (Tasks 3, 5, 11); "send the agreement directly" via the approval (Task 6); e-sign with typed name, consent checkbox, ESIGN disclosure, SHA-256 hash and an audit page in the PDF (Tasks 4, 5, 7, 8); pay on signing with card + ACH, payment moves the deal to Won (Tasks 9, 10); §11 every clause bullet (Task 2, with a test that lists them); §8 deposit-first and Care-on-by-default (Tasks 3, 6); §3 legal review and ESIGN basics, retention via the lead-delete refusal (Tasks 2, 4); §9.7 Stripe invoice for the deposit, webhooks and stored IDs (Tasks 9, 10); §7 Document, Signature, Invoice records. Onboarding start, milestone and final invoices, subscriptions, reminders and pause, change orders and the Care agreement are Phase 2 (stated in the header). The 'starts onboarding' half of "payment moves the deal to Won and starts onboarding" is Phase 2.
- **Step scan:** every code step names its signature and the file; function bodies are left to the implementer except the invoice call order, the hash binding of the sign insert, and the per-package schedule rules, which the tests do not determine on their own.
- **Type consistency:** `ProposalContent`, `PaymentSchedule`, `Document`, `SignatureRecord`, `PublicPayment`, `InvoiceRow` are each defined once (Tasks 3, 4, 7, 9) and used with the same names in later tasks. `afterSign` is introduced in Task 7 as a no-op and filled in Tasks 8 and 10. `newClientToken` (Task 4) is the only token generator used.
- **Review Focus:** each of the five lines has named tests in the owning task (1: Tasks 4 and 7; 2: Tasks 5, 7, 8; 3: Tasks 3, 9, 10; 4: Tasks 4, 6, 10; 5: Tasks 3, 6, 11).
- **Proportion:** 12 tasks against Plan 4's 11, and the spec section it implements is about forty lines plus the clause list; the plan carries signatures, test names and the decisions the spec leaves open, not bodies.
