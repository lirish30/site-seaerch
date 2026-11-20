# Plan 7 (projects, SOPs, tasks, time and change orders): open items after the build

Branch `feat/agency-os-projects`, built 2026-11-19 by subagents (all on Sonnet). Two migrations, `0055_projects` and `0056_projects_sweep`. Nothing is deployed, pushed, merged or migrated remotely.

What was built: when a signed proposal's deposit is paid (the Stripe webhook), the app copies an SOP template into a project for each job sold. A Starter, Growth or website subscription starts BUILD, a Quick Fix starts QUICKFIX, and Care starts CARE-0 (at once when nothing is being built, otherwise when the build finishes). The steps of the template become tasks owned by you, by Claude, or by Claude drafting for your approval. A step is ready when what it needs is done and it is in the project's current phase; ready Claude steps are queued for Claude Code (at most 5 at once, and only for real projects), and a drafts step comes back as a review card. Logan can work any step by hand; a gated step (going live, for example) is refused with the open steps named. Two steps mark milestones, `design_approved` and `site_finished`. There is one timer app-wide, a timesheet week grid, and a profit card on each project. Small extra work becomes a change order: Claude can flag one over MCP, you draft and send it through an approval, the client signs it on `<CLIENT_LINK_BASE>/c/<token>`, and its tasks stay locked until it is signed and paid. The daily cron also makes this week's and month's recurring Care tasks (CARE-1, CARE-4), starts any paid proposal that never got its project, expires old change orders and saves a stale timer, and the Friday onboarding update now says what finished and what is next in the client's own words. The owner side has a Projects page, a project page (tasks, time, SOP, change orders), My tasks, a timesheet, a timer in the rail, a Deal page with "Start projects" and "Start a test project", and Settings > SOPs and Settings > Work.

One end-to-end test (`test/projects-flow.test.ts`) drives the real entry points (the signed `invoice.paid` webhook, the owner's routes, the MCP tools `propose_approval`, `next_claude_task` and `complete_claude_task`, the approvals route, the client's change-order page and signing, the daily cron) against fakes for Stripe, the mail transport and the PDF browser, on a fixed calendar. It found one real defect (a real change order could never be sent to a client who had paid, see Ruling 12), now fixed. Every page was only checked by typecheck, build and stubbed or static browser harnesses, never against the real Worker.

## Needs Logan
1. Apply BOTH new remote migrations, `0055_projects` and `0056_projects_sweep`, before deploying. Migrations first: the new Worker reads tables and a column the old schema lacks. Plan 8's migration numbers start after 0056.
2. Read every seed SOP step as the person who will do it: BUILD, QUICKFIX, CARE-0, CARE-1 and CARE-4 in `src/worker/sop/seeds.ts`. The titles, done-when text and client summaries are shipped wording, written fresh and never reviewed by you. A client summary is what the client reads in the Friday email, so read those most carefully. Edit them in Settings > SOPs (a template you edit is never overwritten).
3. Set your cost rate in Settings > Work (it starts at 0, which counts your time as free, so the profit card shows nothing useful until it is set).
4. Rehearse on a TEST lead, never a real client: press "Start a test project" on the Deal page, walk a phase, run a timer, then draft a test change order, send it (it goes only to your own address, marked "[Test]"), and sign it on a phone. A test project never goes to Claude on its own; use "Ask Claude" on one task to try the loop.
5. Confirm the Oregon legal review before any real change order. A real change order is refused until the review is recorded in Settings > Documents, exactly like a proposal.
6. Confirm `CLIENT_LINK_BASE` (already set for proposals and onboarding) serves `/c/<anything>` as a plain 404 page, not an error, and that the custom domain routes `/c/*` to the Worker. A change order cannot be sent until it is set.
7. Remember what was and was not checked. Every new page (Projects, Project, My tasks, Timesheet, the timer and the rail, the Deal buttons, Settings > SOPs and > Work, the Care hint) was only checked by typecheck, build and stubbed or static browser harnesses, never against the real Worker and real data. The mobile rail popovers were measured on a static copy of the rail markup only. The change-order client page layout was never seen in a browser. Expect layout fixes on the first real look, and check the phone signing flow in particular.

## Decisions for Logan
1. Milestone steps: `design_approved` is on BUILD 4.5 ("client OK on the design direction") and `site_finished` is on 6.8 ("client OK to launch", before launch, not after). Plan 8 will invoice from them. Tying `site_finished` to the client's go-ahead rather than to going live was my call.
2. The change-order rate defaults to the current `hourly` package price and is editable on each order. The panel shows the Care client's rate (`care.altPriceCents`) as a hint on every project. Which rate a Care client should get is yours to confirm.
3. Claude dispatch is automatic for real projects only, never for test ones (a rehearsal must not spend subscription time unasked). At most 5 Claude jobs are in flight at once, and a step whose jobs have failed or expired twice stops being sent on its own (the cap is `MAX_AUTO_RETRIES = 2`; "Ask Claude" always works and Today shows the step as needing you).
4. The timer: one running timer app-wide (starting another saves the first), a timer left running is saved at 12 hours (`timerCapMinutes`, 60 to 1440 in Settings > Work) with a note, and an entry under 30 seconds is dropped.
5. The timesheet week starts on Monday (a setting).
6. Skip rules: a skipped step satisfies `requires` only if the step is marked skippable, so a non-skippable step can never be skipped past. A skip needs a reason of 3 to 300 characters.
7. Care starts when the build finishes (CARE-0), and a finished Care project stays "live" so its weekly and monthly work keeps being made and dispatched. A change order for a Care client's extra work goes on the open Care onboarding project, because a done build refuses new change orders.
8. There is no SOP yet for Local SEO, Reviews or the other Care and SEO templates (only CARE-0, CARE-1 and CARE-4 exist). A Local SEO sale leaves one timeline note ("no SOP for Local SEO yet") and starts nothing.
9. Change-order tasks unlock only when the order is signed AND paid. Until Plan 8 invoices them, "Mark paid" (confirm dialog, logged) records the money; Plan 8's webhook must call `markChangeOrderPaid` (the same function).
10. BUILD 4.3 ("turn the client's feedback into a task list") is owned by you, not Claude, because Claude would otherwise run it before any feedback exists.
11. A change order may be drafted and sent only on an active (or paused) project. A finished build takes none; the extra work goes on Care.
12. Waiting on the client is derived, not stored: a project whose onboarding has been silent for 14 days dispatches nothing and says so, and the next client write (or the next daily sweep after it) clears it.

## Known gaps (decided, not fixed)

Storage and SOP
- The zod messages for a bad step list do not name the step key (`sop/model.ts`).
- `ensureSeedSops` has a comment that says 14 batches; it is 5 templates.
- `templatesForPackages(...).find` takes the first of two active templates that cover the same package.
- `insertTasks({ ignoreDuplicates })` uses INSERT OR IGNORE, so it also swallows a NOT NULL or CHECK violation, not only a duplicate.
- Editing a template never touches an existing project, and nothing tells you which projects came from an older version.

Lifecycle and gates
- Replay-safe by design but not atomic: `checkReady` reads then writes, `checkRequires` and `updateTask` are not one transaction (TOCTOU), a lost race can leave a stopped timer, ad-hoc task positions can collide under concurrent adds, and `by` (who finished a task) is not stored.
- Hooks are at-most-once. The call whose statement flipped the milestone or the project runs `onMilestone` or `onProjectDone`; a crash between that statement and the hook loses it. A hook's own error is logged and swallowed. The tasks-changed hook can fire twice under true concurrency (harmless).
- `settle` attaches the CARE-1 and CARE-4 cadences whenever a `care_onboarding` project is done (idempotent), and a finished Care project is "live".
- `unlockIfReady` ignores the project's status (a paused or cancelled project's change-order tasks still unlock).
- A step skipped with a reason writes the reason as a system comment in the same batch (fixed); reopening never un-reaches a milestone and never reopens a finished project (by design).

Claude steps and dispatch
- Orphaned jobs (a job whose step moved on) are not counted against the cap of 5, so the cap can be exceeded slightly.
- `sopReview.execute` also accepts a step that is `in_progress`; `requestClaudeStep` posts the note before it enqueues (a retry can duplicate the note); there is no test for `enqueue` throwing.
- An app-proposed review card is stored as `drafted_by: 'mcp'` and filed under record type `task` (its "Open" link redirects through `/tasks/:id`).
- A leftover pending `sop.review` card after a send-back can still be approved while the step is in progress if two database calls both failed; approving checks `card.id === task.reviewApprovalId`, which is the cleanup candidate.
- `failedJobCount` is a lifetime count per step; the reclaim of a stranded step is narrowed to `updated_at <= done_at` (a residual window remains).
- `apply` on a project cancelled in the instant between the check and the write is a tiny TOCTOU. `sop.review` refuses only paused and cancelled projects, not done ones (intended, so an approval retry can finish the last step).
- Cancelling a project does not cancel Claude jobs already queued: they go stale when claimed and give the step back.
- The project name goes into Claude's trusted instructions; it is `<client name>: <template name>`, and the client name is scraped, so it is cleaned, one-lined and clipped to 80 characters.

Start on payment
- `onboardingId` is linked only when the project is created, not on a replay.
- A start that fails after payment leaves a timeline note that promises "Start projects on the deal" and the daily sweep; both now exist. Documents that can never get a project (Local SEO only, no active template) sit in the sweep's oldest-first rotation and are re-tried after the others; a new document can wait behind unstamped unstartable ones for up to n/25 days.

Change orders
- `syncTasks` is not atomic (two concurrent first runs of a draft approval); `execute` may overwrite a late edit; `withdrawSendApprovals` uses `new Date()`.
- `cleanEmail` deleting an embedded newline can fuse two addresses (`a@b.test\nc@d.test` becomes `a@b.testc@d.test`); it is still a single address, so no header injection.
- A retry of an already-sent order re-checks the real-send settings and can throw if your name or email was blanked after the send; the `voidDraftOrSent` docstring is stale; references can repeat across two document versions with the same template key (unlikely).
- An expired change order's locked tasks stay locked (as with a declined one); voiding clears them. Opening a change order is not on the timeline (decline and sign are).
- The client page: no focus management when the decline form opens; if `afterSigned` fails the owner's "signed" line is missing until a retry; "Open until" is a date while the real expiry is an instant; the decline reason `.slice(0, 80)` can cut a surrogate pair; the decline UPDATE and its log are not one batch (it heals on replay).

Client page
- The change-order page layout was never seen in a browser (phone or desktop). The name field and checkboxes were sized for phones by a fix round, from the CSS only.

Owner API
- `/me/tasks` includes test projects (and says so).
- Profit: "sold" is the proposal's schedule milestones plus signed change orders; "paid" is the deal's paid invoices plus paid change orders, and a Care project that follows a build on the same proposal carries neither.
- The mark-paid timeline line reads "paid (outside Stripe)"; some routes validate the body before they resolve the id (400 before 404); the delete message for a locked change-order task says "Skip it instead", which is refused (void the order).
- A finished (done) Care onboarding project can no longer be paused or stopped (PATCH refuses a done project and the UI hides Pause and Cancel unless it is active or paused). A Care client who leaves has no stop for the cadences and dispatch except deleting cadence rows or switching the templates off.
- `draftChangeOrder` and send refuse a done project, so extra work for a Care client whose Care project is finished cannot get a change order (it needs a `kind === 'care_onboarding'` carve-out). The UI gates (`ProjectSopTab`, `ChangeOrdersPanel`, `Project.tsx`) still test active or paused, and the Projects page lists a done Care project under Done with no Next line.

Owner UI
- Not built: editing or deleting a time entry in the UI (the routes exist), a "new custom project" button (the route exists), editing a draft change order in the UI (void and redraft; the PATCH route exists).
- The SOP tab can edit and remove steps but cannot add or move them, and `POST /projects/:id/tasks` makes non-step ad-hoc tasks, so a template pushed back from a project can only show removed or changed steps.
- The timesheet's add-time picker lists only done tasks and Claude steps and defaults to the first day of the week; background polls and the timer fail silently; responses can arrive out of order; a credential refusal shows at the top of the row; the timer poll ignores a hidden tab; some link targets are under 44px; `openRequirements` duplicates the server's `unmetRequirements`; the Timesheet and Project pages have no component tests (only the view helpers do).
- "Saved for this project" after Save-as-template can never show (the step editor remounts on `updatedAt`); the push-to-template preview is a frozen snapshot while the 20-second poll changes tasks; there is a magic string "no change to the steps" that must match `diffSummary`; Deal's `canStartTest` depends on the proposal fetch; the Work page's reset effect can normalize the box mid-typing when an edit returns the draft from dirty to clean; the SOP key-clash list is a snapshot from page load (a stale tab could still replace a template).
- Verified only on a static copy of the rail markup with the built CSS (the mobile rail popovers), never the running app.

Sweep, Today and Friday
- A newly attached or resumed cadence creates a task that is already overdue (due last Wednesday) and a Today item.
- No DST test for the weekly and monthly period keys; the cron-throws test asserts only that it resolves.
- The Friday "done this week" window is an elapsed 7 days (no time zone), and the lines are the step's client summary, never its title.

Plan 8 carry-forwards (Plan 8 must read these)
- `onMilestone` and `onProjectDone` are at-most-once. Plan 8 must reconcile (a sweep of reached milestones and done projects with no invoice yet), not rely on the hooks alone.
- Profit's "paid" is deal-scoped (`paidTotalForDeal`). A Stripe-paid change order would double count unless Plan 8 scopes paid to the document and excludes change-order invoices.
- A done Care onboarding project cannot be paused (`setProjectStatus` never moves done to paused), so Plan 8's "pause on an invoice 14 days overdue" cannot stop ongoing Care cadences and dispatch. Plan 8 needs another stop (a flag on the cadence or the project).
- `markChangeOrderPaid(env, id, { via: "stripe", now })` is the call for Plan 8's webhook; it is idempotent and unlocks the tasks once.
- Plan 8 numbers its migration after 0056.

## Rulings made during the run
1. R1 (pre-flight): migration `0055_projects` holds every table; the Task 1 implementer derived the columns from the Interfaces blocks of Tasks 2, 3 and 7. Later tasks could amend the (unapplied) migration if a column was missing.
2. R2: the timezone accessor is `parseConfig(settings.booking_config).timezone` (`booking/config.ts`), not a `getBookingConfig`.
3. R3: the migration file is `migrations/0055_projects.sql`.
4. R4 (Task 1): BUILD 4.3 (feedback to tasks) must not auto-dispatch before feedback exists, so its owner is `logan`.
5. R5 (Task 1): the extras `change_order_views` table and the partial unique `uq_tasks_step` are accepted.
6. R6 (Task 5): `reopenTask` clears `claudeTaskId` and `reviewApprovalId`, and a Claude result applies only when the task is `in_progress` and `task.claudeTaskId` equals the queue job id.
7. R7 (Task 5): the project name is `<client name>: <template name>`, accepted because the build one-lines and clips it (120 characters, client name 80).
8. R8 (Task 7): a change order's reference is `<proposal ref>-<TEMPLATEKEY|kind>-CO<seq>`, and the order id's first 8 characters go in every timeline line about it.
9. R9 (Task 7): a change order may be voided from declined or expired (it clears the locked tasks); a real send needs `your_name` and `contact_email`; the view is recorded only for a sent or viewed order; the contact email is a single address with newlines stripped.
10. R10 (Task 12): the separate migration `0056_projects_sweep` (`documents.projects_checked_at`, for rotation of the start sweep) is accepted; Plan 8 numbers after it.
11. R11 (Task 12): one predicate `projectIsLive` is active, or done AND `care_onboarding`; the sweep, dispatch, `sop.step` build and apply, `sop.review`, send-back and Today all use it, so a finished Care onboarding keeps its recurring work.
12. R12 (Task 13, a real defect the flow test found): `sendProblems` ran the conflict gate with its "existing client (marked won)" rule, and payment marks the lead won, so a real change order could never be sent to a client who had paid. A change order now ignores the "client" conflict source and still blocks a do-not-contact or suppression hit (`changeorders/service.ts`, with a regression test).
13. Review-round decisions, one line each:
    - Task 4: completing or skipping a step is replay-safe (milestone, project finish and Care cadences are repaired by repeating the request, and a database error part-way answers "saved, repeat to finish").
    - Task 5: a step Claude cannot finish is retried automatically at most twice, a paused project hands its in-progress Claude steps back, the step's checklist so far goes into the untrusted block only, and a pending review card is refreshed rather than doubled.
    - Task 6: a start that fails after payment writes a timeline note, and `startProjectsForPaidDocuments` is shared by the owner route and the daily sweep; a project with no tasks is healed on replay.
    - Task 8: the client page's name input is at least 16px and checkbox rows at least 44px on phones, the signer's consent text is no longer split on blank lines, and a decline is logged (`change_order_declined`).
    - Task 9: reopening a voided change order's task is refused, a cancelled or paused project's already-claimed job no longer applies and its waiting review and send approvals are cleaned up, send-back re-asks Claude before it rejects the old card, and a credential-looking project name is refused.
    - Task 10: the mobile top-bar rail no longer overflows at 900px and below, and its Account and Bell popovers are anchored inside the viewport.
    - Task 11: a new SOP template whose key already exists no longer silently overwrites it (a key clash is named), Settings > Work shows the stored text after Discard, and Save is disabled while a field is invalid.
    - Task 12: the change-order expiry line reads "<ref> (<id>): expired", a recurring task's description carries each step's done-when, and the recurring Claude tasks of a finished Care project are dispatched and not given back.
    - Task 13: the flow test puts the change order on the open Care project, because a done build refuses one (Decision 11).
14. Implementers and reviewers ran on Sonnet per your standing preference, although the skill prefers the most capable model. Cost if wrong: a shallower cross-cutting review.
