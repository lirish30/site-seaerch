# Plan 4 (sales): open items after the build

Branch `feat/agency-os-sales`, built 2026-11-18/19 by subagents (all on Sonnet). Migrations 0045-0050. 2816 root tests, typecheck and build clean at the last verified run. Nothing is deployed, pushed, merged or migrated remotely.

None of the browser-facing work was ever viewed in a browser by the builders: the booking page, the Pipeline board, the Deal page and its tabs, the Calls card on the lead page, the deck layout and the PDF output were built and tested in code only. Expect layout and print fixes on the first real look.

## Needs Logan
1. Apply remote migrations 0045-0050 in order, then deploy. Migrations first: the new worker reads columns and tables the old schema lacks. The deploy creates the `BOOKING_LIMITER` rate-limit binding (`namespace_id` 1002, 30 requests a minute per report link and client IP, in `wrangler.jsonc`) and registers the `*/5 * * * *` cron. `wrangler.jsonc` now lists three cron triggers (`17 13 * * *`, `*/15 * * * *`, `*/5 * * * *`); check your account's cron trigger limit allows three on this worker, and confirm all three show in the dashboard after deploy.
2. Settings > Google: reconnect and accept the two new Calendar scopes (`calendar.events`, `calendar.freebusy`). Both are required; one alone leaves booking off. The OAuth app must be in production mode (a test-mode app expires the refresh token after 7 days), and Google shows a one-time "unverified app" warning. Settings should then show booking as available.
3. Settings > Booking: enter real availability windows, the budget choices on the booking form, and the minimum engagement (the lowest budget choice cannot be under it).
4. Settings > Packages: check every price and inclusion against the approved spec section 8 table. Care and Local SEO must be separate lines; Starter and Subscription must match the spec; no old Web Kit prices anywhere. Prices in the app come only from this catalog.
5. Book a test call from a test lead's report link (`/r/<token>/book`) with a second Google account, on a phone (Safari) and on a desktop. Check: the event appears on the calendar with a Meet link; the confirmation arrives from the main mailbox (SPF/DKIM/DMARC in the headers); the 24-hour, 60-minute and 10-minute reminders each arrive once (book one call 26 hours out and another 25 minutes out, so all three windows are exercised). Then cancel from the email link: the event disappears and the slot returns. Mark the test lead do-not-contact and confirm its page no longer books.
6. Run `/work-the-queue` for `call.prep` (queued by a booking) and `call.recap` (queued from the Recap tab after you save call notes) (both suggest Sonnet). Judge whether the prep reads like a usable call script and whether the recap's three options are sensible.
7. Present a deck for a real or test lead on a screen share and download the PDF. Check slide fit, the notes panel, the PDF page breaks, and that the deck shows the frozen prices. PDF export needs the Browser Rendering binding (501 without it).
8. Sales number sanity check, once: the deck's total for each of the three options against the catalog, including the "from" wording on totals.

## Decisions for Logan
1. Setup discounts. The plan lets the one-time packages (Quick Fix, Starter, Growth) take a "setup discount" up to their full price. Spec section 8 says discounts apply only to setup fees. The deck then prints "(less $X off setup)" on Quick Fix, which has no setup fee. Left as the plan wrote it. Either confirm that discounting a one-time price is fine, or restrict `setupDiscountCents` in `src/worker/sales/options.ts` to packages that have a setup fee.
2. Confirmation and reminder emails go out without an approval. This is the one decided exception to "nothing is sent without your approval" (they are transactional mail to someone who just booked). If you want every message gated, remove the send in `src/worker/booking/mail.ts`.
3. Migration 0045 was edited after it was written, to take a price out of the Care summary prose. It has not been applied anywhere, so this is safe, but Care's yearly price ($1,290 a year) now exists nowhere in the catalog. Only the $129 monthly line does. Add a yearly line if you sell it.
4. The 10-minute reminder window is as long as the 5-minute tick, so a reminder whose send fails is effectively not retried. The spec pins the tick at 5 minutes; widening the window or ticking faster is your call.
5. The video's baked-in call to action still uses the old `booking_url` setting until videos are re-rendered. New and re-rendered videos use the per-lead booking page.

## Known gaps (decided, not fixed)

Booking
- Guest cancel of a booking with no stored calendar event id needs a working calendar token (3-line best-effort fix).
- A deal created by a failed booking attempt stays open at `booked`; a rollback that fails twice is only logged; there is no sweeper for crashed bookings.
- Per-lead booking cap counts Logan's own recommendation-meeting rows too.
- The 10-minute window equals the tick (see decision 4); a failed SMTP send is only `console.error`, with up to 3 do-not-contact notes per booking.
- Confirmation SMTP is awaited inside the booking request (latency); confirmation via `ctx.waitUntil` and caching of `GET /book` were deferred. A booking page read still costs a token refresh and a free/busy call per GET (the rate limit is the guard).
- `GET /api/bookings` loads 90 days and filters in JS. Do-not-contact status is visible to a guest probing a link only as the same 404 as any dead link (comment, not a leak).
- The cancel page says "call" before cancelling, and for the 30-minute recommendation meeting.
- Slot computation repeats Intl work (public page and every book attempt); a window edge inside a DST gap has a wrong comment; 24:00 is not an expressible window end; saving "{}" stores expanded defaults.
- `requestId` dedupes only the Meet conference, not the event; the deterministic event id covers retries. No test asserts the `deleteEvent` error text never holds the token.

Deals and Pipeline
- A held recommendation meeting reopens "Offer two times" and `nextActions` still marks it done after a guest cancel.
- A started discovery booking on a deal that left `booked` shows "needs an outcome" until marked No-show.
- `/api/deals/:id/move` accepts `proposal_sent` and `won`; Plan 5 owns those moves.
- Board is read-only; `GET /api/deals` returns the full JSON blobs; `createDeal` race branch untested; no test pins the `deal_*` entries in `NOT_CONTACT` in `today.ts`.
- "Call done" is not atomic (one batch would fix it). `DealChip` has no `?business=` filter. No DNC badge on the Calls card.
- `savePackage` race returns 500 (single user); Packages shows a generic 400 message; options tests are loose on the discount-monthly pattern.

Deck
- A frozen deck still shows a drift banner wording meant for drafts; `priceDrift` can flag a false drift on an hourly alternative price.
- `pricedItems` drops items missing from the snapshot silently (should throw); `problemsOf` gives an unclassified finding a positional label; an unknown `leadType` falls back to `wp_few_broken`, which includes Care.
- `options[1]` is assumed to be the recommended option (versus `recommendedOptionId`); the agenda lists "What I found" even when that slide is dropped; no work-sample images.
- Tests: the allow-list is hard-coded; the `other_platform` Care test passes through `KEEP` alone; no freeze-on-closed-deal 409 test; no Deck page test.

Claude queue
- The currency guard covers all free text but cannot see spelled-out amounts ("four thousand dollars").
- `Object.fromEntries` key collisions in prep `questionNotes` and recap options let a duplicate key overwrite an item before the currency check; prep is Logan-facing only, and duplicate recap option ids are caught later by `optionProblems`.
- The call-prep panel polls forever after "Draft prep again"; "Draft recap again" overwrites edited options without a confirm.
- The worker imports `formatPrice` from `client/packagesView` (pure, safe) and one `as never` cast remains. Print edge cases (collapsed `<details>`, absolute panel) need a browser check.

Client and UI
- `zod` ships in the client bundle because `bookingView` imports `DEFAULT_CONFIG` as a value; a zod-free defaults module would fix it.
- Stale "fifteen pages" comment in the settings sidebar.

Tests
- Missing: null-token confirmation text, `setBookingEvent` and `moveDeal` rollback, weekday that differs from the UTC weekday, "now" with a different UTC and local date, a non-zero buffer boundary. A leftover `void NOTES` in `booking-followup.test.ts`. One unrelated mcp throttle test failed once and passed on re-run.

## Rulings made during the run
- Plan 4 starts from main after Plan 3 merged (PR #24); the branch was cut from origin/main, nothing stacked. Cost if wrong: none.
- No deploy, no remote migrations, no push: outside the worktree, Logan decides. Cost if wrong: none; these are the steps above.
- Task 7 renders return `{ subject, body }` (plain text) instead of the plan's `{subject,text,html}`, because `sendEmail` composes html itself through `composeOutbound`. Cost if wrong: a rendering difference in the confirmation mail, caught by the header check in step 5.
- Task 10 deck routes live in `routes/deck.ts`, mounted at `/api/deals/:id/deck.html|deck.pdf|deck/freeze`. Cost if wrong: none; a route move.
- Task 1 (baseline) was run by the controller; no implementer dispatched. Cost if wrong: none.
- Task 4: booking needs both Calendar scopes, not either, because spec 9.4 needs free/busy and event create/delete; the plan's "lacks both" check was a defect. Cost if wrong: an extra reconnect prompt.
- Task 4: free/busy fails closed when `calendars.primary.errors` is present (load-bearing for double-booking safety), with the Meet URL taken from `entryPoints` and `hasCalendarScope` moved to `google/oauth.ts` to break a circular import. Cost if wrong: a slot is hidden when Google reports an error.
- Task 6: cancel works for any valid cancel token regardless of report expiry or revocation, without the conflict gate, and only while the start is in the future; a DNC or won guest must still be able to release the slot. Also a deterministic Google event id with best-effort delete when `createEvent` fails. Cost if wrong: a stale cancel link could cancel a booking it should not (it cannot create contact).
- Task 7: a reminder is due only if the booking existed when its window opened (`createdAt <= start - offset`). Cost if wrong: a skipped, redundant reminder.
- Task 9: unsaved call notes survive tab switches (form state lifted to the Deal page); the platform select prefills from `audit.platform` with a hint; "Call done" stops and shows the error when the form is invalid. Cost if wrong: none beyond UI.
- Task 9: the recommendation meeting can be booked from `booked`, because the Web Kit books the follow-up before the call is marked done. Cost if wrong: a deal can carry a recommendation booking one stage early.
- Task 9 (for Task 10): editing options (`PUT /options`) or accepting a new recap clears `deck_frozen_at`, so the next view or PDF freezes the new prices. Cost if wrong: a deck shown after an edit would carry old prices.
- Task 10: a frozen deck's inclusions and summaries come from `getPackage(db, key, version)` for each snapshot entry (current packages only when the snapshot is empty), and the freeze is stamped after the PDF renders, with a 502 on PDF failure. Cost if wrong: a deck prints a package description that changed since freezing.
- Final review reviewer ran on Sonnet per Logan's standing preference, although the skill prefers the most capable model. Cost if wrong: a shallower cross-cutting review.
- Final fix wave scope: per-lead booking cap, name and URL rejection, the `BOOKING_LIMITER` binding (login-limiter pattern), recommendation rebook, owner cancel and no-show endpoints and UI, "from" in totals, a currency guard on all Claude free text with an owner-number allowance, and editing unapplied migration 0045 to drop "$1,290 a year", plus six minors. Cost if wrong: unreviewed code in the wave beyond the scoped re-review, which was clean.
- Not in the wave: widening the 10-minute reminder window (spec pins 5), a crashed-booking sweeper, a DNC badge on the Calls card, `DealChip ?business=`, a panel polling cap, confirmation via `ctx.waitUntil` and `GET /book` caching. Cost if wrong: the gaps listed above.
- One-time packages accept a setup discount up to their full price, as the plan wrote it; spec section 8 says setup fees only (decision 1 above). Cost if wrong: a Quick Fix deck prints "less $X off setup" on a package with no setup fee.
