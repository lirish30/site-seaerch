# Plan 16 (Measure and show: Search Console, Analytics, strategy memo, Business Profile numbers, report video): open items after the build

Branch `feat/agency-os-measure`, cut from `main` at `a6379dc` (PR #41), built 2026-11-22 by subagents (Sonnet implementers and most reviewers, Opus for the reviews of Tasks 4, 5, 6, 9, 10, 11, 12, the whole-branch review and its re-review). 19 commits, 112+ files. One migration, `0066_traffic` (four tables and one partial unique index; CREATE only). The `agency-os` MCP server now has **33 tools** (`get_traffic` is new). Last full run at the head: typecheck and build clean, 395 of 396 test files, only the known `billing-flow` 5-second timeout failed (it passes alone). **Nothing was pushed, merged, migrated or deployed by this build.**

## What was never run for real

Every Google call (Search Console, Analytics Data and Admin, Business Profile), the HyperFrames render and the helper handler, the Traffic panel, the strategy memo section and public page, and the two report pages' new sections were exercised only with fakes, typecheck and build. Expect the first real run to find at least one wrong request or response shape. The most likely first failures, by API:

- **Search Console:** a disabled API (the sentence now says to turn the API on), or the client adding your account to a URL-prefix property while the domain property is the one linked.
- **Analytics:** two separate APIs to enable (Data and Admin); a property with more than 40 siblings (use the typed property id field); the `keyEvents` metric in the same call as sessions (fails loud, see R6).
- **Business Profile:** before Google approves API access the project has quota 0 and Google answers 429, which the app words as "did not answer, tried again tomorrow", so the month burns its 5 attempts.
- **OAuth:** an app left in "Testing" loses refresh tokens after 7 days.

## Order of rollout (the one thing that must not be skipped)

1. Record a D1 Time Travel bookmark, then apply `0066_traffic` remotely **before** deploying. If the Worker goes out first, every Care and Local SEO public report page fails (the video lookup reads `report_videos`) and every report build fails (it reads `traffic_months`).
2. Enable the Search Console API, Google Analytics Data API and Google Analytics Admin API in the Google Cloud project; check the OAuth consent screen is published, not "Testing".
3. Deploy, then press Reconnect in Settings > Google (grants the two new read scopes).
4. Per client: ask them to add the connected Google account as a viewer (Search Console "Restricted" or higher, Analytics "Viewer"), then on the client page use Traffic > Find properties > Link.
5. Business Profile numbers stay off until Google approves your API access, you press the profile consent (`/api/google/connect?profile=1`), and you paste each location id. The report video needs the Mac helper running and its first rehearsal (helper/README.md, "Report video").

## Calls still open for Logan

Pull day 4 and report wait until day 7 (so a linked client's report arrives on the 4th to 7th, not the 1st to 3rd). What the client sees (clicks, impressions, position, up to 5 searches and 5 pages, visits, organic visits, "tracked actions", channels). The strategy memo's shape and its "Draft strategy memo" button. The silent report video and its fixed caption. Whether subdomain-only sites (blog.example.com) need a URL-prefix property (they do under R8).

## Rulings made during the build (each with its cost if wrong)

- R1: `GET /api/clients/:id/traffic` lives in routes/clients.ts (`clientTraffic` in traffic/panel.ts). Cost: move a route.
- R2: memo revoke is `POST /api/clients/:id/strategy-memos/:memoId/revoke`. Cost: rename a route.
- R3: Task 9 created `queue/strategyMemo.ts` as a no-op; Task 10 gave it its body. Cost: none.
- R4: `cancelMemo` added so "Try again" works (a collecting memo otherwise blocked a new draft for ever); it stores its time in `revoked_at`. Cost: a stuck memo, or a misread cancel time.
- R5: `resetVideo` (failed to queued) added; nothing in the UI calls it yet. Cost: a failed video cannot be re-offered from the app.
- R6: `ga4Month` keeps `keyEvents` in the same call as sessions. Cost: a pull fails on an odd property; fix is a retry without it.
- R7: counts are clamped at 1,000,000 and NaN becomes 0 in traffic/facts.ts. Cost: a huge client shows a capped figure.
- R8: host matching is equality after normalization, for Search Console properties and Analytics stream hosts. Cost: a subdomain-only site needs a property on its own host.
- R9: a non-forced retry keeps, per source, what an earlier non-ok pull already read. Cost: stale but real numbers for that month.
- R10: `previousMonth` moved to sop/months.ts (re-exported). Cost: none.
- R11: `get_traffic` returns counts only (no queries, paths or channels). Cost: no agent can be asked for top queries.
- R12: the memo route and the memo send both treat rehearsal clients as test (owner-only mail). Cost: none.
- R13: the report video never makes a scene for a zero or null number; the uptime scene is qualified or dropped. Cost: a video can look highlight-only.
- R14: an Analytics property is accepted only when every web stream is the site's host. Cost: a shared franchisor or agency property cannot be linked.
- R15: a forced pull can replace an ok month only with an ok result. Cost: an owner cannot deliberately downgrade a month.
- R16: Analytics "last month" is null, not 0, when Google returned no row. Cost: a property truly at zero shows no comparison.
- R17: the 41st and later Analytics properties are reachable through a typed property id. Cost: one more field.
- Pre-flight: the plan's `routes/traffic.ts` mount, the `queueStrategyMemo` file ownership and the memo revoke path were conflicts ruled R1 to R3 before Task 1.

## Deferred minors (released by the final review; none changes client-visible numbers)

Search queries may name a person on the client's own page (the client's own Search Console data). `cancelMemo` reuses `revoked_at`. The memo page and `strategy/public.ts` import the result schema from `queue/strategyMemo.ts` (registers the kind as a side effect). A cancel racing a memo's apply can leave a pending approval card for a cancelled memo (approving it sends nothing). A ready memo whose approval never proposed claims "on the Home page". "Try again" has no confirm. The Local SEO report sweep has no skipped counter and waiting clients take a slot of the 25 (Care: 50) per run until the 7th. A merged ok month can carry an informational error. The default `/api/google/connect` keeps an already-granted profile scope, but a Disconnect and Connect loses it until `?profile=1`. A missing traffic scope marks the connection dead before the profile is tried. The README does not describe `list_batches` and `get_studio_posts` (Plan 15). A shared-host site domain with a path (sites.google.com/view/a) would match another tenant's URL-prefix property. Search Console's last day can still be missing on the 4th (rows are frozen at ok). The uptime video scene's day count is from the lowest-percent site by the final fix. The panel was never rendered; the memo and report pages were never viewed against the real Worker.
