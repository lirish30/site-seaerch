# Plan 6 (client onboarding): open items after the build

Branch `feat/agency-os-onboarding`, built 2026-11-19 by subagents (all on Sonnet). One migration, `0054_onboarding`. Nothing is deployed, pushed, merged or migrated remotely.

What was built: when a signed proposal's deposit is paid (the Stripe webhook), the app starts one onboarding for the deal and queues a welcome email for your approval. Approving it mails the client a link, `<CLIENT_LINK_BASE>/o/<token>`, to a page with no login: a questionnaire (answers autosave, then submit once, then lock) and a checklist of things to send, as text or as uploads (jpg, jpeg, png, webp, gif, heic, pdf, docx, txt) into the private R2 `RAW` bucket. The Deal page has an Onboarding panel: the welcome video link, the kickoff date, extra checklist items, accept / not needed / ask again on each item, file downloads (attachments only), and the link controls (revoke, new link, close). "Start a test onboarding" rehearses the whole thing on a deal that has only a signed test proposal, and mails only your own address. The daily sweep drafts reminders (after 2, 4, 7 and 10 days of silence) and a Friday update as approvals, notes a client silent for 14 days on the lead's timeline, and Today shows items waiting for your review, a client gone quiet, and an unsent welcome. Nothing is sent to a client without an approval.

One end-to-end test (`test/onboarding-flow.test.ts`) drives the real entry points (the signed `invoice.paid` webhook, the approvals route, the client's page, answers and a real multipart upload into the R2 test binding, the owner routes, `/api/today`, the daily cron) against fakes for Stripe, the mail transport and the PDF browser, on a fixed calendar. The panel and the client page were only checked by typecheck, build and mocked-fetch browser runs; they were never run against the real Worker plus R2.

## Needs Logan
1. Apply the new remote migration `0054_onboarding` before deploying. Migrations first: the new Worker reads tables the old schema lacks.
2. Confirm `CLIENT_LINK_BASE` (already set for proposals) serves `/o/<anything>` as a 404 page, not an error, and that the custom domain routes `/o/*` to the Worker. Until it is set, a welcome cannot be approved ("Set CLIENT_LINK_BASE").
3. Record a welcome video of a minute or less, host it, and paste its https link on the Deal's Onboarding panel. A welcome still waiting for approval shows the new link in its preview.
4. Run "Start a test onboarding" on a TEST lead, never on a deal with a real proposal: a test onboarding cannot be removed from its deal, and it would block the real one for good (the button refuses a deal with a real proposal). Then: approve the welcome, open the link on a phone, answer the questions, upload photos from the camera roll including a HEIC, check the owner panel, download a file, and look at the Friday and reminder approvals the daily sweep drafts.
5. Read every question (`src/worker/onboarding/templates.ts`, `QUESTIONS`) and every item instruction (`ITEM_TEMPLATES`) as the client will read them. They are shipped wording, not reviewed wording.
6. Remember what was and was not checked: the panel and the client page were only checked by typecheck, build and mocked-fetch browser runs, never against the real Worker and R2. Expect layout fixes on the first real look, and check the phone upload flow in particular (camera roll, HEIC, a slow connection).

## Decisions for Logan
1. Reminders are approvals, not automatic. Each reminder and each Friday update lands in your approvals queue and is sent only when you approve it. The alternative is to send them automatically; the cost is a client mailed without a look.
2. The reminder ladder is 2, 4, 7 and 10 days of silence (`REMINDER_DAYS` in `src/worker/onboarding/schedule.ts`). After a cron outage the sweep drafts only the highest level due, not a burst.
3. Phase due dates are 7 days (phase 1) and 14 days (phase 2) after the welcome goes out; the questionnaire is due after 2 days (`PHASE_DUE_DAYS`, `QUESTIONNAIRE_DUE_DAYS`).
4. A `light` onboarding (the questions only, no content items) is used for Quick Fix, Care-only and Local SEO-only deals. Only the site builds get the content checklist.
5. File caps: jpg, jpeg, png, webp, gif, heic, pdf, docx and txt only; 20 MB a file, 10 files an item, 250 MB an onboarding (`UPLOAD_LIMITS` in `src/worker/onboarding/files.ts`).
6. Whether the Friday email waits for projects. The "done / next" half of the Friday update is Plan 7, so today the Friday email lists only what the client has sent and what is still open, with no project progress.
7. Answers lock after the client submits the questionnaire, and there is no owner unlock. A client who needs to change an answer has to tell you.
8. A reminder and a Friday update can both be queued on the same day (the ladder and the Friday rule are independent), so a silent client can have two approvals waiting.
9. A test onboarding can never be removed from its deal (the `deal_id` is unique and there is no delete). The panel refuses to start one on a deal with a real proposal for that reason.

## Known gaps (decided, not fixed)

Storage
- `setRevoked` overwrites `revokedAt` on a second revoke (keep the first time?); `saveItemText` does not check the item is a text item and does nothing on an unknown id; `addCustomItem` position tie under concurrency, and a raw `UNIQUE(onboarding_id,key)` error the caller must catch; `markWelcomeSent` overwrites a custom item's `due_at`; missing tests: `removeFile` on an accepted item, `getOnboardingByToken` for a token that never existed.
- Flake note: `test/campaigns.test.ts` failed twice once under load and passed on rerun.

Templates and mail
- An invalid time zone silently yields no Friday nudges while `mail.ts` falls back to UTC (they disagree; validate the zone or share the fallback); a dead `waiting` variable in `schedule.ts` (about line 202); `nudgesDue` returns every passed level, and a Friday welcome qualifies for the same-day Friday nudge; test gap: nothing pins that `<` and `>` in client text reach the plain body (the sender must escape); U+2028/U+2029 are not stripped by `cleanText`; a non-string required answer gives two problems.
- HAND-OFF to Task 8: `nudgesDue` returns every passed reminder level, so the sweep must dedupe by key and draft only the HIGHEST unsent level (no backlog burst after a cron outage); `renderReminder` needs `lastClientActivityAt: o.lastClientActivityAt ?? o.welcomeSentAt` and `tz`, or level 3 names no date; `renderFriday` has optional `clientName`/`contactName`. (Task 8 implemented the highest-level-only rule; see `src/worker/onboarding/sweep.ts`.)

Start and welcome
- The retry guards in `onboardingWelcome.ts` (lines about 173-178: closed, revoked, mailbox) re-run before `sendEmail` short-circuits, so a crash after the send plus a changed state leaves the due dates unwritten (skip the guards when an outbound row for the approval already sent); `sentAt = now()` at a retry shifts the due dates; a real welcome logs the send twice (the email note and `onboarding_welcome`); a stale `sendEmail` `skipLimits` comment (`send.ts` about lines 161-162); a test onboarding requires the document's contact email though it mails only the owner; a weak assertion at `test/onboarding-start.test.ts` about line 578; missing tests: a test onboarding with an empty `settings.contact_email`, a failing `markWelcomeSent`.

Client API
- The answers lock and the `closedAt` check are read-then-write (an autosave can land after a concurrent submit; guard it in SQL); `saveItemText` and `touchClient` are not batched; a PUT with empty or only-unknown answers still stamps activity and can log `onboarding_resumed` (it resets the silence clock); 422 and 400 both answer a generic "invalid body" plus the ids (the client cannot tell a credential refusal from a bad value); the `onboarding_received` dedupe is keyed on the item label, not its id; the page GET runs `listFiles` once per files item (N queries); test noise from a bare `submitQuestionnaire` call near `test/onboarding-public.test.ts:774`; header assertions only on the 200, 400 and 404 answers, and no 413 test for item text.
- HAND-OFF to Task 5/6: writes answer `{ok:true}` and the page refetches the GET after a submit; the limiter allows 30 requests a minute per link and IP, so UI autosave must debounce; Task 5 may reuse the exported `endsSilence`, `logResumed` and `logReceived` from `onboarding/public.ts`.

Uploads
- No test that refused uploads (415, 413, 409) leave `last_client_activity_at` null and log nothing; about 3-4x the file size in memory at the peak of a 20 MiB upload (the isolate has 128 MB); the claimed-type gate (`files.ts` lines about 167-168) refuses odd browser types such as `image/jpg` though the stored type is chosen by the server; a heic upload accepts any ISO-BMFF `ftyp` (an mp4 renamed `.heic` passes; check the brand); `safeFileName` cuts at 480 characters before reading the extension and can split a surrogate at 120; an oversize Content-Length on a dead token answers 413, not 404; no test for `removeClientFile` stamping activity or resuming.
- Limits (the 11th file is 409, the 250 MB total is 413) are checked then written, not in one transaction; the rate limiter bounds it.
- HAND-OFF to Task 7: the download route MUST send `Content-Disposition: attachment` with an escaped `filename*`, `X-Content-Type-Options: nosniff` and the stored (server-chosen) content type; a polyglot file is the residual risk the design accepts on that basis. The UI must expose "Ask again" (status waiting), since a client upload to an accepted item is 409. (The route sends those headers and `test/onboarding-flow.test.ts` asserts them against a real upload; the "Ask again" control in the panel was not checked in a browser.)

Client UI
- `FileBox` seeds its files from props once and never resyncs; the upload loop on `retry` breaks without telling the client that the remaining files were skipped; a disabled button drops focus; no `useSaver` tests (debounce, merge, retry, order) beyond what the fix rounds added; a rejection with no `fields` drops the delta with no retry.
- `inFlight = null` after a paced send is unconditional; a keepalive PUT with several answers is rejected whole if one is refused; the "Sent. Thank you." text flips after the refetch.
- The second request after a partial rejection (`rest`) is not gated or superseded, so it can be lost on close or land after a newer keepalive; a flush after a supersede returns `clean=false` until the keepalive settles (submit is briefly blocked); a started PUT of A then a keepalive of B has no server-side ordering (it needs a sequence or version number), the same as before the fix; the superseded-job no-fetch rule is tested only at the predicate level.

Owner routes and panel
- `console.error` is muted in the routes test and never asserted; `OwnerFields` typed state is not resynced on Refresh and Save re-sends both fields; the "Open Home to approve" link shows after the approval; `POST /welcome` can create a second approval after an approved-but-failed one (the UI hides it); revoke and new link are allowed on a closed onboarding; the panel's rendering was never viewed (check it in the real app); the Deal tab visibility rule is untested.
- Residual ordering: a signed TEST copy, then a test onboarding, then a real proposal drafted, signed and paid on the same deal is still blocked (a loud note, no recovery); consider blocking `createDraft`/`markSent` of a real proposal when the deal has a test onboarding, or adding a delete route. A welcome still pending cannot be approved after a revoke until a new link is made (the confirm warns).

Sweep
- A crash window between `recordNudge` and `createApproval`: a null `approval_id` cannot be told apart from an intentional lower-level mark (the same if `forgetNudge` fails); a reminder and a Friday update on the same day both queue (decision 8); raw SQL `recordedKeys` in `sweep.ts` (the sweep now reads them through `listNudgeKeys`); test onboardings write "no reply for 14 days: back-of-queue" notes to the real lead's timeline.
- Supersession counts any newer key with an approval id regardless of that approval's status (reject the newer one, then approve the older one, and the older is skipped); the skip note text is prefixed "reminder skipped:" even for a Friday update.

Today
- "Welcome email is waiting for you" ignores the welcome approval's state (a rejected or never-created one shows daily until done or snoozed); the suppressed-lead test does not prove the lead is suppressed; no explicit open-but-complete onboarding test; `listOpenItems` loads test onboardings' items needlessly.
- Accepted at Task 9: an archived lead shows nothing on Today (like `proposal_follow_up`); `onboarding_*` kinds were not added to `NOT_CONTACT` (`onboarding_received` is real client contact); received-but-unaccepted items show at any stage.

## Rulings made during the run
1. R1 (pre-flight): the Task 1 file list omits `routes/leads.ts` but a step edits it; allowed, the lead-delete guard lives there.
2. R2 (pre-flight): the welcome link is the client link on `/o/`, but `documents/mail.ts` `clientLink` hardcodes `/p/`; Task 3 adds `src/worker/onboarding/link.ts` `onboardingLink(base, token)` (the guest link base plus `/o/<token>`), and Tasks 7 and 8 reuse it. Cost if wrong: none.
3. R3 (pre-flight): a Task 4 test named a route that does not exist until Task 7; instead assert that an existing authed route (for example `GET /api/leads`) is still 401 without a session.
4. R4 (pre-flight): answers lock (409) after submit. Intended; an owner unlock is out of scope (Decisions 7).
5. Task 1: `addFile` sets the item to `received` unconditionally (the brief's text: a new file on an accepted or not-applicable item must resurface for owner review); `saveItemText` keeps accepted and not-applicable as the brief says; `newToken` clears `revokedAt`; `listOpenOnboardings` filters `closed_at IS NULL`.
6. R5: Task 7 also adds `POST /deals/:id/onboarding/start` (a real start for a deal whose latest signed non-test document is paid; calls `startOnboarding`; idempotent), because Task 3 writes only a timeline note when `CLIENT_LINK_BASE` or the contact email is missing at payment and nothing retries; the resend path calls `createWelcomeApproval` directly (a rejected or approved approval is not recreated by `startOnboarding`).
7. R6: the test welcome's subject prefix is "[Test] " and no `businessId` is accepted (matches `sendTest`); a real welcome skips `checkConflict` (the lead is already won), which is correct.
8. R7: `onboarding.welcome` is added to the bulk-approve exclusion in `src/client/approvalsView.ts` (`canBulkApprove`) as part of Task 7, because the welcome preview asks you to add a video link first.
9. R8: a client upload to an `accepted` item is 409 (accepted means settled; you use "Ask again" (status waiting) to reopen it; the Task 7 UI must expose it). Limit statuses: the 11th file is 409 and the 250 MB total is 413. Concern: the limits are checked then written, not transactional (the rate limiter bounds it): deferred.
10. Implementers and reviewers ran on Sonnet per Logan's standing preference, although the skill prefers the most capable model. Cost if wrong: a shallower cross-cutting review.
