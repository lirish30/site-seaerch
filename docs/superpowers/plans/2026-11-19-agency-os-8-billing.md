# Agency OS — Plan 8: Stripe Invoices, Subscriptions, Reminders and Pause Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Bill everything after the deposit through Stripe: milestone, change-order, hourly and early-exit invoices; monthly autopay subscriptions with term tracking; a reminder ladder on every unpaid invoice; and an automatic work hold 14 days past due. Every client-bound mail is an approval.

**Architecture:** A new `src/worker/billing/` folder holds the logic; the Plan 5 `invoices` table is rebuilt to carry every invoice kind, keyed by a unique `ref` (the idempotency key of each money event). An invoice is first a **draft row with no Stripe object**; its `invoice.send` approval creates and finalizes the Stripe invoice and mails the hosted link, so nothing exists at Stripe or reaches a client without Logan's yes. Triggers (a milestone, a signed change order, a finished build, the daily sweep) only draft and propose. Stripe's webhook is the source of truth for paid, failed and cancelled; a daily sweep reconciles anything a hook or webhook dropped. A **billing hold** is a per-client row, and the work paths (Claude dispatch, recurring tasks, step results) check it, so a finished Care project can be stopped too.

**Tech Stack:** Existing stack (Workers, Hono, D1, zod, vitest Workers pool, React SPA, the approvals registry). Stripe through the existing `fetch` client (`stripe/client.ts`), no SDK, no new npm packages.

**Spec:** `docs/superpowers/specs/2026-11-17-agency-os-design.md` (source: `/Users/loganirish/Project Sites/agency/docs/specs/2026-11-17-agency-os-design.md`). Implemented: §9.7 (Stripe Invoicing for deposit, milestones, final, change orders, hourly; Stripe Billing subscriptions; webhooks for paid, failed, overdue, cancelled; the reminder schedule; pause at +14 days with a notice; term tracking, automatic conversion to Care, early-exit balance; branding; every Stripe ID stored); §8 payment defaults (retainers on monthly autopay, change orders paid upfront, reminders before the due date, on it, +3 and +7, work pauses at +14); §7 "Invoice / Subscription / Payment ... plus the reminder schedule and pause state"; §9.13 (every outbound item, "invoice send" included, waits in the approval inbox); §12 Phase 2 line "Stripe invoices and subscriptions with reminders and pause". **Not in this plan:** the money dashboard and MRR vs $5,000 (Plan 10; the Billing page shows only a plain MRR figure), annual billing, a late-fee charge (clause only), sales tax, auto-approve rules (Phase 3), Care edit-time ledger overage billing (Phase 3), and any accounting export.

**Phase 2 roadmap:** 6 Onboarding (merged) · 7 Projects, SOPs, tasks, time, change orders (merged, PR #28) · **8 Stripe invoices, subscriptions, reminders, pause (this plan)** · 9 Client and site records, access checklist · 10 Meetily, full MCP, money dashboard v1.

**Starts from:** `main` after PR #28 (merge commit 085ae6f). Relies on: `invoices`, `stripe_customers`, `stripe_events` (`migrations/0053_billing.sql`), `db/invoices.ts` (`InvoiceRow`, `markInvoice`, `claimEvent`), `stripe/client.ts` (`call`, `createDepositInvoice`, `retrieveInvoice`, `stripeMode`), `stripe/webhook.ts` (`handleStripeEvent`, `paidProblem`, `StripeDeps`), `routes/stripeWebhook.ts`, `documents/deposit.ts` (`onInvoicePaid`, `ensure`, `setStripeFetchForTests`), `documents/schedule.ts` (`PaymentSchedule`, `Milestone`, `Recurring`), `documents/config.ts` (`legalGate`, `parseDocumentsConfig`), `documents/token.ts` (`newClientToken`, `isClientToken`), `documents/mail.ts` (`clientBase`), `projects/hooks.ts` (`onMilestone`, `onProjectDone`, registered by side-effect import in `index.ts`), `projects/dispatch.ts` (`dispatchReady`), `projects/sweep.ts` (`generateRecurring`, `sweepProjects`), `queue/sopStep.ts`, `db/projects.ts` (`projectIsLive`, `liveProjectSql`, `Project`), `changeorders/service.ts` (`markChangeOrderPaid`, `afterSigned`), `db/changeOrders.ts`, `approvals/registry.ts` (`registerHandler`), `db/approvals.ts` (`createApproval`), `approvals/changeOrderSend.ts` (the pattern to copy), `mail/send.ts` (`sendEmail`, `PUBLIC_PAGE_PREFIXES`), `db/packages.ts` (`getPackage`), `sop/cadence.ts` (`zoneOf`), `today.ts` (`TODAY_KINDS`), `schedule.ts` (`runScheduled`), `routes/public.ts` and `auth.ts` (`isPublicChangeOrder` pattern), `test/fixtures/stripe.ts` (`stripeApi`, `sign`, `invoiceEvent`). Migration numbers start after 0056.

## Global Constraints

- Branch `feat/agency-os-billing` from `main`. `npm test && npm run typecheck` pass after every task; `npm run build` after every UI task. Never edit an applied or merged migration (0053 stays; Task 1 rebuilds `invoices` in a new one). Run from the worktree `../site-search-agency-os`. Subagents run on Sonnet (standing preference).
- Nothing client-bound is sent without Logan's approval (spec §2, §9.13): invoice mails, reminders, the pause notice, the subscription link and the term notice are all approvals. Only fixed templates are mailed; nothing here is written by a model.
- No Stripe object is made until its approval is approved. A **draft** invoice has no Stripe id. Every Stripe POST carries an `Idempotency-Key` derived from the invoice or subscription `ref`, so a retry after a half-finished attempt replays instead of duplicating.
- Money is integer cents (`typeof = 'integer'`, `> 0` on an invoice). Calendar dates (`due_on`, `starts_on`, `term_ends_on`) are `YYYY-MM-DD` in the booking time zone (`zoneOf`, default America/Los_Angeles); times are UTC ISO strings with milliseconds. Month arithmetic clamps to the month's last day.
- Stripe keys and the webhook secret are Worker secrets, never stored, logged or echoed (`cap()` in `stripe/client.ts` strips the key from messages). A **live** key never touches a test row (`test = 1`); a test-mode key may be used for any lead (that is how Logan rehearses). Only the amount Stripe reports as paid, in `usd`, against the invoice's own `ref`, marks an invoice paid; anything else records a `mismatch` and changes nothing else.
- Webhook handlers and `onPaid` must be idempotent (the event is retried after a failure). Every sweep step is idempotent through a unique key and "insert first": a second run at the same moment adds nothing.
- Client pages use `CLIENT_LINK_BASE`, never `workers.dev` or the cold-email host. A token that is unknown, malformed or closed answers 404; responses are `no-store`, `noindex`, `no-referrer`, `frame-ancestors 'none'`. The Checkout success page never trusts the query string: it shows state read from the database (or from Stripe).
- Real subscription links need the Oregon lawyer's review recorded (`legalGate`, spec §16 auto-renewal), exactly as a proposal send does. A client's work is never taken down by a hold: only Logan's and Claude's tasks stop. Hosting, the live site and Care monitoring are untouched.
- Follow existing patterns: zod, DB helpers in `src/worker/db/*.ts`, pure view helpers in `src/client/*View.ts` tested in `test/*-view.test.ts`, guards written into the SQL statement, approval kinds registered by side-effect import in `index.ts`.

## Scope decisions (flag to Logan)

- **Draft, then approve.** Milestone, change-order, hourly and early-exit invoices are drafted by the app and become Stripe invoices only when `invoice.send` is approved. The deposit stays as Plan 5 built it (made on the client's page). Reminder mails and the pause notice are approvals of fixed templates, not Claude-drafted (spec §10 lists them as templates; spec §9.7 says Claude drafts the pause notice, which I replaced with the template to avoid a queue job for a form letter).
- **One due date, one ladder.** Offsets from the due date default to −3, 0, +3, +7 days (`reminderOffsets`), the hold at +14 (`pauseAfterDays`), net terms 7 days (`netDays`), all in Settings > Billing. Only the highest level reached is drafted, so a missed cron day never sends a pile. A failed autopay invoice uses the date it first failed as its due date.
- **The hold is automatic, the notice is an approval** (spec §9.7). It is per client, placed by the daily sweep, and lifted by payment of that invoice, by voiding it, or by Logan. While held: no Claude dispatch, no recurring tasks, no step results applied, no new project starts work. Logan can still work tasks by hand.
- **Autopay by Stripe Checkout** from a stable page `<CLIENT_LINK_BASE>/s/<token>` (card or ACH, hosted by Stripe, no card data touches the app). The page makes a fresh Checkout session on each click, because a session lives 24 hours at most and the mail link must outlive that. **Monthly only**: annual billing is not built (the proposal schedule has no annual price).
- **When each subscription starts.** Signing: first charge one month after the deposit (the first month is in the deposit). Launch: when the build project finishes, first charge that day (a first charge less than 3 days out is taken at Checkout; Stripe needs 48 hours for a trial). Kickoff (Local SEO): only when Logan presses "Start billing"; there is no SEO project to trigger it.
- **Website Subscription converts to Care** at the end of month 24 by swapping the Stripe price (no proration) unless Logan sets the subscription to "client chose a refresh" first; a notice approval is drafted 30 days before. The Care price used is the catalog's current `care` price at conversion (Logan to confirm; grandfathering is not modelled).
- **Early exit** shows the balance (remaining whole months of the term times the monthly price) and needs Logan's confirmation; cancelling sets Stripe to stop at period end and drafts an `early_exit` invoice for the balance.
- **Hourly** bills a project's billable, finished, un-invoiced time in 30-minute blocks (rounded up in total) at the `hourly` price, or, for a Care client, at the hourly package's alternate (Care) price, `altPriceCents` on `hourly` (currently $95 against $125), used only when that alt price is set and the client has an active, non-test `care` or `care_plus` subscription; otherwise the standard hourly rate (which rate a Care client gets is Logan's to confirm, as in Plan 7).
- **Cut line (spec §12 six-week rule):** drop Today rows and the Project billing card (Task 11), then term notice and conversion (Task 7), then hourly (Task 5). Draft/approve, webhook, reminders, hold and subscriptions stay.

## Plan 7 carry-forwards (each is a task)

| Carry-forward | Where |
|---|---|
| `onMilestone`/`onProjectDone` are at-most-once: reconcile | Task 3 (`reconcileMilestones`), Task 6 (launch trigger sweep) |
| Profit "paid" is deal-scoped; a Stripe-paid change order double counts | Task 4 (`paidTotalForDocument`, kinds deposit + milestone only) |
| A done Care project cannot be paused | Task 9 (client-level hold, not a project status) |
| Webhook calls `markChangeOrderPaid(env, id, { via: "stripe", now })` | Task 4 |
| Hooks reach cancelled or test projects | Task 3 checks `project.test` and `status` itself |
| Change orders on a done build are invisible once signed | Not fixed here; Task 11's Today row lists any signed unpaid order's invoice, which makes it visible |

## Review Focus

1. **Double billing.** One milestone reached twice (hook plus sweep); one approval approved twice; Stripe succeeded but the mail failed, then retried; a replayed paid webhook; the same time entries on two hourly invoices; a change order invoiced twice. Tests in Tasks 3, 4 and 5.
2. **Wrong amount marked paid.** A part payment; another currency; a payment against another invoice's `ref`; a milestone amount taken from a superseded document; a refunded or disputed payment arriving later. Tests in Task 4.
3. **A client mailed when they should not be.** A reminder approved after the invoice was paid or voided; a pause notice after the hold lifted; a reminder for a test invoice; the same level drafted twice by two cron runs; a skipped cron day producing three reminders. Tests in Tasks 3 and 8.
4. **A hold that stops too much or too little.** One of two overdue invoices paid; a voided invoice; a client with a finished Care project; a project created for an already-held client; an in-flight Claude result arriving after the hold; the hold lifting and work resuming without a second sweep. Tests in Task 9.
5. **Subscriptions that end up wrong.** A client who never completes Checkout; completes it twice; autopay fails then succeeds; month-end term arithmetic (start on the 31st, 24 months); conversion run twice or after a Stripe failure; cancelling before the term ends; a kickoff subscription nobody started; the success page opened by hand with `?done=1`. Tests in Tasks 6 and 7.

---

### Task 1: Storage, billing config, dates, holds and subscriptions data

**Files:**
- Create: `migrations/0057_billing_invoices.sql`, `src/worker/billing/config.ts`, `src/worker/billing/dates.ts`, `src/worker/db/holds.ts`, `src/worker/db/subscriptions.ts`
- Modify: `src/worker/db/invoices.ts`, `src/worker/db/settings.ts` (add `billing_config` to the column list, line 7), `src/worker/types.ts` (`Settings.billing_config`), and every compile error the wider `InvoiceRow` causes (`documents/deposit.ts` `viewOf` now handles `hostedUrl: string | null`)
- Test: `test/billing-config.test.ts`, `test/billing-dates.test.ts`, `test/invoices-db.test.ts` (extend), `test/holds-db.test.ts`, `test/subscriptions-db.test.ts`

**Interfaces:**
- Produces (`billing/config.ts`): `BillingConfig { netDays: number; reminderOffsets: number[]; pauseAfterDays: number; termNoticeDays: number }`; `DEFAULT_BILLING_CONFIG = { netDays: 7, reminderOffsets: [-3, 0, 3, 7], pauseAfterDays: 14, termNoticeDays: 30 }`; `BillingConfigSchema` (zod: `netDays` 1–60; `reminderOffsets` 1–6 integers, −30 to 60, strictly increasing; `pauseAfterDays` 7–60 and greater than the last offset; `termNoticeDays` 7–90); `parseBillingConfig(raw: string): BillingConfig` (same forgiving behaviour as `parseDocumentsConfig`: bad or empty gives defaults).
- Produces (`billing/dates.ts`, pure): `calendarDateIn(now: Date, tz: string): string`; `calendarDaysBetween(from: string, to: string): number` (to minus from); `addDays(d: string, n: number): string`; `addMonths(d: string, n: number): string` (clamps: 31 Jan plus 1 is 28 Feb, or 29 in a leap year).
- Produces (`db/invoices.ts`): `INVOICE_KINDS = ["deposit", "milestone", "change_order", "hourly", "subscription", "early_exit"]`, `InvoiceKind`; `InvoiceStatus` gains `"draft"`; `InvoiceLine { description: string; amountCents: number }`; `InvoiceRow` gains `projectId, changeOrderId, subscriptionId: string | null`, `ref: string`, `test: boolean`, `description: string`, `lines: InvoiceLine[]`, `dueOn: string | null`, `sentAt: string | null`, `failedOn: string | null`, and `dealId, documentId, stripeCustomerId, stripeInvoiceId, hostedUrl` become `string | null`.
  - `insertDraftInvoice(db, o: { businessId; dealId; documentId; projectId; changeOrderId; subscriptionId: string | null; kind: InvoiceKind; ref: string; test: boolean; description: string; lines: InvoiceLine[] }): Promise<{ invoice: InvoiceRow; created: boolean }>` (amount is the sum of lines; `INSERT OR IGNORE` on `ref`, so a second call returns the first with `created: false`).
  - `getInvoice(db, id)`, `getInvoiceByRef(db, ref)`, `listInvoices(db, o?: { statuses?: InvoiceStatus[]; kinds?: InvoiceKind[]; businessId?: string; projectId?: string }): Promise<InvoiceRow[]>` (newest first).
  - `attachStripeInvoice(db, id, o: { stripeCustomerId: string; stripeInvoiceId: string; hostedUrl: string; dueOn: string | null; now: string }): Promise<boolean>` (draft to open, `sent_at`, guarded `status = 'draft'`).
  - `discardDraftInvoice(db, id): Promise<boolean>` (draft to void, guarded). `markInvoice`'s patch gains `dueOn`, `failedOn`.
  - `paidTotalForDocument(db, documentId, kinds: InvoiceKind[]): Promise<number>`. `getInvoiceForDocument` keeps meaning "the deposit".
- Produces (`db/holds.ts`): `Hold { id; businessId; invoiceId; placedAt; liftedAt: string | null; liftedBy: "payment" | "void" | "manual" | null }`; `placeHold(db, o: { businessId; invoiceId; now: string }): Promise<boolean>` (one per invoice, true only when it made one); `liftHoldsForInvoice(db, invoiceId, by: "payment" | "void", now): Promise<number>`; `liftHold(db, id, by: "manual", now): Promise<boolean>`; `activeHolds(db, businessId?): Promise<(Hold & { businessName: string })[]>`; `isOnHold(db, businessId): Promise<boolean>`; `holdFreeSql(alias: string): string` (`NOT EXISTS (SELECT 1 FROM billing_holds h WHERE h.business_id = <alias>.business_id AND h.lifted_at IS NULL)`).
- Produces (`db/subscriptions.ts`): `SUBSCRIPTION_STATUSES = ["planned", "proposed", "link_sent", "active", "past_due", "cancelled", "ended"]`; `Subscription { id; businessId; documentId; projectId: string | null; packageKey: PackageKey; packageVersion: number; monthlyCents: number; startsWhen: "signing" | "launch" | "kickoff"; firstChargeOn: string | null; termMonths: number | null; termEndsOn: string | null; endAction: "convert_to_care" | "none"; status; token: string | null; stripeCustomerId, stripeSubscriptionId, stripeCheckoutSessionId: string | null; termNoticeSentAt: string | null; test: boolean; createdAt; activatedAt: string | null; cancelledAt: string | null }`; `insertPlanned(db, o)` (unique on `(document_id, package_key)`, returns `{ subscription, created }`), `getSubscription`, `getSubscriptionByToken`, `getSubscriptionByStripeId`, `listSubscriptions(db, o?: { statuses?; businessId? })`, `markSubscription(db, id, patch, o?: { from?: SubscriptionStatus[] }): Promise<boolean>` (guard in the statement), `sumActiveMonthlyCents(db): Promise<number>` (active and past_due).
- Migration `0057_billing_invoices.sql` (header comments as 0053: integer cents, UTC times, no `ON DELETE CASCADE` on business, deal or document, no secret stored): rebuild `invoices` (create new, copy, drop old, rename, recreate indexes) with the columns above plus `kind CHECK IN (the six)`, `ref TEXT NOT NULL UNIQUE`, `stripe_invoice_id TEXT UNIQUE` (nullable), `CHECK (status <> 'draft' OR stripe_invoice_id IS NULL)`, `amount_cents CHECK (> 0 AND typeof = 'integer')`, `lines TEXT NOT NULL DEFAULT '[]'`, partial `UNIQUE (document_id, kind) WHERE kind = 'deposit'`, indexes on deal, project, status; backfill `ref = 'deposit:' || document_id`, `description = 'Deposit'`, `lines` one line, `test` from the document. New tables: `invoice_nudges (invoice_id, step TEXT, approval_id, created_at, PRIMARY KEY (invoice_id, step))` (steps `r1`…`r6` and `pause`), `billing_holds` (unique on `invoice_id`), `subscriptions` (unique `(document_id, package_key)`, unique partial on `token`, `stripe_subscription_id`), `stripe_products (package_key PRIMARY KEY, stripe_product_id NOT NULL)`; `ALTER TABLE settings ADD COLUMN billing_config TEXT NOT NULL DEFAULT '{}'`.

- [ ] **Step 1: Write the failing tests.** Config: `defaults when empty or invalid`, `offsets must increase and the hold must come after the last one`. Dates: `addMonths clamps 31 Jan to 28 Feb and 29 Feb in a leap year`, `addMonths from 31 Jan by 24 lands on 31 Jan`, `calendarDaysBetween across a month and a DST change counts whole days`, `calendarDateIn gives the Pacific date at 23:30 on the 31st`. Invoices: `the migration keeps an existing deposit and gives it ref deposit:<document>`, `insertDraftInvoice twice with one ref returns the first and created false`, `a draft cannot carry a stripe id (CHECK)`, `attachStripeInvoice moves draft to open once`, `discardDraftInvoice only discards a draft`, `paidTotalForDocument counts only the kinds asked for`, `a second deposit for a document is refused but a second milestone is not`. Holds: `placeHold twice for one invoice makes one`, `lifting by payment lifts only that invoice's hold`, `isOnHold is true while any hold is open`, `holdFreeSql filters a projects query`. Subscriptions: `insertPlanned is unique per document and package`, `markSubscription with from guards the transition`.
- [ ] **Step 2: Run to verify failure.** Run: `npx vitest run test/billing-config.test.ts test/billing-dates.test.ts test/holds-db.test.ts test/subscriptions-db.test.ts test/invoices-db.test.ts`. Expected: FAIL (modules and columns missing).
- [ ] **Step 3: Migration and modules** to the signatures above; fix the compile errors in `documents/deposit.ts`, `stripe/webhook.ts` and `test/fixtures/stripe.ts` (`insertInvoice` for a deposit now also takes `ref`, `description`, `test`, `lines`; keep its callers working).
- [ ] **Step 4: Run all.** Run: `npm test && npm run typecheck`. Expected: PASS (the Plan 5 deposit and webhook tests still pass unchanged).
- [ ] **Step 5: Commit** — `git add -A && git commit -m "feat(billing): invoice model, holds, subscriptions and billing config storage"`

---

### Task 2: Stripe client for generic invoices, products, Checkout and subscriptions

**Files:**
- Modify: `src/worker/stripe/client.ts`, `test/fixtures/stripe.ts` (the fake `stripeApi` learns the new routes)
- Test: `test/stripe-client.test.ts` (extend)

**Interfaces:**
- Produces (`stripe/client.ts`):
  - `createInvoice(f, key, o: { customerId: string; lines: { description: string; amountCents: number }[]; daysUntilDue: number; ref: string; kind: InvoiceKind; businessId: string; documentId?: string; footer?: string }, idempotencyKey: string): Promise<{ invoiceId: string; hostedUrl: string; status: string; dueOn: string | null }>` (same three calls as the deposit: invoice with `collection_method: send_invoice`, `auto_advance: false`, `pending_invoice_items_behavior: exclude`, card and `us_bank_account`, metadata `{ ref, kind, business_id, document_id? }`, one invoice item per line by invoice id, finalize; `dueOn` is Stripe's `due_date` converted to a UTC `YYYY-MM-DD`, or null). `createDepositInvoice` keeps its signature and becomes a call to this with metadata `document_id` and `kind: "deposit"` (its tests must pass unchanged).
  - `voidInvoice(f, key, invoiceId): Promise<void>`.
  - `ensureProduct(f, key, o: { packageKey: string; name: string }, idempotencyKey: string): Promise<{ id: string }>`.
  - `createSubscriptionCheckout(f, key, o: { customerId: string; productId: string; name: string; monthlyCents: number; firstChargeOn: string | null; subscriptionId: string; businessId: string; successUrl: string; cancelUrl: string; nowMs: number }, idempotencyKey): Promise<{ sessionId: string; url: string }>` (`mode=subscription`, card and `us_bank_account`, one `price_data` line with `recurring[interval]=month` and the product id, `client_reference_id` and `subscription_data[metadata][subscription_id]` set to the subscription id, `subscription_data[trial_end]` as a unix time at noon UTC of `firstChargeOn` only when that is 3 or more days after `nowMs`; the `url` must be `https://`).
  - `retrieveCheckoutSession(f, key, id): Promise<{ id: string; status: string; paymentStatus: string; subscriptionId: string | null; customerId: string | null }>`.
  - `retrieveSubscription(f, key, id): Promise<{ id: string; status: string; cancelAtPeriodEnd: boolean; currentPeriodEnd: number | null }>`.
  - `changeSubscriptionPrice(f, key, o: { subscriptionId: string; productId: string; name: string; monthlyCents: number }, idempotencyKey): Promise<void>` (reads the item id, then updates it with `price_data` and `proration_behavior: none`).
  - `cancelSubscriptionAtPeriodEnd(f, key, id, idempotencyKey): Promise<void>`.

- [ ] **Step 1: Write the failing tests** (names, with the fake): `createInvoice sends one invoice item per line and finalizes, with ref and kind in metadata`, `createInvoice returns dueOn from Stripe's due_date as a calendar date`, `createInvoice refuses a zero or fractional amount before calling Stripe`, `createDepositInvoice still sends the same calls as before`, `createSubscriptionCheckout sets a trial_end at noon UTC only when the first charge is 3 or more days away`, `createSubscriptionCheckout refuses a non-https url`, `changeSubscriptionPrice sends proration_behavior none and the product id`, `every POST carries an Idempotency-Key and no error message contains the key`, `voidInvoice and cancelSubscriptionAtPeriodEnd send the right form`.
- [ ] **Step 2: Run to verify failure.** Run: `npx vitest run test/stripe-client.test.ts`. Expected: FAIL.
- [ ] **Step 3: Implement** the functions above in `stripe/client.ts` on the existing `call` and `encodeForm`; extend `stripeApi` in `test/fixtures/stripe.ts` with `/v1/products`, `/v1/checkout/sessions`, `/v1/subscriptions/:id` (GET and POST) and `/v1/invoices/:id/void`, replaying a repeated idempotency key as it does now.
- [ ] **Step 4: Run all.** Run: `npm test && npm run typecheck`. Expected: PASS.
- [ ] **Step 5: Commit** — `git add -A && git commit -m "feat(billing): Stripe client for invoices, Checkout, products and subscriptions"`

---

### Task 3: Draft, approve and send an invoice; milestone invoices

**Files:**
- Create: `src/worker/billing/customer.ts`, `src/worker/billing/draft.ts`, `src/worker/billing/mail.ts`, `src/worker/billing/milestones.ts`, `src/worker/approvals/invoiceSend.ts`
- Modify: `src/worker/documents/deposit.ts` (its `ensure` uses `ensureStripeCustomer`), `src/worker/index.ts` (`import "./approvals/invoiceSend"; import "./billing/milestones"`)
- Test: `test/billing-draft.test.ts`, `test/billing-milestones.test.ts`, `test/invoice-send.test.ts`

**Interfaces:**
- Consumes: Task 1 (`insertDraftInvoice`, `attachStripeInvoice`, `getInvoice`, `parseBillingConfig`, `calendarDateIn`), Task 2 (`createInvoice`), `createApproval` and the `change_order.send` approval as the template to copy, `sendEmail(env, { mailbox: "main", to, subject, body, includeFooter: false, businessId }, { approvalId, skipLimits: true })`, `onMilestone` from `projects/hooks.ts`, `getDocument`.
- Produces (`billing/customer.ts`): `ensureStripeCustomer(env: Env, o: { businessId: string; name: string; email: string }, f: Fetch): Promise<string>` (the existing get-or-create-and-save with idempotency key `customer:<businessId>`).
- Produces (`billing/mail.ts`, pure): `renderInvoiceMail(inv: InvoiceRow, link: string, c: { clientName: string; contactName: string; yourName: string }): { subject: string; body: string }` (fixed words, the amount, what it is for, the due date, the link; client text one-lined and capped); `invoiceRecipient(env, inv: InvoiceRow): Promise<{ to: string; clientName: string; contactName: string }>` (from the invoice's document header, else the project's onboarding contact, else the business's primary contact; throws a plain sentence when there is none).
- Produces (`billing/draft.ts`): `proposeInvoice(env, invoiceId: string): Promise<Approval>` (kind `invoice.send`, payload `{ invoiceId }`, `record_type: "project"` or `"business"`, one waiting approval per invoice: a second call returns the first; refuses a non-draft invoice with a plain sentence); `draftAndPropose(env, o: Parameters<typeof insertDraftInvoice>[1]): Promise<{ invoice: InvoiceRow; approval: Approval | null }>` (approval is null when the invoice already existed and is no longer a draft).
- Produces (`approvals/invoiceSend.ts`): kind `invoice.send`. `execute` re-checks everything at approval time and throws a plain sentence on a problem (Stripe not set up, a live key with a test row, no `CLIENT_LINK_BASE` is not needed here, a recipient is missing). In order, each step safe to repeat: re-read the invoice and **return without sending when it is no longer a draft and already has a sent mail** (paid, void, or open and mailed by this approval); create the customer; `createInvoice` with idempotency key `inv:<ref>` and a `footer` of the provider's business name and contact email from settings (spec §9.7 branding; the logo and colours are set in the Stripe Dashboard, Logan's to-do); `attachStripeInvoice` (guarded); mail the hosted link with the approval id as the once-only key; `logActivityOnce` `invoice_sent`.
- Produces (`billing/milestones.ts`): `milestoneInvoice(env, p: Project, m: MilestoneKey): Promise<InvoiceRow | null>` (null for a test or cancelled project, no document, a document not signed and paid, or no schedule milestone with `dueOn === m`; ref `milestone:<documentId>:<m>`; one line `<label> (<reference>)` for the **frozen** `amountCents` of the signed document the project was started from); `reconcileMilestones(env): Promise<number>` (every real, not-cancelled project with a reached milestone and no invoice row of that ref gets one; returns how many). Registers `onMilestone((env, p, m) => draftAndPropose for milestoneInvoice)` at import.

- [ ] **Step 1: Write the failing tests.** Milestones: `starter site: site_finished drafts the second 50 percent from the signed schedule`, `growth: design_approved drafts the 30 and site_finished the last 30`, `a test project drafts nothing`, `a cancelled project drafts nothing`, `a replayed hook and reconcileMilestones make one invoice and one approval`, `the amount is the signed document's even after the catalog price changed`. Draft: `proposeInvoice twice returns one approval`, `a draft whose approval is rejected stays a draft and reconcile does not draft it again`. Send: `approving creates the Stripe invoice once and mails the link once`, `a retry after Stripe succeeded but the mail failed makes no second Stripe invoice and mails once`, `approving an invoice that was voided meanwhile mails nothing`, `a live key with a test row refuses with a plain sentence and the approval stays pending`, `Stripe unreachable leaves the approval pending and the invoice a draft`, `the mail carries the amount, the due date and the hosted link and none of the project's task text`.
- [ ] **Step 2: Run to verify failure.** Run: `npx vitest run test/billing-draft.test.ts test/billing-milestones.test.ts test/invoice-send.test.ts`. Expected: FAIL.
- [ ] **Step 3: Implement** the modules above. `execute` follows `approvals/changeOrderSend.ts` in shape: every precondition is re-read, nothing is trusted from the payload but the invoice id.
- [ ] **Step 4: Run all.** Run: `npm test && npm run typecheck`. Expected: PASS.
- [ ] **Step 5: Commit** — `git add -A && git commit -m "feat(billing): draft, approve and send invoices; milestone invoices"`

---

### Task 4: Webhook for every invoice kind, paid scoping, and the Stripe-paid change order

**Files:**
- Create: `src/worker/billing/paid.ts`, `src/worker/billing/mirror.ts`
- Modify: `src/worker/stripe/webhook.ts` (`paidProblem`, `apply`), `src/worker/routes/stripeWebhook.ts` (`onPaid: onAnyInvoicePaid`, plus the new handlers), `src/worker/routes/projects.ts` (`soldAndPaid`: use `paidTotalForDocument(env.DB, p.documentId, ["deposit", "milestone"])` where it used `paidTotalForDeal`; `paidTotalForDeal` stays exported)
- Test: `test/billing-paid.test.ts`, `test/stripe-webhook.test.ts` (extend), `test/time-profit.test.ts` (extend)

**Interfaces:**
- Consumes: Task 1 (`markInvoice`, `getInvoiceByRef`, `liftHoldsForInvoice`, `getSubscriptionByStripeId`, `markSubscription`), `markChangeOrderPaid`, `dispatchReady`, `onInvoicePaid` from `documents/deposit.ts`, `handleStripeEvent`.
- Produces (`stripe/webhook.ts`): `paidProblem(inv, obj)` compares `metadata.document_id` for a deposit and `metadata.ref === inv.ref` for every other kind (amount and currency checks unchanged); `StripeEvent` handling of `invoice.paid`, `invoice.payment_failed`, `invoice.voided`, `invoice.marked_uncollectible`, `checkout.session.completed`, `customer.subscription.updated`, `customer.subscription.deleted` (every other type stays `ignored`).
- Produces (`billing/paid.ts`): `onAnyInvoicePaid(env: Env, inv: InvoiceRow): Promise<void>`, idempotent: by kind, `deposit` runs `onInvoicePaid`; `change_order` runs `markChangeOrderPaid(env, inv.changeOrderId, { via: "stripe", now })` (a change order that is no longer signed, for example voided, is noted on the timeline and does not throw); `milestone`, `hourly`, `early_exit` and `subscription` log `invoice_paid` once; then for every kind `liftHoldsForInvoice(db, inv.id, "payment", now)` and `dispatchReady(env, now)`.
- Produces (`billing/mirror.ts`): `mirrorSubscriptionInvoice(env, obj: Record<string, any>, type: string): Promise<InvoiceRow | null>` (an Stripe invoice with a `subscription` id that matches a local subscription and has no local row gets `kind: "subscription"`, `ref: "stripe:<invoice id>"`, the amount paid or due, `due_on` from `due_date` when present, `failed_on` = today (owner zone) on a failure; null for an unknown subscription); `subscriptionCheckoutCompleted(env, session): Promise<void>` (matches by `client_reference_id`; stores `stripe_subscription_id`, status `active`, `activated_at`, `term_ends_on = addMonths(first_charge_on, term_months)`; idempotent; ignores a session that is not `mode: subscription` or not paid or not a trial); `subscriptionUpdated(env, obj)`: maps Stripe `past_due` to `past_due`, `active` back to `active`, `canceled` to `cancelled` (an `ended` term stays `ended`).

- [ ] **Step 1: Write the failing tests.** `a paid milestone invoice is marked paid and logs once`, `a paid change-order invoice marks the order paid through stripe and unlocks its tasks once, also when the event is replayed`, `a paid event for a change order that was voided is noted and does not throw`, `a paid amount that is not the invoiced cents records a mismatch and unlocks nothing`, `a part payment, another currency and another invoice's ref are each a mismatch`, `a milestone invoice's metadata ref that belongs to another invoice is a mismatch`, `a paid event lifts that invoice's hold only`, `a subscription cycle invoice for a known subscription is mirrored once and counted once on replay`, `an invoice for an unknown subscription is ignored`, `checkout.session.completed activates the subscription once and sets the term end`, `a failed autopay invoice sets failed_on and moves the subscription to past_due; the next paid one moves it back`, `profit paid counts the document's deposit and milestone invoices and not a change-order invoice`.
- [ ] **Step 2: Run to verify failure.** Run: `npx vitest run test/billing-paid.test.ts test/stripe-webhook.test.ts test/time-profit.test.ts`. Expected: FAIL.
- [ ] **Step 3: Implement** the modules above and wire the route. Keep the claim, lease and release behaviour of `handleStripeEvent` exactly as it is.
- [ ] **Step 4: Run all.** Run: `npm test && npm run typecheck`. Expected: PASS.
- [ ] **Step 5: Commit** — `git add -A && git commit -m "feat(billing): webhook for every invoice kind, Stripe-paid change orders, paid scoping"`

---

### Task 5: Change-order, hourly and discard actions

**Files:**
- Create: `src/worker/billing/changeOrderInvoice.ts`, `src/worker/billing/hourly.ts`, `src/worker/billing/discard.ts`
- Modify: `src/worker/changeorders/service.ts` (`afterSigned` drafts the invoice in its own try; a failure is logged and never undoes the signature), `src/worker/db/time.ts` (the time-entries DB module Plan 7 added; add the two helpers below)
- Test: `test/billing-changeorder.test.ts`, `test/billing-hourly.test.ts`, `test/billing-discard.test.ts`

**Interfaces:**
- Produces (`billing/changeOrderInvoice.ts`): `invoiceChangeOrder(env, changeOrderId: string): Promise<{ invoice: InvoiceRow; approval: Approval | null }>`; refuses (plain sentence, 409 at the route) a change order that is not signed, already paid, a test order, or on a cancelled project; ref `co:<id>`; one line `<reference>: <title>` for `content.priceCents`.
- Produces (`billing/hourly.ts`): `hourlyInvoice(env, o: { projectId: string; now: Date }): Promise<{ invoice: InvoiceRow; approval: Approval | null } | null>` (null when there are no billable, finished, un-invoiced minutes; blocks rounded up to 30 minutes in total; rate = `getPackage(db, "hourly").priceCents`, or `altPriceCents` when the business has an active `care` or `care_plus` subscription; ref `hourly:<projectId>:<n>`; the entries are tagged `invoiced_ref = ref` in the same batch as the draft, guarded `invoiced_ref IS NULL`); time-entries module gains `unbilledBillableMinutes(db, projectId): Promise<{ entryIds: string[]; minutes: number }>` and `releaseTimeEntries(db, ref): Promise<number>`.
- Produces (`billing/discard.ts`): `discardInvoice(env, id): Promise<InvoiceRow>` for a **draft** (rejects its waiting `invoice.send` approval, voids the row, releases time entries); `voidSentInvoice(env, id): Promise<InvoiceRow>` for an open or failed invoice (Stripe void, then local void, releases time entries, lifts that invoice's hold); both refuse a paid invoice with a plain sentence.

- [ ] **Step 1: Write the failing tests.** `signing a real change order drafts one invoice and one approval, replays make no more`, `a test change order is not invoiced`, `a change order that is paid by hand cannot be invoiced`, `the invoice for a change order is its frozen price`, `hourly: 70 minutes of billable time becomes 90 minutes at the hourly price`, `hourly: a Care client with an active Care subscription gets the alt rate`, `hourly: the same entries cannot go on two drafts, even when two requests race`, `hourly: nothing to bill returns null`, `discarding a draft releases its time entries and rejects its approval`, `voiding an open invoice calls Stripe once and lifts its hold`, `a paid invoice cannot be discarded or voided`.
- [ ] **Step 2: Run to verify failure.** Run: `npx vitest run test/billing-changeorder.test.ts test/billing-hourly.test.ts test/billing-discard.test.ts`. Expected: FAIL.
- [ ] **Step 3: Implement** the modules above.
- [ ] **Step 4: Run all.** Run: `npm test && npm run typecheck`. Expected: PASS.
- [ ] **Step 5: Commit** — `git add -A && git commit -m "feat(billing): change-order and hourly invoices, discard and void"`

---

### Task 6: Subscriptions: plan, propose, the client's Checkout page

**Files:**
- Create: `src/worker/billing/subscriptions.ts`, `src/worker/billing/checkout.ts`, `src/worker/approvals/subscriptionStart.ts`
- Modify: `src/worker/billing/mail.ts` (add `renderSubscriptionLink(sub, link, c): { subject; body }`, fixed words), `src/worker/documents/deposit.ts` (`onInvoicePaid` calls `planSubscriptions` for a real document, in its own try like `startProjects`), `src/worker/routes/public.ts` (`GET /s/:token`, `POST /s/:token/checkout`, both `clientLimited`), `src/worker/auth.ts` (`isPublicSubscription`, same shape as `isPublicChangeOrder`), `src/worker/mail/send.ts` (`PUBLIC_PAGE_PREFIXES` gains `"/s/"`), `src/worker/index.ts` (import the approval and `billing/subscriptions`)
- Test: `test/billing-subscriptions.test.ts`, `test/subscription-start.test.ts`, `test/subscription-public.test.ts`

**Interfaces:**
- Consumes: Task 1 (`insertPlanned`, `markSubscription`, `getSubscriptionByToken`), Task 2 (`ensureProduct`, `createSubscriptionCheckout`, `retrieveCheckoutSession`), Task 3 (`ensureStripeCustomer`), `legalGate`, `newClientToken`, `onProjectDone`, `clientBase`.
- Produces (`billing/subscriptions.ts`): `planSubscriptions(env, doc: Document): Promise<number>` (one `planned` row per `doc.content.schedule.recurring`; `end_action: "convert_to_care"` only for `website_subscription`; `term_months` from the recurring entry); `proposeSubscription(env, id: string, firstChargeOn: string): Promise<Approval>` (planned to proposed, kind `subscription.start`, payload `{ subscriptionId }`, preview shows plan, monthly price, first charge date, term and the exact mail); `startDueSubscriptions(env, now: Date): Promise<number>` (a recurring entry whose first month is prepaid in the deposit, whatever its trigger, has its first charge one month after its start date; signing-start rows: first charge `addMonths(paid date, 1)`; launch-start rows whose document's build project is `done`: first charge today; kickoff rows are never started here); `startKickoff(env, id, now): Promise<Approval>` (the owner's "Start billing"); registers `onProjectDone` to propose launch subscriptions when `p.kind === "build"` and the project is real.
- Produces (`approvals/subscriptionStart.ts`): kind `subscription.start`; `execute` re-checks (Stripe configured, `clientBase` set, `legalGate` for a real subscription, subscription still `proposed`), issues the token (`newClientToken`, kept on a retry), sets `link_sent`, mails `<CLIENT_LINK_BASE>/s/<token>` once (approval id as the once-only key); refuses with a plain sentence otherwise.
- Produces (`billing/checkout.ts`): `subscriptionPage(env, token: string, deps?: { fetch?: Fetch }): Promise<PublicSubscription | null>` where `PublicSubscription = { clientName: string; planName: string; monthlyCents: number; firstChargeOn: string | null; termMonths: number | null; state: "ready" | "active" | "closed" }` (null for an unknown, malformed or `planned` token; a `link_sent` subscription with a stored session is checked with Stripe and activated if the session is complete, exactly like the deposit's `settle`); `startCheckout(env, token, deps?): Promise<{ url: string } | { error: "closed" | "unavailable" }>` (customer, product, a fresh Checkout session with idempotency key `checkout:<id>:<UTC date>`, the session id stored; refuses an `active` or `cancelled` subscription so a second Checkout cannot make a second subscription).

- [ ] **Step 1: Write the failing tests.** Plan: `a signed website subscription plans one row that converts to care, with 24 months`, `care, local seo and a build's care each plan once`, `planning twice adds nothing`, `a test document plans nothing`. Start: `signing-start: first charge is one month after the deposit`, `launch-start: nothing until the build project is done, then one proposal; the hook and the daily sweep make one`, `kickoff never starts by itself and starts when Logan asks`, `a kickoff entry with a prepaid first month charges one month after Start billing, not on the day`, `approving mails the /s/ link once and sets link_sent; a retry keeps the token and mails once`, `approving without the lawyer's review recorded refuses`, `a rejected proposal can be proposed again`. Public: `an unknown, malformed or planned token is 404`, `startCheckout returns a Stripe https url and stores the session`, `a second click makes a new session but an active subscription is refused`, `?done=1 on a subscription that Stripe says is not paid still shows ready`, `a complete session found by the page activates the subscription once`.
- [ ] **Step 2: Run to verify failure.** Run: `npx vitest run test/billing-subscriptions.test.ts test/subscription-start.test.ts test/subscription-public.test.ts`. Expected: FAIL.
- [ ] **Step 3: Implement** the modules above and the two public routes (same limits, headers and 404 behaviour as `/c/:token`).
- [ ] **Step 4: Run all.** Run: `npm test && npm run typecheck`. Expected: PASS.
- [ ] **Step 5: Commit** — `git add -A && git commit -m "feat(billing): subscriptions planned at signing, proposed by trigger, paid through Checkout"`

---

### Task 7: Term tracking, conversion to Care, early exit

**Files:**
- Create: `src/worker/billing/terms.ts`, `src/worker/approvals/termNotice.ts`
- Modify: `src/worker/billing/mail.ts` (add `renderTermNotice(sub, c): { subject; body }`), `src/worker/index.ts` (import the approval)
- Test: `test/billing-terms.test.ts`

**Interfaces:**
- Consumes: Task 1 (`addMonths`, `calendarDaysBetween`, `markSubscription`), Task 2 (`changeSubscriptionPrice`, `cancelSubscriptionAtPeriodEnd`, `ensureProduct`), Task 3 (`draftAndPropose`), `getPackage`.
- Produces (`billing/terms.ts`): `earlyExitCents(sub: Subscription, today: string): number` (pure: remaining whole months to `term_ends_on` times `monthlyCents`; 0 for no term, an ended term or a cancelled subscription); `class EarlyExitError extends Error { cents: number }`; `cancelSubscription(env, id, o: { confirmEarlyExit: boolean; now: Date }): Promise<{ subscription: Subscription; invoice: InvoiceRow | null }>` (a subscription that never became active is just closed with no Stripe call; otherwise throws `EarlyExitError` when a balance is owed and not confirmed; then `cancelSubscriptionAtPeriodEnd`, status `cancelled`, and for a balance `draftAndPropose` an `early_exit` invoice, ref `early_exit:<id>`); `setEndAction(db, id, action: "convert_to_care" | "none")`; `sweepTerms(env, now: Date): Promise<{ notices: number; converted: number }>`: an active subscription with `end_action = convert_to_care` and `term_ends_on` within `termNoticeDays` and no `term_notice_sent_at` gets a `subscription.term_notice` approval (stamped insert-first); one whose term end is today or past is converted: Stripe price swap to the current `care` price with idempotency key `convert:<id>`, then the local row (`package_key = care`, new monthly, `end_action = none`, `term_months = null`) in one guarded statement, one timeline line. A Stripe failure leaves the row as it was and is tried again next sweep.
- Produces (`approvals/termNotice.ts`): kind `subscription.term_notice`; fixed mail (the term ends on a date, it moves to Care at the monthly price, reply if you would like a refresh instead); `execute` returns without mailing when the subscription is no longer active or no longer set to convert.

- [ ] **Step 1: Write the failing tests.** `earlyExitCents: 10 months left at 297 is 2970, none after the term, none with no term`, `a term starting on the 31st for 24 months ends on the 31st two years on and one month later clamps`, `the notice is drafted once, 30 days out, even across two sweeps`, `a subscription set to none gets no notice and no conversion`, `conversion swaps the price once on a replayed sweep and leaves the row unchanged when Stripe fails`, `cancel without confirmation refuses with the balance`, `cancel with confirmation stops at period end and drafts one early-exit invoice`, `cancel after the term owes nothing and drafts nothing`, `cancelling a link_sent subscription closes it with no Stripe call`, `local seo's six-month first term is an early-exit term too`.
- [ ] **Step 2: Run to verify failure.** Run: `npx vitest run test/billing-terms.test.ts`. Expected: FAIL.
- [ ] **Step 3: Implement** the modules above.
- [ ] **Step 4: Run all.** Run: `npm test && npm run typecheck`. Expected: PASS.
- [ ] **Step 5: Commit** — `git add -A && git commit -m "feat(billing): term tracking, conversion to Care and early exit"`

---

### Task 8: Reminder ladder

**Files:**
- Create: `src/worker/billing/reminders.ts`, `src/worker/approvals/invoiceReminder.ts`
- Modify: `src/worker/billing/mail.ts` (add `renderReminder`), `src/worker/index.ts` (import the approval)
- Test: `test/billing-reminders.test.ts`

**Interfaces:**
- Consumes: Task 1 (`listInvoices`, `invoice_nudges`, `parseBillingConfig`, `calendarDaysBetween`, `calendarDateIn`), Task 3 (`invoiceRecipient`), `sendEmail`.
- Produces (`billing/reminders.ts`): `reminderStep(offsets: number[], daysFromDue: number): number | null` (pure: the 1-based index of the highest offset at or below `daysFromDue`; null before the first); `sweepReminders(env, now: Date): Promise<number>` (for every real, sent invoice in `open` or `failed` with a base date (`due_on`, or `failed_on` for an autopay failure), the step is inserted first into `invoice_nudges` as `r<n>`; a new row means one `invoice.reminder` approval, payload `{ invoiceId, step: number }`; only the highest step reached is drafted; test invoices and drafts are never reminded).
- Produces (`billing/mail.ts`): `renderReminder(step: number, total: number, inv: InvoiceRow, link: string, c: { contactName: string; yourName: string; pauseOn: string }): { subject: string; body: string }` (fixed words: before due is a heads-up, on the due date a plain reminder, later steps say it is overdue, and the last step says work on the project pauses on `pauseOn` unless paid; a failed autopay invoice links the hosted invoice page to update the payment method).
- Produces (`approvals/invoiceReminder.ts`): kind `invoice.reminder`; `execute` re-reads the invoice and returns **without mailing** when it is no longer `open` or `failed` (paid, void, uncollectible), logging a timeline line that says so; otherwise mails once (approval id as the key).

- [ ] **Step 1: Write the failing tests.** `reminderStep: -4 days is null, -3 is 1, 0 is 2, 5 is 3, 9 is 4`, `an invoice three days before its due date drafts step 1 once across two sweeps`, `a sweep after a skipped week drafts only the highest step reached`, `the next day's sweep drafts the next step and not the earlier ones`, `a draft, paid, void or test invoice is never reminded`, `a failed autopay invoice counts from failed_on`, `approving a reminder for an invoice paid meanwhile mails nothing and says so`, `the last step names the pause date, due plus pauseAfterDays`, `changing the offsets in settings changes the steps for later sweeps`.
- [ ] **Step 2: Run to verify failure.** Run: `npx vitest run test/billing-reminders.test.ts`. Expected: FAIL.
- [ ] **Step 3: Implement** the modules above.
- [ ] **Step 4: Run all.** Run: `npm test && npm run typecheck`. Expected: PASS.
- [ ] **Step 5: Commit** — `git add -A && git commit -m "feat(billing): reminder ladder as approvals"`

---

### Task 9: The billing hold: placing it, enforcing it, lifting it

**Files:**
- Create: `src/worker/billing/hold.ts`, `src/worker/approvals/pauseNotice.ts`
- Modify: `src/worker/billing/mail.ts` (add `renderPauseNotice(inv, link, c): { subject; body }`), `src/worker/projects/dispatch.ts` (lines 33, 60, 96: add the hold check), `src/worker/projects/sweep.ts` (`generateRecurring`, line 52), `src/worker/queue/sopStep.ts` (lines 187, 214, 226), `src/worker/routes/projects.ts` ("Ask Claude", line 309), `src/worker/index.ts` (import the approval)
- Test: `test/billing-hold.test.ts`

**Interfaces:**
- Consumes: Task 1 (`placeHold`, `isOnHold`, `holdFreeSql`, `liftHold`), Task 3 (`invoiceRecipient`), `dispatchReady`, `logActivityOnce`.
- Produces (`billing/hold.ts`): `sweepHolds(env, now: Date): Promise<number>` (every real, sent `open` or `failed` invoice at or past `pauseAfterDays` from its base date gets `placeHold` and, insert-first as `pause` in `invoice_nudges`, one `invoice.pause_notice` approval; one `billing_hold_placed` timeline line; returns how many holds it placed); `liftManually(env, holdId, now): Promise<void>` (lifts and calls `dispatchReady`).
- Produces (`approvals/pauseNotice.ts`): kind `invoice.pause_notice`; fixed mail (the invoice, how overdue, that work has paused and resumes when it is paid, the hosted link); `execute` returns without mailing when the hold is already lifted.
- Enforcement, by rule: a project whose business `isOnHold` is not workable. In SQL use `holdFreeSql("p")` next to `liveProjectSql("p")`; in code call `isOnHold(db, project.businessId)` next to `projectIsLive(project)`. A step result that arrives for a held client's project is treated exactly as Plan 7 treats a paused project's (stale, the step handed back). `projectIsLive` and `liveProjectSql` themselves do not change (Today and the project list still show a held client's projects).

- [ ] **Step 1: Write the failing tests.** `a real invoice 14 days past due places one hold and one pause notice, a second sweep places none`, `13 days past due places none`, `a test invoice places none`, `a held client: dispatchReady queues nothing and "Ask Claude" is refused with a plain sentence`, `a held client: generateRecurring makes no task, also for a finished Care project`, `a held client: an in-flight Claude result is stale and the step is handed back`, `a project started for an already-held client dispatches nothing`, `two overdue invoices: paying one keeps the hold, paying both lifts it and dispatch resumes without another sweep`, `voiding the overdue invoice lifts its hold`, `Logan lifting a hold resumes dispatch`, `approving a pause notice after the hold lifted mails nothing`, `a held client's tasks can still be worked by hand`.
- [ ] **Step 2: Run to verify failure.** Run: `npx vitest run test/billing-hold.test.ts`. Expected: FAIL.
- [ ] **Step 3: Implement** the modules and make the enforcement edits. Do not add a column to `projects`.
- [ ] **Step 4: Run all.** Run: `npm test && npm run typecheck`. Expected: PASS (every Plan 7 dispatch, sweep and sopStep test still passes: they have no holds).
- [ ] **Step 5: Commit** — `git add -A && git commit -m "feat(billing): client-level hold at 14 days overdue, enforced in every work path"`

---

### Task 10: Owner routes and the daily billing sweep

**Files:**
- Create: `src/worker/routes/billing.ts`, `src/worker/billing/sweep.ts`
- Modify: `src/worker/schedule.ts` (a new `part("billing sweep", () => sweepBilling(env, now))` after the project sweep; update the doc comment), `src/worker/index.ts` (mount the routes), `src/worker/routes/settings.ts` (a `billing_config` save beside `documents_config`, validated with `BillingConfigSchema`, errors as 400 with the field message)
- Test: `test/billing-routes.test.ts`, `test/billing-sweep.test.ts`

**Interfaces:**
- Produces (`billing/sweep.ts`): `sweepBilling(env, now): Promise<{ drafted: number; reminders: number; holds: number; started: number; converted: number; notices: number }>`; in order, each part contained and logged (one failing never stops another, nothing here sends mail): `reconcileMilestones`, `startDueSubscriptions`, `sweepReminders`, `sweepHolds`, `sweepTerms`, and a settle of stale open invoices (an `open` invoice older than a day whose Stripe state differs is brought up to date through `retrieveInvoice` and the same paid path as the webhook, so a webhook that never came still resolves).
- Produces (`routes/billing.ts`, all under the session): `GET /billing/summary` (`{ mrrCents, openCents, overdueCents, heldClients: number }`); `GET /billing/invoices?status=&kind=&businessId=&projectId=`; `POST /billing/invoices/:id/propose`; `POST /billing/invoices/:id/discard`; `POST /billing/invoices/:id/void`; `POST /change-orders/:id/invoice`; `POST /projects/:id/invoices/hourly`; `GET /billing/subscriptions`; `POST /billing/subscriptions/:id/start` (kickoff); `PATCH /billing/subscriptions/:id` (`{ endAction }`); `POST /billing/subscriptions/:id/cancel` (`{ confirmEarlyExit }`, 409 with `{ error, earlyExitCents }` when unconfirmed); `GET /billing/holds`; `POST /billing/holds/:id/lift`; `GET /billing/stripe-status` (`{ mode: "test" | "live" | null, webhookSecretSet: boolean, clientBaseSet: boolean, legalReviewed: boolean }`, never a key). Bodies are zod `.strict()`; errors are plain sentences, 404 before 400 for an unknown id.

- [ ] **Step 1: Write the failing tests.** Routes: `each route answers 401 without a session`, `summary counts mrr from active and past_due subscriptions only`, `an unconfirmed cancel is 409 with the balance`, `propose on a paid invoice is 409`, `stripe-status never contains a key`, `a bad billing_config is 400 with the field named`. Sweep: `the cron's daily run reaches the billing sweep and survives one part throwing`, `a sweep twice at one moment makes one of everything`, `an open invoice whose webhook never came is settled from Stripe`, `the sweep sends no mail and creates only approvals and holds`.
- [ ] **Step 2: Run to verify failure.** Run: `npx vitest run test/billing-routes.test.ts test/billing-sweep.test.ts`. Expected: FAIL.
- [ ] **Step 3: Implement** the routes and the sweep to the signatures above.
- [ ] **Step 4: Run all.** Run: `npm test && npm run typecheck`. Expected: PASS.
- [ ] **Step 5: Commit** — `git add -A && git commit -m "feat(billing): owner routes and the daily billing sweep"`

---

### Task 11: Owner UI: Billing page, Settings > Billing, project card, Today rows

**Files:**
- Create: `src/client/pages/Billing.tsx`, `src/client/pages/settings/Billing.tsx`, `src/client/billingView.ts`, `src/client/components/ProjectBilling.tsx`
- Modify: `src/client/components/Shell.tsx` and `src/client/navView.ts` (a Billing link), `src/client/pages/settings/SettingsHome.tsx`, `src/client/pages/Project.tsx` (the card), `src/client/pages/Today.tsx`, `src/worker/today.ts` (`TODAY_KINDS` gains `billing_attention`; rows for a draft invoice waiting to be proposed, an approved-but-unpaid invoice past due, and an active hold; and add `invoice_sent`, `invoice_paid` and `billing_hold_placed` to the `NOT_CONTACT` set, because billing activity is not contact with a prospect), `src/client/api.ts`
- Test: `test/billing-view.test.ts`, `test/today.test.ts` (extend)

**Interfaces:**
- Produces (`billingView.ts`, pure): `invoiceStatusLabel(i: { status; dueOn: string | null; failedOn: string | null }, today: string): { text: string; tone: "ok" | "wait" | "late" | "bad" }` ("Draft, not sent", "Due 4 Dec", "6 days overdue", "Paid", "Payment failed"); `groupInvoices(rows, today): { needsYou: Row[]; open: Row[]; paid: Row[] }`; `subscriptionLine(s): string` ("$297/mo, 24-month term to 31 Jan 2028, first charge 1 Feb"); `earlyExitText(cents)`; `dollars` reused from `packagesView`.
- The Billing page: summary strip (MRR, open, overdue, clients on hold), tabs Invoices, Subscriptions, Holds. Invoices: draft rows show Propose and Discard; open rows show the hosted link (copy) and Void; each row links to its client and project. Subscriptions: status, next step (Start billing for kickoff, a notice that the link was sent, the early-exit confirmation dialog on Cancel, an "End of term" selector: convert to Care or the client chose a refresh). Holds: each with its overdue invoice and a Lift button (confirm dialog, logged). Settings > Billing: the four config numbers, with the Stripe status panel (mode, webhook secret set, client base set, review recorded) and the list of webhook events to enable in Stripe. The project card: its invoices, "Bill unbilled hours", and a change order's "Invoice" button.
- Today: a `billing_attention` row per client: "Invoice drafted: needs your OK to send", "Invoice N days overdue", "Work on hold since <date>"; it opens the Billing page filtered to that client.

- [ ] **Step 1: Write the failing tests.** `invoiceStatusLabel: draft, due in future, overdue by 6 days, failed, paid`, `groupInvoices puts drafts and overdue under needsYou`, `subscriptionLine reads a 24-month term with month-end clamping`, `Today shows one billing row per client with the worst state first`, `a billing row does not un-stall a deal`.
- [ ] **Step 2: Run to verify failure.** Run: `npx vitest run test/billing-view.test.ts test/today.test.ts`. Expected: FAIL.
- [ ] **Step 3: Implement** the helpers, `today.ts` rows and the pages.
- [ ] **Step 4: Run all.** Run: `npm test && npm run typecheck && npm run build`. Expected: PASS.
- [ ] **Step 5: Commit** — `git add -A && git commit -m "feat(billing): Billing page, Settings > Billing, project card, Today rows"`

---

### Task 12: The client's subscription page (`/s/<token>`)

**Files:**
- Create: `src/client/pages/Subscribe.tsx`, `src/client/subscribeView.ts`
- Modify: `src/client/App.tsx` (a `<Route path="/s/*" element={<Subscribe />} />` beside `/c/*`, line 58; the page needs no session and no Shell), `src/client/api.ts`
- Test: `test/subscribe-view.test.ts`

**Interfaces:**
- Produces (`subscribeView.ts`, pure): `subscribeCopy(p: PublicSubscription): { heading: string; lines: string[]; button: string | null; note: string }` (state `ready`: what you are setting up, the monthly price, the first charge date, the term in plain words, "card or bank account", button "Set up payment"; `active`: "You're all set" with the plan line and no button; `closed`: "This link is no longer open" and no button).
- The page: reads `GET /api/public/s/<token>`; the button posts to `/checkout` and navigates to the returned Stripe URL; on return (`?done=1`) it **re-reads the state** and shows what the server says, polling a few times because the webhook may land a moment after the redirect. Layout: phone first, 16px type or larger on inputs and buttons at least 44px tall, nothing from the project's internal tasks.

- [ ] **Step 1: Write the failing tests.** `ready copy states the price, first charge date and term`, `a one-month-away first charge reads "first charge on <date>" and a today charge reads "charged today"`, `active has no button`, `closed has no button and no plan details`, `no copy line contains a token or a Stripe id`.
- [ ] **Step 2: Run to verify failure.** Run: `npx vitest run test/subscribe-view.test.ts`. Expected: FAIL.
- [ ] **Step 3: Implement** the view helper and the page.
- [ ] **Step 4: Run all.** Run: `npm test && npm run typecheck && npm run build`. Expected: PASS.
- [ ] **Step 5: Commit** — `git add -A && git commit -m "feat(billing): client subscription page"`

---

### Task 13: End-to-end flow test and open-items note

**Files:**
- Create: `test/billing-flow.test.ts`, `docs/superpowers/notes/2026-11-plan-8-open-items.md`
- Modify: `test/fixtures/` as needed (a clock helper and the fake Stripe from Task 2)

**Interfaces:**
- Consumes: everything above, through the real entry points only: the signed Stripe webhook route, the owner's routes, the approvals route (`approve`), the public `/s/` routes, the daily cron (`runScheduled`), against fakes for Stripe and the mail transport on a fixed calendar.

- [ ] **Step 1: Write the failing flow test**, one scenario in this order, asserting after each step: a real signed Growth proposal with Care is deposit-paid by webhook (subscription rows planned, project started); BUILD reaches `design_approved` (a draft invoice and one approval for the 30%); approve it (one Stripe invoice, one mail); the paid webhook arrives twice (one `invoice_paid`); the cron reconciles with nothing duplicated; `site_finished` drafts the last 30%, left unpaid; the cron over 18 days walks the ladder (steps 1 to 4 each drafted once, each approved) and on day 14 places the hold and drafts one pause notice; a Claude step is not dispatched while held and a finished Care project makes no recurring task; the paid webhook lifts the hold and dispatch resumes in the same request; the build finishes, the Care subscription is proposed, approved, the client opens `/s/<token>`, starts Checkout, `checkout.session.completed` activates it, a cycle invoice fails then succeeds (past_due then active); a signed change order drafts its invoice, approval, Stripe invoice, and its paid webhook unlocks its tasks once; the Website Subscription path converts at month 24 on a fixed clock and an early cancel before then owes the balance.
- [ ] **Step 2: Run to verify failure, then fix what it finds.** Run: `npx vitest run test/billing-flow.test.ts`. Fix real defects in the code it exercises (a defect in the test is fixed in the test); any other test that breaks is a regression to fix.
- [ ] **Step 3: Write the open-items note** (`2026-11-plan-8-open-items.md`) in the form of Plan 7's: what was built; **Needs Logan** (apply 0057 before deploying; set `STRIPE_SECRET_KEY` and `STRIPE_WEBHOOK_SECRET`; in Stripe add the seven webhook events listed in Settings > Billing; set the invoice logo, brand colour, business details and payment methods (card and ACH) in the Stripe Dashboard under Branding and Settings; rehearse in Stripe test mode on a test lead: milestone, reminder, hold, Checkout; the Oregon review before any real subscription link; check Oregon auto-renewal and sales-tax rules); **Decisions for Logan** (every item in Scope decisions above, plus any that arose); **Known gaps**; **Rulings made during the run**.
- [ ] **Step 4: Run all.** Run: `npm test && npm run typecheck && npm run build`. Expected: PASS.
- [ ] **Step 5: Commit** — `git add -A && git commit -m "test(billing): end-to-end flow and Plan 8 open items"`
