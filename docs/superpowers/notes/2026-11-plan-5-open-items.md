# Plan 5 (close): open items after the build

Branch `feat/agency-os-close`, built 2026-11-19 by subagents (all on Sonnet). Migrations 0051-0053 (`0051_documents_config`, `0052_documents`, `0053_billing`). 3237 root tests (189 files), typecheck and build clean at the last verified run (after the final fix wave). Nothing is deployed, pushed, merged or migrated remotely.

What was built: a proposal and SOW generated from the deal's recap and frozen price snapshot (Settings → Documents holds the clause library, the late fee, the expiry and the lawyer-review record); a send approval that countersigns and mails the client link; a public client page at `<CLIENT_LINK_BASE>/p/<token>` with a typed-name e-signature, ESIGN consent, a SHA-256 of the exact content, and a signed PDF with an audit page; the signed copy by mail; a Stripe deposit invoice made on signing (card and ACH on Stripe's hosted page); the `/hooks/stripe` webhook that marks the invoice paid, moves the deal to Won and the lead to won; and proposal expiry, a Today follow-up and the deal timeline entries. Onboarding start, milestone and final invoices, subscriptions, reminders, change orders and the Care agreement are Phase 2 and are not built.

None of the browser-facing work was ever viewed in a browser by the builders: the Proposal tab on the Deal page, Settings → Documents, the client proposal page on a phone, and the PDF layout were built and tested in code only, and Stripe was only ever talked to through a fake. Expect layout and print fixes on the first real look. One end-to-end test (`test/close-flow.test.ts`) drives the real entry points (draft, send approval, approve, client page, sign, signed `invoice.paid` through `/hooks/stripe`) against fakes for Stripe, the mail transport and the PDF browser.

## Needs Logan
1. Apply remote migrations 0051-0053 in order, then deploy. Migrations first: the new worker reads columns and tables the old schema lacks. The deploy creates the `CLIENT_LIMITER` rate-limit binding (`namespace_id` 1003, 30 requests a minute per link and client IP, in `wrangler.jsonc`); without the binding, local runs are not limited.
2. Stripe account in **test mode** first. Set the Worker secrets `STRIPE_SECRET_KEY` (a restricted key with invoices, invoice items and customers write is enough) and `STRIPE_WEBHOOK_SECRET` (`npx wrangler secret put ...`). Add a webhook endpoint `https://<app host>/hooks/stripe` subscribed to exactly these events: `invoice.paid`, `invoice.voided`, `invoice.marked_uncollectible`, `invoice.payment_failed`. Turn on ACH (US bank account) in Stripe's payment-method settings and add the logo and colors under Branding. Check what Stripe Invoicing charges per paid invoice (spec §13) and note it here: ______.
3. Set `CLIENT_LINK_BASE` (for example `https://clients.sitelineweb.com`; https only, never `workers.dev` and never the cold-email host) and attach that hostname to the Worker as a custom domain. Open `/p/<anything>` there and confirm a 404 page, not an error. Until it is set, real sends are refused with "Set CLIENT_LINK_BASE".
4. Settings → Documents: read every clause. **Send them to an Oregon lawyer** (also ask about auto-renewal rules for the 24-month Subscription, sales-tax treatment, the late fee and the kill fee) and only then record the review in that page. Until then real sends are refused. The `payment_terms` wording that read as ambiguous next to the ownership clause was reworded in the final fix wave (clause library version 2), so give the lawyer the current text.
5. On a test lead with a recap: draft the proposal for each of the three options, read the preview, "Send a test to me", open the link on a phone (Safari) and a desktop, sign, check the signed copy mail and the PDF (page breaks, the audit page with both signatures and the hash), and that the Pay button opens Stripe's hosted invoice. The PDF needs the Browser Rendering binding; the page break before the audit page has never been rendered by a real browser.
6. Pay the deposit with Stripe's test card, then again on a second test lead with the test US bank account; confirm the deal moves to Won and the lead turns blocked in the conflict gate. Replay the webhook from the Stripe dashboard and confirm nothing changes.
7. Edit a package price after a recap and confirm the new proposal still shows the frozen price. Let a test proposal pass its expiry (set `expiryDays` to 7 and backdate in the dashboard console) and confirm the link shows the closed page.
8. Going live: use a FRESH lead for the first live deposit. The saved Stripe customer id (`stripe_customers`) is not tied to test or live mode, so a lead that paid a test deposit would send a test-mode customer id to live Stripe and fail. Then swap `STRIPE_SECRET_KEY` and `STRIPE_WEBHOOK_SECRET` to the live values and add the live webhook endpoint with the same four events.
9. Decide the items under "Decisions for Logan" below.

## Decisions for Logan
1. Deposit rules in `src/worker/documents/schedule.ts` (the `RULES` table): Quick Fix 100% at signing; Starter 50% at signing and 50% when the site is finished; Growth 40% at signing, 30% at design approved, 30% at site finished; Subscription, Care and Local SEO bill monthly (Care at launch when a site is built, at signing when not; Local SEO at kickoff). The spec gives only the Starter and Growth splits and "deposit before work starts"; the rest are the builder's calls. A monthly item with no setup fee prepays its first month at signing (ruling R5).
2. The late fee defaults to 1.5% a month (`lateFeePercentMonthly`). Change it in Settings → Documents, and have the lawyer confirm it.
3. Countersign by approving the send. Approving the `proposal.send` card signs as the provider (your name, "Approved for sending") at the moment it mails the link; there is no second step. Confirm that is enough, or add a separate countersign after the client signs.
4. Clause wording the implementer added that is not in spec §11: Care and Local SEO can be cancelled with 30 days' notice; Local SEO is month-to-month after its first term; the kill fee is computed on the remaining unpaid project price. Read these three with the lawyer.
5. The hourly rate shown in a proposal is read from the current catalog row, not frozen at recap, so changing the hourly rate after a recap changes the next proposal's rate. Freezing it needs the rate recorded in the snapshot.
6. When a proposal expires the deal stays at `proposal_sent`; it does not go back or to lost; moving it is your call.
7. The Stripe customer id saved for a lead (`stripe_customers`) is not tied to test or live mode. Use a fresh lead for the first live deposit (Needs Logan 8); a lead that already paid a test deposit would send a test-mode customer id to live Stripe.
8. Lead delete is blocked by any non-draft document, including void, expired and test copies, because signed records are never deleted (ESIGN retention). Archive the lead instead of deleting it.
9. The audit page's client email is the proposal's contact address (where the link was sent), not an address the signer proved; the page now labels it "Email the link was sent to". The signature itself is a typed name, the consent record, the IP, the user agent and the hash.

## Known gaps (decided, not fixed)

Clause library
- "30-minute blocks" is hardcoded outside the clause terms. (The `payment_terms` wording was reworded in the final fix wave: clause library version 2.)
- Documents.tsx shows `$0/hr` until `/packages` loads; number inputs on the Documents page cannot be cleared; the preview sets both `care_terms` and `care_opt_out`; `documentsProblem` is not tied to Save; no page test.

Builder and schedule
- The prepay-first-month rule is per item, not per option, so Starter + Care + Reviews add-on prepays Reviews (intended: only when nothing else is due at signing). May be fixed in the final wave; see "Final review results".
- `firstMonthPrepaid` with `startsOn` launch or kickoff has no documented meaning for Phase 2 billing.
- `canonicalJson` ignores `toJSON` and Date; `validateOptions` override covers `active` but not `publicOffer`; `CARE_KEYS` is duplicated; `freezeProposal` does not guard NaN `expiryDays`; zod checks clause ids, datetime precision and email loosely; some test gaps.
- The hourly rate is not frozen (decision 5). The approval preview is not byte-exact (placeholder link, no expiry sentence on a draft).
- Draft versions: the version-equality guarantee (document row versus `content.header.version`) holds for a single writer only; `createDraft` should take an expected version. No `formOf`/`editsOf` round-trip test through the real `buildProposal`; the form stays populated after a void; layering: the worker imports the client's `packagesView` dollars and the client imports worker `proposal.ts`/zod.

Storage
- Voided/expired documents also blocking lead delete is untested (the test named "a sent document and a void one" never voids); `deleteBusiness` called directly with a non-draft document is untested; `recordView` at the 10:00.000 boundary is unpinned and records rows on signed/void/expired documents (the route decides).
- `createDraft` reads the next version outside its batch (a raw SQLite error on a concurrent create); `markSent` does not check `provider.contentSha256` equals `contentSha256`; `token.ts` duplicates the reports' generator; the 409 message says "signed" but fires for any non-draft.

Rendering
- `termMonths` and `o.mode` are interpolated raw into the HTML (typed, so latent only); the escape test does not cover every field; the hash test uses one HASH for both; CRLF paragraphs; dates are shown in UTC.
- The `htmlToPdf` wiring line is untested (only the pure `pdfOptions` helper); `safeFileName` is exported from `routes/deck.ts` and `documents/` imports from `routes/`.

Owner API and approval
- Test-send seals the draft before mailing, so an SMTP failure leaves a live test document; a waiting `proposal.send` approval is not withdrawn in `sendTest` (untested).
- A retry is blocked if the client signs between the mail and the deal move.
- No test that a failing edit leaves the approval pending; the `voidProposal` comment is garbled.

Client page and sign
- The route validates the body before the token though a comment and a test title say otherwise, and parses the form twice; the consent text is rebuilt from the current constants at sign time (the hash does not cover it); a 429 on the first GET shows a generic error; a test gap (the deleted-deal branch). (The invisible-name hole, the unguarded read after a stored signature and the missing `proposal_viewed` entry were fixed in the final fix wave.)

Signed PDF
- `afterSign` is awaited inline in the sign POST (could be `waitUntil`); a module-level `rendererForTests` seam; the download does not re-verify `pdfSha256`.
- The signed-notice body says "on the deal" even if the PDF failed; the Download PDF link is always shown even if the PDF fails; `oneLine` is duplicated; no concurrent `ensureSignedPdf` test; the `stubPdfRenderer` fixture is a no-op in the Task 7 test files.

Stripe
- A failed step 2 or 3 of invoice creation leaves a draft invoice at Stripe; the retry reuses the same idempotency keys, but Stripe only honours a key for 24 hours (only step 2 failure is tested).
- The body is decoded then re-encoded for signing (a BOM or invalid UTF-8 fails closed); `stripe_events` is never pruned; the `Content-Length` branch of `readCapped` is untested; the "works without a session cookie" test is mostly a 503 check.
- `releaseEvent` and `finishEvent` are not fenced by the claim timestamp (a stale holder's failure can reset a newer claim; the only effect is another `onPaid` run).
- Void and uncollectible invoices, and a missing key, answer "unavailable" with no timeline note while the UI says the reason is on the timeline and offers an unusable "Try again".
- Concurrent first calls can get a Stripe 409 "request in progress" and write a false failure note (self-heals); the sign response waits for Stripe through `afterSign` (the call now times out after 15 s); page loads of an unpaid invoice older than 60 s make a live Stripe GET; `setStripeFetchForTests` is a module-level seam.
- `stripe_customers` is not tied to a Stripe mode (Needs Logan 8).

Deposit and Won
- `stopOutreach` writes its note again on a retry. The `deal_moved` marker is now written before the deal moves, so if the owner marks the deal lost in that instant the marker says "moved" though the deal is lost (the "check it" note is still written).
- Coverage gaps: the settle branch where the row is paid but the document is not, the re-check path asserting the deal reached won, and the uncollectible re-check.

Expiry and Today
- The expiry activity batch is not atomic with the `UPDATE`; `d.content.header.reference` is unguarded in the `.map` (use `?.header?.reference ?? d.id`).
- The candidate clause is not filtered to `doc.test = 0`; `openProposalsSentBefore` is not scoped to the candidate ids. (The expired-but-unswept document no longer shows on Today.)
- `activityView` keys "Proposal expired" off the detail text ending in ": expired".

## Rulings made during the run
- R1: `buildProposal` takes `packages: Package[]` (the versioned rows fetched with `getPackage(key, version)` for each snapshot entry) and derives snapshots with `snapshotOf`; it runs `validateOptions` with those rows mapped to `active: true`, so a package deactivated after the sale cannot block a proposal while platform, care-multiplicity and discount rules still apply. The plan text said PackageSnapshot. Cost if wrong: a type tweak.
- R2: Task 4 also adds labels for the five new activity kinds in `src/client/activityView.ts` and its pinning test. Cost if wrong: none.
- R3: `sendProblems` always applies the legal gate and always refuses `doc.test` ("test documents go out with Send a test only"); the test-send route does its own limited checks (mailbox, own address). Cost if wrong: none.
- R4: Task 11 adds `proposal_follow_up` to `TODAY_KINDS` in `today.ts` following the existing kinds; the plan's pointer to booking items was wrong. Cost if wrong: none.
- R5: A monthly item with no setup fee prepays its first month at signing. Cost if wrong: a deposit that is larger or smaller than intended on Care-style options (see the per-item gap above).
- R6: Same-moment milestones merge, and a milestone's id is its `dueOn`. Cost if wrong: a schedule shows one line where two were expected.
- R7: `optionTotals` takes `Pick<Package, ...>` instead of a full Package. Cost if wrong: a type tweak. (The plan's "plus discounts" sign wording was off and was corrected.)
- R8: A replaced draft reuses its version number, and `content.header.version` must equal the document row's version; this holds for a single writer only (see Owner API gaps). Cost if wrong: a skipped or duplicated version number under concurrent edits.
- R9: Task 6 fix round bundled two minors: withdraw the send approval before the edit is written, and a blank `your_name` or `contact_email` is a send problem; plus excluded `proposal.send` from the MCP `propose_approval` so an agent cannot author the card. Cost if wrong: an agent cannot propose a proposal send.
- R10: A view is recorded only while the document is `sent` or `viewed`. Cost if wrong: a missing view row on a signed or closed link.
- R11: `afterSign` runs only on a new signature and never again on the idempotent path, so each step has its own recovery: the PDF is lazy (`ensureSignedPdf` on download and from the owner route), the deposit has the page's pay button and the Deal tab retry, and the signed copy is best-effort once. Cost if wrong: a signed client with no mailed copy and no PDF until someone asks for it.
- R12: Stripe event dedupe uses a lease: `processed_at` stays NULL until the work is done, a 2-minute lease allows re-claim, a concurrent delivery answers 503, a failure releases the claim by resetting `received_at`, and rows are never deleted. Also `pending_invoice_items_behavior=exclude` on invoices and a state-guarded mismatch write. Cost if wrong: an event could be handled twice after a 2-minute stall (handlers are idempotent) or be retried late.
- Task 5 implementer: an extra voided/expired band is shown on the PDF/preview. Cost if wrong: a cosmetic band.
- Task 6 implementer: test-send seals the draft as a sent `test=1` document; the platform is read from `deal.notes` then the audit; the approval's `record_type` is `deal`; `proposal.send` is excluded from Approve all. Cost if wrong: a test document lingers (see Owner API gaps), or a one-click bulk send was wanted.
- Task 7 implementer: `requireAuth` exempts `GET /p/<seg>` and `POST /p/<seg>/sign` (and `GET /p/<seg>/pdf` in Task 8) so the client needs no session. No `proposal_viewed` activity is written. Cost if wrong: a wider public surface than intended (security-reviewed in the final review).
- Task 9 implementer: Stripe event dedupe inserts first and deletes the row on failure (replaced by R12); `onPaid` must be idempotent; `GET /api/documents/config` was created for the Settings page. Cost if wrong: none.
- Task 10 implementer: invoice creation uses fixed idempotency keys per document and business (`customer:<business>`, `deposit:<document>:invoice|item|finalize`), a test document with a live key is refused, and an open invoice older than 60 s is re-checked against Stripe. Cost if wrong: an extra Stripe GET on page load, or a deposit that cannot be re-created inside the key's 24-hour window.
- No deploy, no remote migrations, no push: outside the worktree, Logan decides. Cost if wrong: none; these are the steps above.
- Implementers and reviewers (and the final review) ran on Sonnet per Logan's standing preference, although the skill prefers the most capable model. Cost if wrong: a shallower cross-cutting review.

## Final review results
Verdict: Ready after fixes. The whole-branch review found three Important problems, all fixed in one fix wave on this branch (3237 tests after; see the task 12 report for per-item evidence).

Important findings, fixed:
- I1. Signing a test copy bricked the deal and mailed the real prospect. A signed test copy could never be voided, blocked every later draft ("already signed"), and `afterSign` mailed "Your signed proposal" to the contact address on the proposal (the real prospect) with no approval. Now a test copy can be voided in any state (its signature rows are kept), a signed test copy no longer blocks drafting a real proposal, and a test copy's signing mails only the owner, with a notice marked "[Test]". The deposit step is unchanged (a test copy with a test-mode key still makes a test invoice; with a live key it is refused).
- I2. A lost deal still had a live, signable, payable proposal. Moving a deal to lost now voids its sent or viewed proposals (and withdraws a waiting send approval, with a timeline entry), and `signProposal` and the client page treat a sent or viewed proposal on a lost, won or missing deal as closed. A signed proposal is a record and is never closed this way.
- I3. The signer-name check passed invisible names (two U+3164 fillers, a word joiner pair, soft hyphens, Hangul and Khmer fillers, the braille blank). It now rejects every `\p{Cf}` character except ZWNJ/ZWJ plus the listed fillers, and needs at least two visible letters; the client page and the server share the one check.

Cheap items, fixed:
- A signature that is stored survives a failed read afterwards: the first read sits inside the guarded section and a failed page rebuild answers "signed" instead of a 500.
- A paid, signed real proposal now wins the deal from any open stage, not only `proposal_sent`; the `deal_moved` marker is written before the move (no spurious "check it" note) and the lead becomes won only after the deal has moved ("lead won, deal lost" cannot arise). A deal already lost stays lost with the note.
- One `showDraftBanner` rule for the client page, the owner preview and the PDF: a test copy always, an unsigned document while the lawyer's review is missing, a signed real document never.
- `public/_headers`: `X-Frame-Options: DENY` and `frame-ancestors 'none'` on `/p` and `/p/*`.
- The audit page labels the client's email "Email the link was sent to".
- `env.ts` names `clients.sitelineweb.com`; a `proposal_viewed` timeline entry is written on the first view only (never for a test copy).
- `setPdf` records an error only while no PDF is stored; Stripe calls time out after 15 s ("Stripe did not respond"); the Today follow-up hides an expired-but-unswept proposal; the `payment_terms` clause was reworded (clause library version 2); the signer's name is cut to 60 characters in the timeline entry.

Left deliberately (known gaps, shipped with this note):
- M2. The saved Stripe customer id is not tied to test or live mode: use a fresh lead for the first live deposit (decision 7).
- M6. Lead delete is blocked by any non-draft document, including void, expired and test copies: archive instead (decision 8).
- M9. A helper is duplicated (`oneLine`, `safeFileName` living in `routes/deck.ts`); harmless, not worth the churn.
- T3. The prepay-first-month rule is per item, not per option (see the Builder and schedule gap).
- `afterSign` stays inline in the sign POST (not `waitUntil`): the client waits for the PDF, the mail and the Stripe call, which is bounded now that Stripe times out at 15 s.
- Every other parked minor in "Known gaps" above.
