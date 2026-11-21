# Plan 10 (meetings, MCP read and act tools, money dashboard): open items after the build

Branch `feat/agency-os-meetings-mcp-money`, built 2026-11-20 by subagents: the implementers and the task reviewers on Sonnet, the final whole-branch review on Opus. Two migrations, `0059_meetings` (the `meetings` table) and `0060_money_config` (the money settings). Nothing is deployed, pushed, merged or migrated remotely.

What was built, in four parts.

Meetily sync. The 15-minute cron queues a `meetily.sync` job for the Mac helper whenever a booking or a Google Calendar event started in the last 72 hours (events belong to a business by an attendee's email, or the domain of a client's site; free-mail domains never count; a rehearsal client never gets a window). The helper reads Meetily's database read-only (only the `meetings`, `transcripts` and `summary_processes` tables, never its keys or licence), matches a recording to a window by time alone (rule R8: it must overlap the booked time itself, and more than half of it must lie inside the window widened by 15 minutes; two equally good windows means no match, and a recording that matches nothing never leaves the Mac), holds back anything Meetily touched in the last 5 minutes or that is still being summarized, and uploads only the matches in one file to the job's one output key. The Worker believes the helper for the recording's words and dates only: which business and booking a meeting belongs to comes from the window it asked about, a recording naming a window nobody asked for, or that fails R8 against the window it names, is dropped, and the file is capped at 12 MB and 50 000 lines. Each new meeting is a row, a transcript in R2, a timeline line and a `meeting.summarize` task; a repeat changes nothing.

Summaries and approvals. Claude works `meeting.summarize` over MCP: a summary, decisions, action items, at most three possible change orders and a follow-up email. The result is refused (and nothing is saved) when any text has a login, a dollar sign, a price or a link. Logan's action items become tasks on the client's newest live, real project (the client's own go nowhere); each possible change order becomes a pending `change_order.draft` approval; the follow-up is a pending `meeting.followup` approval, and it is the only mail the whole flow can send, on approval, to the booking's contact (or the lead's point of contact). A client's meetings list is on the client page (a Meetings panel with the summary, notes, "Summarize again" and a lazy transcript); the Mac helper page has a Meetily line (last sync, failed or pending). A recorded discovery call can also feed the call recap (the transcript only, never Meetily's notes, and no dollar figure from it).

MCP read and act tools. The `agency-os` server has 25 tools. New reads: `search_clients`, `get_client`, `get_site`, `list_projects`, `get_project`, `list_open_tasks`, `get_deal`, `get_timeline`, `list_invoices`, `list_meetings`, `get_meeting` (the transcript only with `include_transcript`, cut at 20 000 characters) and `get_money_summary`. New acts: `run_audit`, `log_time`, `add_task` (Logan's own to-dos only), `add_task_comment` and `add_note`. No tool returns a vault item name, an access note, a client's messages or onboarding answers, a token or a Stripe id (a recording's transcript is returned only by `get_meeting` with `include_transcript`); `list_approvals` and `propose_approval` now show a view with the client's link tokens cut to a prefix and no payload; `get_meeting` shows Meetily's notes (the owner decided so) and no other tool does.

Money dashboard. `/money` (and `GET /api/money`, and the MCP `get_money_summary`, one function behind all three) shows cash received this month and the last six, what is owed by age with the oldest unpaid invoices, MRR and churn, signed work booked and not billed, profit per project (from the cost rate in Settings > Work), the ten best clients by cash paid next to their MRR, the freedom number (a monthly recurring target in cents, default $5,000, set on the page) and running costs against the cap. Money is integer cents, dates and months are counted in the booking time zone (a payment at 11:30 pm on Dec 31 in Los Angeles is December), and test clients, test rows and draft, void and cancelled rows are left out of every figure. An empty database gives zeros and nulls, never NaN.

One end-to-end test (`test/meetings-money-flow.test.ts`) drives the real entry points (the 15-minute cron, the `/helper` routes with a device token, the owner's routes under `/api`, the MCP route, the approvals route) against fakes for the mail transport and the PDF browser, on a fixed calendar (Los Angeles, 1 December 2026, 10:30). It tells one story: a client with a Care subscription, a paid deposit and a call booked 90 minutes ago; the cron queues one `meetily.sync` job (a second tick queues nothing) whose window says only when and for which business; the test plays the helper (claims the job, uploads one matched recording and one with a made-up window key to the job's own output key, is refused any other key, completes with `{ scanned, matched, key }`); the meeting is on `GET /api/meetings?businessId=` once, the stray recording left no row and no R2 object, and none of its text is in the meetings list JSON, the R2 keys or the output of `get_client`, `get_meeting` and `get_money_summary` (that is all the test checks; it does not search the database), and the sync file is deleted; Claude works the summary task through `next_claude_task` (the transcript is in the untrusted block and nowhere else) and `complete_claude_task` (a result with a price is refused as a tool error and changes nothing; the real one is accepted); a task for Logan, a `change_order.draft` approval and a `meeting.followup` approval then exist and the fake transport has seen NOTHING; approving the follow-up through the approvals route sends exactly one mail to the booking's contact (a second approve sends none, the change order stays pending); `get_client`, `get_meeting` and `get_money_summary` through MCP show no vault name, access note, subscription token, Stripe id or transcript (Meetily's notes only in `get_meeting`, the transcript only with `include_transcript`); and `GET /api/money` shows the client's paid deposit, MRR, lifetime value and freedom progress and none of a test client's, with every number finite (the test walks the dashboard and compares the route's and the MCP tool's output with it, since JSON hides a NaN as null). A second test with only a test client's data gives zeros and nulls on the page and in the MCP tool. The flow test found no defect in the code it exercises; the whole-branch review found the matching defect (R8, below). Every page (`/money`, the client Meetings panel, the Meetily line) was only checked by typecheck, build, unit tests and component helpers, never against the real Worker, a real session or real data, and the helper was only run against a fixture database, never against a real Meetily.

Full run on this branch after the final fix wave: `npm test` 291 files, 5 111 tests; `npm run test:helper` 11 files, 154 tests; `npm run typecheck` and `npm run build` clean. Only the known timing flakes failed: `billing-flow` timed out (5 s) in both full runs and `projects-flow` in one; both pass alone (see the flakes at the end).

## Needs Logan
1. Apply the new remote migrations `0059_meetings` and `0060_money_config` before deploying. Migrations first: the new Worker reads a table and a setting the old schema lacks (check with `wrangler d1 migrations list` before you apply anything).
2. Update and restart the Mac helper so it knows `meetily.sync` (see `helper/README.md`, "Meetily"). If Meetily's database is not at `~/Library/Application Support/com.meetily.ai/meeting_minutes.sqlite`, set `meetilyDb` in the helper's config. The helper needs read access to `~/Library/Application Support/com.meetily.ai` (macOS may ask once), and Node 22.18 or newer for the built-in `node:sqlite`.
3. Record a real test call in Meetily and book the same time in the app, so a real recording matches a real window. This is the only check of the helper against a real Meetily recording. The controller verified on your real database that Meetily's file is in WAL mode and that `summary_processes.result` has a `markdown` key (the helper also copes with plain text); what has never happened is the helper itself running against that real file (the tests use a fixture database, and the WAL test a checkpointed WAL). If the sync says "Meetily is busy with its database", try again after the recording is saved.
4. Check that the Google Calendar connection can list events (the `calendar.events` scope is already asked for bookings) or that you are happy with windows from bookings alone. Without a usable Google connection the sync logs one line and uses bookings only; a call you made without booking it in the app then has no window and stays on the Mac.
5. Open `/money`, a client page's Meetings panel and Settings > Mac helper (the Meetily line) on the real Worker, at phone width as well as desktop. The stat tiles on `/money` should be 2 x 2 on a phone (the implementer's choice; a single column was the other reading). Expect layout fixes on the first real look.
6. Add the `agency-os` MCP server's new tools to your Claude Code permissions if you allow-list them by name (25 tools now).
7. Deploy is not done.

## Decisions for Logan

The eight calls the plan made:

1. Matching is by time only, on the Mac (Meetily records no attendees). The Worker supplies windows from bookings and Google Calendar events; an event belongs to a business when an attendee's email equals a person's email, or the attendee's email domain equals a client site's domain (free-mail domains never count; an email two businesses share matches nobody). The plan said a meeting inside a window plus or minus 15 minutes matches; that rule was replaced by R8 (below). Two equally good windows still means no match.
2. A meeting is sent only after Meetily has not touched it for 5 minutes, and only if it started in the last 72 hours.
3. Churn counts explicit cancellations only (`status = 'cancelled'`); a subscription that reaches the end of its term (`ended`) is planned and is not churn.
4. Lifetime value is what the client has actually paid (real, paid invoices), shown next to their MRR. No projection.
5. "Booked, not billed" is signed one-time money (proposal milestones and signed change orders) minus its open, failed or paid invoices. Subscriptions are MRR and are not in it.
6. The freedom number is a monthly recurring target in cents, default 500 000 ($5,000 MRR, from the plan to leave Webfor), set on the Money page.
7. MCP `attach_file` (spec section 9.13 "attach files") is deferred: no record in the app has a file attachment today, so there is nothing for it to attach to. `add_note` covers text.
8. Cut line (spec section 12, six-week rule), not used: nothing was dropped. If the branch had to shrink, Task 7 (a recorded discovery call feeding the call recap) was to go first, then the Money page (keeping its route and the MCP tool).

R8, found by the final whole-branch review and NEEDING YOUR SIGN-OFF: a recording matches a booking or calendar window only when BOTH hold: (1) it overlaps the booked time itself by a positive amount, and (2) more than half of the recording lies inside the window widened by 15 minutes on each side. This replaces the plan's "inside a window plus or minus 15 minutes", which uploaded a neighbouring recording: a client call booked 10:00 to 10:30 right after a Webfor stand-up 9:30 to 10:00 widened to 9:45 to 10:45, so the stand-up matched, was filed under the client and Claude drafted a follow-up about it. Back-to-back calls are the normal case, and spec section 9.10 says an unmatched meeting never leaves the Mac. Under R8 a recording that ends exactly when the call starts (or starts when it ends) does not match, nor does a long one that only touches the edge; a call that starts 5 minutes late and runs 10 over does. The helper and the Worker apply the same two conditions (the Worker again on what the helper uploads); a zero-length recording and a tie between two windows match nothing. Costs: a call that starts more than a few minutes outside its booked slot, or runs very long, stays on the Mac and does not sync (you can still book the real time or add it by hand). If you want it looser or stricter, the rule is one small function on each side.

The final fix wave also: kept the booked-not-billed rows to clients with something left (no more $0.00 rows, so the empty state shows), looked up client names in chunks of 50 (no more 500 on `/money` and `get_money_summary` above about 90 clients), put the client name on each overdue invoice, made `redactLinks` cut a token followed by a comma, semicolon, colon, exclamation mark, asterisk, question mark or full stop, made the meeting summary keep the start and the end of a long transcript (as the call recap already did), made an action-item title 120 characters everywhere, cleaned the follow-up subject in the preview and the mail, made an email two businesses share match nobody, hid "Summarize again" while a summary is queued, made the call recap instructions consistent about figures from a recording, added two indexes to migration 0059, and fixed the flow test's vacuous NaN checks.

The rulings made while building (each is plain: what, and what it costs):

- R1. `GET /meetings/sync-status` is registered before `GET /meetings/:id`, because a route with a parameter registered first would take "sync-status" for an id. Costs nothing; a 404 on the Meetily status line if it is ever reordered.
- R2. "Summarize again" works only for a meeting that failed, or one that was received and has no open summary task. A summarized meeting answers 409: a second summary would duplicate its tasks and approvals, and saving a summary only moves a received or failed meeting. Costs: you cannot re-summarize a finished meeting.
- R3. `get_timeline` for a project returns that project's own agent actions plus its business's activity (activity is stored per business, not per project). Costs: a project's timeline is a little noisy.
- R4. A meeting window exists for any real (non-test) business with a booking, a lead with a booked discovery call too, not only won clients: discovery-call recordings of leads are wanted by the call recap. Costs nothing: a lead's meeting is still only uploaded when it matches.
- R5. The call recap reuses the transcript reader the meetings use (no second reader), and a deal tells the page whether it has a recording.
- R6. Figures a prospect said in a recording are NOT treated as the owner's figures: a recap built from a recording alone may carry no dollar amount. A price said on a call cannot be quoted back automatically (you edit the recap). Costs: you retype a price the prospect named; the gain is that neither a catalog price nor an injected one can reach the prospect's deck through a transcript. One test, "does this deal have a readable recording", is shared by the route, the deal page, the build and the apply, so they cannot disagree.
- R7. MCP `add_task` can create only your own to-dos (`logan`). `claude` and `claude_drafts` owners are refused, because a task owned by Claude is dispatched to the queue at once, so text an agent read could start an unreviewed chain of Claude work. Costs: Claude cannot give itself work; you assign it in the app.
- Meeting result limits: the change order inside a meeting summary uses the same limits as a `change_order.draft` approval (title at most 120 characters, summary 1 500, reason 600, 0.25 to 40 hours in quarter hours), so a result that passes is always one the approval kind accepts.
- Meetily's notes are not given to the call recap; only the transcript is. The recap with no notes defaults the platform to "other", so a Care package is refused until the notes say WordPress.
- A meeting whose transcript is over the sync budget is recorded without the dropped lines rather than refused (a trade-off accepted for the 10 MB helper budget).
- The approvals views changed for every client: `list_approvals` and `propose_approval` now return a preview with client link tokens cut to a prefix (`/o/[link]`) and no payload. This also covers the older tools, not only the new ones.
- Stat tiles on `/money` are 2 x 2 on a phone and "booked, not billed" shows only the per-client `cents` (the booked and billed pieces do not always reconcile to it row by row).

## Known gaps (decided, not fixed)

Meetily helper
- A Meetily timestamp with no offset is read as local time (it should be UTC).
- The catch-all error text says "Close Meetily" for errors that are not about the database being busy.
- The helper reads the whole `meetings` table (no date filter in the query).
- A tie between duplicate or mirrored windows blocks a match; the Worker de-duplicates identical windows, but two different windows at the same time still tie by design.
- More than 50 matched meetings in one pass upload the oldest 50 and leave the rest to the next sync; the 80 MB upload cap is not budgeted, only the 10 MB helper budget.
- A static `node:sqlite` import prints Node's SQLite warning on every helper command on older Node.
- Missing tests: the tie at handler level, the 20 000-line cap, that a thrown error carries no unmatched text, the `doctor` line, and the single-snapshot guarantee; the WAL test uses a checkpointed WAL; an unparseable summary `updated_at` is ignored.

Deleting and storage
- Deleting a client leaves its transcripts (R2 `meetings/<id>/transcript.json`) and the sync files of failed jobs in R2.
- A crash between the R2 put and the row insert leaves an orphan transcript (random id per attempt), and so can the put-then-delete race path when two requests record the same meeting.
- `GET /api/deals/:id` reads and parses the whole transcript (up to about 10 MB) to compute `hasRecording`.

Data layer and types
- `listMeetings` does not clamp its `limit`; `readSummary` is strict, so a stored summary that no longer fits the schema reads as no summary.
- `FullScanResult.error` is typed as a string, the `est_minutes` bounds are loose, and the day-default test accepts today or yesterday.

Worker sync and windows
- There is no server guard for a still-recording meeting (see below); `meetingForBooking` takes only the latest meeting and `lastBookingFor` the newest booking.
- A recording that crashes between its R2 write and its row leaves an orphan transcript object (the object id is random per attempt).
- There is no server check for a still-recording meeting (an end time in the future or past the window's end plus slack); only the helper holds those back.
- Two businesses with overlapping windows cannot be told apart on the Worker (a comment says so).
- Owner-declined calendar events are still windows; the calendar page cap (4 pages of 250) silently truncates; the attendee index is built inside the Google try block.

Summaries
- The link refusal only catches `http(s)://` and `www.`, not `mailto:` or a bare domain; a change order's summary and reason are not checked for links.
- `sendEmail` with `skipLimits` skips the `linkProblem` check on the follow-up send path.
- Change orders on a retry with a changed result are de-duplicated by their index, so a changed result leaves stale pending cards.
- The transcript is parsed whole before it is cut; an old summary that no longer fits the stricter schema reads as no summary; the open-task de-duplication is by title only.
- A failed meeting's status stays `failed` while a new summary task is queued (the panel says so and hides the button, but the badge does not change).
- `lastBookingFor` takes the newest discovery booking, so a recorded held call followed by a later booking hides its recording; a booking's meeting is the latest one only (a call that dropped and rejoined loses part 1); `hasRecording` is read once at page load.
- Judgement calls made in the MCP read tools: site notes are left out of `get_site`, `list_open_tasks` treats a client as `waiting_client`, and `get_meeting` returns Meetily's notes.

MCP
- Id lookups (`get_client`, `get_site`, `get_deal`, `get_meeting`, `get_project`, `get_timeline`) do not leave out test clients (the list tools do).
- The subscription link approval's preview carries no token before approval. Redaction through activity and agent actions is unit-tested on `redactLinks` but not through the tools.
- Validation errors and zod refusals are not logged as agent actions (the older tools do the same).
- `log_time` has no per-day minute cap and lets the billable flag be overridden (an inflated hourly invoice draft still waits behind an approval); `run_audit` has no per-lead cooldown; `add_note` echoes a bad id in its not-found sentence.
- `search_clients` loads every client and site on each call; the meetings list joins to businesses from the data layer (a layering inversion).

Money
- The per-row "booked, not billed" figures do not reconcile row by row (billed can exceed booked on one row); the page shows `cents` only.
- The booked-not-billed `bookedCents` and `billedCents` are raw sums; the page shows only `cents`.
- `reminderBase` is imported from a module that has an import side effect.
- The money settings route takes one key (a second key later must merge the stored config).
- Churn ignores term ends, lifetime value is paid-to-date, and profit uses the cost rate in Settings > Work and shows no margin when it is 0.
- There is no attach-file MCP tool (Decision 7).

UI
- The Meetings panel says "the summary shows here" as if it refreshed live; its `aria-controls` points to an id that does not exist while collapsed; the change-order lines on a summary go stale after you decide them; the list without a `businessId` returns everyone's.
- On `/money` the Refresh button and a settings save can race, the dollar parser is duplicated, the zone label wording is loose, and the page has no component test.

Tests
- The full suite has flakes that are timing or data, not this plan (each passes alone): `billing-flow` and `billing-sweep` time out (5 s) under full-suite load, `projects-flow` has a timing flake, the MCP rate-limit test can trip when it runs alongside other MCP tests, and `sites-onboarding-items` ('password: abc') fails when a random UUID contains "abc". On this branch's final runs `billing-flow` timed out in both full runs and passed alone.
- The dashboard test `test/money-dashboard.test.ts` depends on the initial `money_config` value; the dashboard-versus-billing-summary comparison could flake around midnight (it compares AR with the billing summary using the real clock).
