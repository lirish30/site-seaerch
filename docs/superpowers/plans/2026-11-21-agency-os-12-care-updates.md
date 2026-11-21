# Agency OS Plan 12: Care updates (weekly WP-CLI batch, rollback, visual diffs, certificate expiry) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Every week the app finds the WordPress updates waiting on each Care site, updates one or two canary sites first, then the rest, each wave only after Logan approves it; the Mac helper runs the updates over SSH + WP-CLI, takes a database backup first, screenshots key pages before and after, rolls a site back by itself when a page breaks, and the app turns anything that broke into an incident, a task and a Today row.

**Architecture:** The Worker plans and records; the Mac helper does every touch of a client site. Three new helper kinds: `care.inventory` (read-only: what is installed, what can update), `care.update` (backup, update, check, roll back) and `care.certs` (read TLS certificate expiry, which the Worker cannot). A pure classifier sorts each update (security, major, mild, minor) and picks canaries per site group. Each wave is one `care.updates` approval; approving it queues the update jobs. A page whose screenshot changed goes to a `care.review` Claude task (images, no tools); a broken page or a rollback opens an `update_failed` incident and a CARE-5 task on the client's Care project. No credential is ever stored in D1: the site record holds the NAME of an SSH host alias from Logan's `~/.ssh/config`, and the keys stay on the Mac.

**Tech Stack:** Cloudflare Workers + Hono, D1 (migration 0062), zod, React 19 SPA, vitest (Workers pool). Mac helper: Node 22 with no dependencies, `ssh` (system), `wp` on the server, headless Google Chrome for screenshots, `ffmpeg` for SSIM and the diff image. No Playwright, no MainWP, no paid service.

**Spec:** `docs/superpowers/specs/2026-11-17-agency-os-design.md` (copy at `~/Project Sites/agency/docs/specs/2026-11-17-agency-os-design.md`) §9.8 (Care fleet: "Claude runs updates, backups and checks via WP-CLI over SSH"; "Weekly update batch"; "Major updates wait a week, then go to one or two sites first. Big changes use staging. No unattended auto-updates."; "the Mac helper runs Playwright before/after screenshot diffs … and the app checks that forms still work"; "Failures create incidents (CARE-5)"), §5 (Mac helper: "WP-CLI / MainWP calls for Care sites (Phase 3)"; "Nothing client-facing depends on it in real time"), §9.13 (outbound actions only through approvals), §15 call 3. SOP source: `~/Project Sites/agency/research/kb/josh-hall-maintenance-seo.md` §10.2 (CARE-1), §10.3 (CARE-2), §10.6 (CARE-5). Carry-forwards: `docs/superpowers/notes/2026-11-plan-11-open-items.md` (call 4: certificate expiry is a Mac helper job in Plan 12; call 9: the CARE-5 incident task comes with the update batch).

## Scope

Plan 12 of the five Phase 3 plans (see Plan 11). In: the weekly batch, the single-site run (CARE-0 step 1.5's baseline pass), database backup, automatic code rollback, before/after page checks, the Claude look at changed pages, the `update_failed` and `cert_expiring` incidents, the CARE-5 task and seed, ticking the CARE-1 weekly task. Out, and where it goes: MainWP and sites with no SSH (shown as "can't update", no automation; the "let me move you" draft goes to Plan 15's ladder), staging copies for Care Plus (host-specific; Call 9), a vulnerability feed (Call 4), CARE-3 edit requests (Plan 13, beside the edit ledger in the report), CARE-6 and CARE-7 (Plan 15, with the ladder and offboarding), real form submissions (Call 8).

## Global Constraints

- "No unattended auto-updates." (§9.8) Nothing touches a client site unless an approval Logan approved (a wave, or a single-site run) covers that exact site and update. Inventory and certificate reads are read-only and need none.
- "Outbound actions only ever create Approvals." (§9.13) This plan sends no mail and shows nothing to a client.
- No secret in D1, R2, a payload, a result, a log line or an MCP answer: the site stores only `wp_ssh_alias` (a host alias name) and `wp_path`. SSH runs with `-o BatchMode=yes`, so a missing key fails instead of prompting.
- Every value that reaches the remote shell is checked against a fixed pattern on BOTH sides (worker zod and helper), see Task 3: alias `^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$`, path `^/(?!.*\.\.)[A-Za-z0-9._/-]{1,200}$`, slug `^[a-z0-9][a-z0-9._-]{0,99}$`, version `^[0-9][0-9A-Za-z.+-]{0,30}$`, check path `^/(?!.*\.\.)[A-Za-z0-9._~/%-]{0,200}$`. Arguments are passed to `ssh` as an argv array (`runProcess`, no local shell) and each remote word is single-quoted.
- Everything a client site returns (plugin names, page HTML, wp-cli output) is untrusted data: stored trimmed to fixed lengths, shown to Claude only in the untrusted block, never followed.
- Test clients and test sites are never in a weekly batch; a single-site run may target one (that is how Logan rehearses).
- Dates and the batch week use the booking zone (`zoneOf`, `periodKey("weekly", …)`), never UTC.
- Running cost stays at or under `$150/month`: no new service, no dependency in the Worker or the helper.
- Next migration is `0062_care_updates`. Apply the remote migration before deploying the Worker. Bump the helper's `HELPER_VERSION` to `0.2.0`; leave the server's `MIN_HELPER_VERSION` at `0.1.0` (a helper claims only the kinds it has handlers for, so an old helper never takes a care job and keeps doing voice and render).
- Branch to cut: `feat/agency-os-care-updates` from `main` once PR #35 (the `scheduledTime` fix) is merged (worktree `~/Project Sites/site-search-agency-os`). Subagents run on Sonnet.
- Verification: `npx vitest run <file>`, `npm test`, `npm run test:helper`, `npm run typecheck`, `npm run build`. Known flakes (`billing-flow`, `billing-sweep`, `projects-flow`, `sites-onboarding-items`) pass alone.

## Review Focus

Inputs and conditions the spec implies and no happy-path test exercises, most likely first. Each has its test in the named task.

1. A site record whose alias, path, check path or an update's slug or version carries shell syntax (`x; rm -rf ~`, `$(id)`, a backtick, `../..`, a space, a newline): the worker refuses to queue it and the helper refuses to run it, and no `ssh` is spawned. (Task 3 helper test, Task 6 worker test)
2. The Mac sleeps or the helper dies mid-update, and the job is handed out again: the rerun reads the site's versions first, skips what is already at the target version, never updates the same component twice and never takes a second backup over the first. A job that runs past 20 minutes keeps its claim by touching it, so no second Mac can take it. (Task 5)
3. wp-cli prints PHP notices or a plugin's banner before its JSON, or prints nothing (a white screen): the parser takes the last JSON line, and no JSON at all is a failed step with a fixed sentence, not a crash and not "no updates". (Task 3)
4. An update that cannot be rolled back (a premium plugin with no wordpress.org versions, so `wp plugin install --version` fails): the plan marks it "can't roll back" and it needs Logan's tick like a major; if it breaks the site anyway, the incident says the rollback failed and names the backup file, it never claims the site is fine. (Tasks 2, 5, 6)
5. An approval approved days after it was drafted, when a newer version came out, an update was applied by hand, the site was archived or Care ended: execute re-reads each site and queues only what still applies, at the version it now shows, and says what it dropped. (Task 7)

## Calls made in this plan (Logan to check)

1. Only `ssh_wpcli` WordPress sites with an alias and a path are updated. MainWP and "none" sites are listed on the Care page as "can't update: no SSH access" and nothing more.
2. The helper runs `ssh -o BatchMode=yes <alias> -- wp --path='<path>' … --format=json`. The alias is a `Host` entry in your `~/.ssh/config` (with a 1Password or ssh-agent key). The app stores the alias name only.
3. The batch day is CARE-1's day (Wednesday, `cadenceDay` 3, editable in Settings). The daily cron on that day queues an inventory of every updatable site; when the last one is in, wave 1 is drafted.
4. Risk classes from version numbers alone: core major = the first or second number changes (6.6 → 6.7), plugin/theme major = the first number changes, mild = the second, minor = anything after. A version the classifier can't read is major. There is no vulnerability feed (free feeds need sign-up and rate limits), so **security** is a tick you set by hand on an update, which skips the wait.
5. A major waits 7 days from the day the app first saw it (not the release date, which wp-cli does not report).
6. Needs your tick even after the canary passed: every major, core, any update that can't be rolled back, and anything whose slug matches `RISKY_SLUGS` (WooCommerce and its extensions, Elementor, Beaver Builder, Divi, WPBakery, Gravity Forms, WPForms, Contact Form 7, Ninja Forms, Formidable, Amelia, Bookly, any slug containing `booking`). The list is one constant.
7. Groups come from the installed plugins: `woocommerce` (WooCommerce active), `booking` (a booking plugin), `builder` (a page builder), else `brochure`. One canary per group, two when the group has six or more sites, chosen lowest Care price first, then domain; a single-site run has no canary.
8. Forms are counted, never submitted: a page that had N `<form>` elements and now has fewer is broken. Submitting a client's real form would email the client. A real delivery test stays a hand check.
9. No staging copy, Care Plus included ("big changes use staging" is not met). Instead: canaries, your tick on big changes, a database backup and automatic code rollback. Staging is host-specific; say if you want it for Care Plus in a later plan.
10. Backup = `wp db export` on the server into `siteline-backups/<domain>-<runId>.sql.gz` under the SSH user's home, kept 28 days; files are left to the host's own backups. Automatic rollback puts the old code back (`wp plugin install <slug> --version=<from> --force`, the same for themes, `wp core update --version=<from> --force`) and **never** imports the database (it would lose orders and form entries made since); the incident names the backup file for you to restore by hand.
11. A page is **broken** after updates on: status 5xx, 404 or 410 where it was 2xx before, the "There has been a critical error" text, a wp-cli error, or fewer forms. Broken rolls the site back by itself. A page is **changed** when the screenshot's SSIM is below 0.95: no rollback, Claude looks (fine, broken or unsure); broken or unsure becomes yours.
12. Up to five check pages per site (`care_paths`, default `/`), desktop width 1280, height 1600, first screen only.
13. Certificate expiry is read daily by the helper for every monitored site; 14 days or less (or expired) opens a `cert_expiring` incident, which closes when a later read is over 14 days. If the Mac is off, the last reading stands and the board says how old it is.
14. Health: an open `update_failed` takes 15 points, a `cert_expiring` 15. Today: `update_failed` at priority 85, `cert_expiring` 66, a page waiting on your look 70.
15. Cut line (§12 six-week rule): drop Task 10 (certificates) first, then the Claude look (Task 9: a changed page becomes yours directly), then the pages (Task 12), keeping the routes.

---

### Task 1: Tables, columns and the data module

**Files:**
- Create: `migrations/0062_care_updates.sql`, `src/worker/db/careUpdates.ts`
- Modify: `src/worker/db/sites.ts` (Site, SiteRow, toSite, SiteFields, the column maps), `src/worker/db/monitoring.ts` (`IncidentKind`), `src/worker/types.ts` (`ACTIVITY_KINDS` + `care_updated`, `care_rolled_back`), `src/client/activityView.ts`, `test/fixtures/*` that build a `Site`
- Test: `test/care-updates-db.test.ts`

**Interfaces:**
- Produces (`sites`): `wp_ssh_alias TEXT`, `wp_path TEXT`, `care_paths TEXT NOT NULL DEFAULT '["/"]'` (JSON array), `cert_expires_on TEXT`, `cert_checked_at TEXT`; `Site` gains `wpSshAlias: string | null; wpPath: string | null; carePaths: string[]; certExpiresOn: string | null; certCheckedAt: string | null`; `SiteFields` gains the first three. `updateSite` validates them with the Task 3 patterns (`WP_ARG` re-exported from `src/worker/care/args.ts`) and throws `SiteInputError` with a plain sentence.
- Produces (`site_incidents` rebuilt, SQLite cannot alter a CHECK): same columns, `kind IN ('down','domain_expiring','update_failed','cert_expiring')`, rows copied, `uq_site_incident_open` recreated. `IncidentKind` gains the two kinds.
- Produces (tables): `care_batches(id PK, period TEXT NOT NULL, kind TEXT NOT NULL CHECK (kind IN ('weekly','single')), site_id TEXT, status TEXT NOT NULL CHECK (status IN ('inventory','wave1','wave2','done','cancelled')), created_at, updated_at)` with `UNIQUE(period) WHERE kind = 'weekly'`; `care_updates(id PK, site_id NOT NULL REFERENCES sites(id), type TEXT CHECK (type IN ('core','plugin','theme')), slug, name, from_version, to_version, risk TEXT CHECK (risk IN ('security','major','mild','minor')), rollbackable INTEGER, security INTEGER DEFAULT 0, held INTEGER DEFAULT 0, first_seen_at, last_seen_at, status TEXT CHECK (status IN ('available','queued','applied','failed','rolled_back','gone')))` with `UNIQUE(site_id, type, slug, to_version)`; `care_runs(id PK, batch_id NOT NULL, site_id NOT NULL, wave INTEGER CHECK (wave IN (0,1,2)), approval_id, helper_job_id, status TEXT CHECK (status IN ('queued','running','ok','changed','rolled_back','failed','dropped')), backup_file TEXT, summary TEXT, created_at, finished_at)`; `care_page_checks(id PK, run_id NOT NULL, path, before_key, after_key, diff_key, status_before INTEGER, status_after INTEGER, forms_before INTEGER, forms_after INTEGER, ssim REAL, verdict TEXT CHECK (verdict IN ('ok','changed','broken')), review TEXT CHECK (review IN ('none','pending','fine','broken','unsure','logan_ok')) DEFAULT 'none')`; `site_inventories(site_id PK, wp_version, php_version, group_key TEXT CHECK (group_key IN ('woocommerce','booking','builder','brochure')), plugins TEXT (JSON, active slugs only, at most 200), read_at)`.
- Produces (`db/careUpdates.ts`): `type UpdateType`, `type Risk`, `type RunStatus`, `type Verdict`, `type Review`, `type GroupKey`, `type BatchStatus` (each the union of its column's CHECK values), `interface CareUpdate`, `CareRun`, `PageCheck`, `CareBatch`, `Inventory` (camelCase of the columns); `upsertSeen(db, siteId, u: SeenUpdate[], now): Promise<void>` (inserts new rows `available` with `first_seen_at = now`, refreshes `last_seen_at`, marks an `available` row not in `u` as `gone`; never resets `security`/`held`); `setUpdateFlag(db, id, flag: "security" | "held", on: boolean): Promise<CareUpdate | null>`; `availableFor(db, siteId): Promise<CareUpdate[]>`; `saveInventory(db, i: Inventory)`, `getInventory(db, siteId)`; `ensureWeeklyBatch(db, period, now): Promise<{ batch: CareBatch; created: boolean }>`; `createSingleBatch(db, siteId, period, now)`; `setBatchStatus(db, id, from: BatchStatus[], to, now): Promise<boolean>` (compare-and-set); `insertRun`, `getRun`, `runsFor(db, batchId)`, `setRunStatus(db, id, from: RunStatus[], to, patch, now): Promise<boolean>`; `insertPageChecks(db, runId, rows)`, `pageChecksFor(db, runId)`, `setReview(db, checkId, from: Review[], to): Promise<boolean>`; `updatableSites(db, o: { includeTest: boolean }): Promise<Site[]>` (live, real unless `includeTest`, `cms = 'wordpress'`, `access_method = 'ssh_wpcli'`, alias and path set, client has `CARE_SUBSCRIPTION_SQL` and is not on hold via `holdFreeSql`).

- [ ] **Step 1: Write the failing test.** `upsertSeen` twice keeps one row and the first `first_seen_at`; an update missing from the second call becomes `gone`; a newer `to_version` is a new row and the older one `gone`; `security`/`held` survive an upsert; `ensureWeeklyBatch` twice for one period gives `created: true` then `false`; `setRunStatus` with a wrong `from` changes nothing; `updatableSites` returns the Care WordPress SSH site and not: no alias, no path, `mainwp`, `webflow`, archived, test (unless `includeTest`), no Care, a client on billing hold; the migration copies an existing `down` incident across the rebuild and the open-unique index still refuses a second open one.
- [ ] **Step 2: Run `npx vitest run test/care-updates-db.test.ts`.** Expected: FAIL (module not found).
- [ ] **Step 3: Write the migration and the module; add the Site fields and the two activity kinds with labels.**
- [ ] **Step 4: Run it, then `npx vitest run test/monitoring-db.test.ts test/sites-db.test.ts test/clients-flow.test.ts`.** Expected: PASS.
- [ ] **Step 5: Commit** `feat(care): update, run and page-check tables; SSH alias on the site`.

---

### Task 2: The classifier, the groups and the canary pick

**Files:**
- Create: `src/worker/care/versions.ts`
- Test: `test/care-versions.test.ts`

**Interfaces:**
- Consumes: `CareUpdate`, `Inventory` (Task 1).
- Produces: `export const MAJOR_WAIT_DAYS = 7, SSIM_CHANGED = 0.95, MAX_PATHS = 5`; `export const RISKY_SLUGS: readonly (string | RegExp)[]` (Call 6); `riskOf(type: UpdateType, from: string, to: string): Exclude<Risk, "security">` (Call 4); `needsTick(u: Pick<CareUpdate, "type" | "slug" | "risk" | "rollbackable">): boolean` (Call 6); `isDue(u: CareUpdate, now: Date): boolean` (true for minor/mild, for security, and for a major first seen 7 or more days ago; false when `held`); `groupOf(activePlugins: string[], theme: string | null): GroupKey` (Call 7); `pickCanaries(sites: { siteId: string; group: GroupKey; careCents: number; domain: string }[]): Set<string>` (Call 7).

- [ ] **Step 1: Write the failing test.** `riskOf("core","6.6.2","6.6.3")` minor, `("core","6.6.2","6.7")` major, `("core","6.9","7.0")` major; `("plugin","3.2.1","3.2.2")` minor, `("plugin","3.2.1","3.3.0")` mild, `("plugin","3.2.1","4.0")` major; `("plugin","1.0","1.0.0.1")` minor; `("plugin","beta","1.0")` and `("plugin","1.0","")` major. `needsTick`: a minor of `akismet` false; minor `woocommerce` true; `woocommerce-subscriptions` true; `my-booking-calendar` true; any core true; a mild with `rollbackable: false` true. `isDue`: a major first seen 6 days 23 hours ago false, 7 days true, with `security` true at once; a held minor false. `pickCanaries` with 3 brochure sites gives the cheapest one; with 6 gives two; ties broken by domain; groups are independent.
- [ ] **Step 2: Run it.** Expected: FAIL.
- [ ] **Step 3: Implement.** Compare versions by splitting on `.` and reading leading digits of each part.
- [ ] **Step 4: Run it.** Expected: PASS.
- [ ] **Step 5: Commit** `feat(care): update risk, groups and canaries`.

---

### Task 3: Safe WP-CLI on the helper, and the inventory job

**Files:**
- Create: `src/worker/care/args.ts`, `src/worker/care/inventoryKind.ts`, `helper/src/care/wp.ts`, `helper/src/handlers/careInventory.ts`
- Modify: `src/worker/helper/kinds.ts` (import `../care/inventoryKind` beside the meetily import), `helper/src/cli.ts` (`buildHandlers`), `helper/src/config.ts` (`chrome: string`, default `/Applications/Google Chrome.app/Contents/MacOS/Google Chrome`)
- Test: `test/care-inventory-kind.test.ts`, `helper/test/care-wp.test.ts`, `helper/test/care-inventory.test.ts`

**Interfaces:**
- Produces (`src/worker/care/args.ts`): `export const WP_ARG = { alias, path, slug, version, checkPath }` (the regexes in Global Constraints) and zod schemas `SshTarget = z.object({ alias, path })`.
- Produces (`helper/src/care/wp.ts`): the same five patterns (a copy: the helper has no dependency on the worker; `helper/test/care-wp.test.ts` holds the same accept/refuse table as `test/care-inventory-kind.test.ts`); `quoteRemote(word: string): string` (single-quote, `'` → `'\''`); `class WpError extends Error`; `wp(exec: Exec, t: { alias; path }, args: string[], o: { timeoutMs: number }): Promise<unknown>` (checks `t` and every arg first and throws `WpError("this site's SSH settings are not valid")` without spawning; runs `exec("ssh", ["-o","BatchMode=yes","-o","ConnectTimeout=15", t.alias, "--", "wp", `--path=${quoteRemote(t.path)}`, ...args.map(quoteRemote)], { timeoutMs })`; returns the last line of stdout that parses as JSON; no such line throws `WpError("wp-cli gave no readable answer")`; a non-zero exit throws `WpError` with `exec`'s message cut to 300 characters).
- Produces (kind `care.inventory`): payload `{ siteId, batchId, alias, path }`; result `{ wpVersion, phpVersion, core: { to } | null, plugins: { slug, name, status, version, updateVersion: string | null, fromWporg: boolean }[] (≤300), themes: same shape (≤50), activeTheme }`, each string trimmed to 200 characters by the schema. `fromWporg` is set by the helper: true when the item's `update_package` is on `downloads.wordpress.org` (or there is no update and the item has a wordpress.org page per `wp plugin get --field=…`; when unsure, false). `inputs`/`outputs` empty. `apply`: refuses (`HelperRefused`) a result for a site that is gone or no longer updatable; else `saveInventory` (group from `groupOf`) and `upsertSeen` with risk from `riskOf` and `rollbackable = type === "core" || fromWporg`; then `onInventoryDone(env, batchId)` (Task 7). `onFail`/`onExpire`: also `onInventoryDone`. Until Task 7 lands, `onInventoryDone` is imported from `care/batch.ts` as a stub that does nothing.
- Helper handler runs, each with a 120 s timeout: `wp core version --format=json`, `wp cli info --format=json` (for `php_version`), `wp core check-update --format=json`, `wp plugin list --fields=name,title,status,version,update_version,update_package --format=json`, `wp theme list --fields=name,title,status,version,update_version,update_package --format=json`. `wp eval`, `wp shell` and `wp db query` are never run by any care job.

- [ ] **Step 1: Write the failing tests.** Helper: `wp` with alias `client1`, path `/var/www/html`, args `["plugin","list","--format=json"]` calls the fake `exec` with exactly the argv above; each of `x; rm -rf ~`, `$(id)`, `` `id` ``, `a b`, `a\nb`, `../etc`, `/var/../etc` as alias, path or arg throws `WpError` and the fake was never called; stdout `"Notice: x\nDeprecated: y\n[{\"name\":\"akismet\"}]\n"` returns the array; stdout `""` and `"<html>"` throw "wp-cli gave no readable answer"; `quoteRemote("it's")` is `'it'\''s'`. Inventory handler with a fake `wp` returns the result shape and marks a plugin whose `update_package` is `https://example.com/pro.zip` `fromWporg: false`. Worker: the kind's payload schema refuses each hostile value; `apply` stores the inventory and two `available` updates with the right risks; a second `apply` with one fewer update marks it `gone`; a result for an archived site is refused.
- [ ] **Step 2: Run `npm run test:helper` and `npx vitest run test/care-inventory-kind.test.ts`.** Expected: FAIL.
- [ ] **Step 3: Implement the four files and register the handler and the kind.**
- [ ] **Step 4: Run both.** Expected: PASS.
- [ ] **Step 5: Commit** `feat(care): safe WP-CLI over SSH and the inventory job`.

---

### Task 4: Page checks on the helper (status, forms, screenshot, SSIM, diff)

**Files:**
- Create: `helper/src/care/pages.ts`
- Test: `helper/test/care-pages.test.ts`

**Interfaces:**
- Produces: `interface PageShot { path: string; status: number | null; fatal: boolean; forms: number; png: string | null }`; `readPage(fetchFn: typeof fetch, url: string): Promise<{ status: number | null; fatal: boolean; forms: number }>` (one GET, 20 s timeout, `redirect: "follow"`, body read to at most 2 MB; `fatal` = the body contains `There has been a critical error on this website`; `forms` = count of `<form` case-insensitive; a throw gives `status: null`); `screenshot(exec, chrome: string, url: string, outPng: string): Promise<boolean>` (`--headless=new --disable-gpu --hide-scrollbars --no-first-run --window-size=1280,1600 --virtual-time-budget=8000 --screenshot=<outPng> <url>`, 60 s; false on failure); `compare(exec, ffmpeg: string, a: string, b: string, diffJpg: string): Promise<number | null>` (SSIM from `ffmpeg -i a -i b -lavfi ssim -f null -`, the `All:` value; the diff image from `blend=all_mode=difference,eq=contrast=3`, one frame, `-q:v 5`; null when either step fails); `toJpeg(exec, ffmpeg, png, jpg): Promise<boolean>`; `verdictOf(before: PageShot, after: PageShot, ssim: number | null): Verdict` (Call 11: broken when before was 2xx and after is null/404/410/≥500, or `fatal` became true, or `forms` dropped; else changed when `ssim !== null && ssim < 0.95`; else ok); `pageUrl(siteUrl: string, path: string): string` (the path is checked with the check-path pattern and joined to the site's origin, never to another host).

- [ ] **Step 1: Write the failing test.** `verdictOf`: 200→500 broken, 200→404 broken, 404→404 ok (it was already missing), 200→200 with `fatal` broken, forms 2→1 broken, 2→3 ok, ssim 0.94 changed, 0.95 ok, null ok (no screenshot is not a failure on its own); `readPage` with a fake fetch counts `<FORM` and `<form ` and stops reading at 2 MB (a 5 MB fake body is not fully read); `compare` parses `[Parsed_ssim_0 @ 0x1] SSIM Y:0.98 U:0.99 V:0.99 All:0.981234 (17.2)` to 0.981234 and returns null when the fake exec rejects; `pageUrl("https://acme.com/shop", "/contact")` is `https://acme.com/contact`, and `pageUrl(…, "//evil.com/")` and `(…, "http://evil.com")` throw.
- [ ] **Step 2: Run `npm run test:helper`.** Expected: FAIL.
- [ ] **Step 3: Implement `pages.ts`.**
- [ ] **Step 4: Run it.** Expected: PASS.
- [ ] **Step 5: Commit** `feat(helper): page checks with headless Chrome and ffmpeg SSIM`.

---

### Task 5: The update job on the helper, and the claim touch

**Files:**
- Create: `helper/src/handlers/careUpdate.ts`
- Modify: `helper/src/api.ts` (`JobApi.touch(jobId): Promise<void>`, `HELPER_VERSION = "0.2.0"`), `src/worker/helper/jobs.ts` (`touchHelperJob`), `src/worker/routes/helper.ts` (`POST /helper/jobs/:id/touch`), `helper/src/cli.ts`
- Test: `helper/test/care-update.test.ts`, `test/helper-touch.test.ts`

**Interfaces:**
- Consumes: `wp`, `quoteRemote` (Task 3); `readPage`, `screenshot`, `compare`, `toJpeg`, `verdictOf`, `pageUrl` (Task 4).
- Produces (worker): `touchHelperJob(db, id, deviceId, now): Promise<boolean>` (sets `claimed_at = now` only when the job is `claimed` by `deviceId`); the route answers 204, or 409 with `NOT_YOURS`.
- Produces (payload, defined in Task 6, read here): `{ runId, siteId, siteUrl, alias, path, paths: string[], updates: { id, type, slug, from, to, rollbackable }[] }`; `outputs` are `care/<runId>/<i>-before.jpg`, `-after.jpg`, `-diff.jpg` for each path index `i`.
- Produces (result): `{ backupFile: string | null, steps: { id, outcome: "applied" | "skipped" | "failed" | "rolled_back" | "rollback_failed", note }[], pages: { path, before: { status, fatal, forms }, after: { same }, ssim: number | null, verdict, uploaded: { before: boolean; after: boolean; diff: boolean } }[], rolledBack: boolean }`. `note` is one of a fixed set of sentences (`"already at the new version"`, `"wp-cli refused the update"`, `"the site broke after this update"`, `"the old version could not be put back"` …) plus at most 200 characters of wp-cli's message.
- Produces (`helper/src/care/wp.ts`, added here): `remote(exec, alias, words: string[], o): Promise<string>` for the three non-wp commands below, through the same checks and quoting as `wp` (only `mkdir`, `test`, `gzip` and `find` are allowed as the first word). Backup paths are RELATIVE (`siteline-backups/<domain>-<runId>.sql`): a quoted `~` would not expand on the server, and the SSH session starts in the user's home.
- Order, each `wp` call 300 s, `api.touch` after every step: (1) read the current version of each update's component (`wp plugin get <slug> --field=version --format=json`, the same for themes, `wp core version --format=json`); a component already at `to` is `skipped` ("already at the new version") and no later step runs for it; one at neither `from` nor `to` is `skipped` ("changed by hand since the plan"); (2) before-page shots for every path; (3) backup, unless `remote(["test","-e", "siteline-backups/<domain>-<runId>.sql.gz"])` succeeds (a rerun keeps the first backup): `remote(["mkdir","-p","siteline-backups"])`, `wp db export siteline-backups/<domain>-<runId>.sql`, `remote(["gzip","-f", "<that file>"])`, then `remote(["find","siteline-backups","-name","*.sql.gz","-mtime","+28","-delete"])`; a failed backup stops the job before any update (all steps `skipped`, note "the backup failed, nothing was updated"); (4) apply each update (`wp plugin update <slug> --version=<to>`, `wp theme update <slug> --version=<to>`, `wp core update --version=<to>` then `wp core update-db`); (5) after-page shots, `compare`, `verdictOf`; (6) if any page is `broken` or a step `failed`: put back every `applied` component that is `rollbackable` (`wp plugin install <slug> --version=<from> --force`, theme the same, `wp core update --version=<from> --force`), mark them `rolled_back` or `rollback_failed`, read the pages once more (status only, no screenshot) into `pages[].after`, `rolledBack: true`; (7) upload the JPEGs that exist.

- [ ] **Step 1: Write the failing tests.** With a fake `exec` recording argv and a fake `api`: a run of two plugin updates calls, in order, the version reads, Chrome per path, the backup, the two updates, Chrome again, ffmpeg, then uploads six files and returns both `applied`; a rerun where the fake server says the backup file exists and the first plugin is already at `to` takes no backup, skips the first and updates only the second; a component found at a third version is skipped; a page that goes 200→500 after the updates triggers the two `install --version=<from> --force` calls and returns `rolledBack: true` with the recheck statuses; a non-rollbackable update that broke the site is `rollback_failed`; `api.touch` is called after every step; a failed backup updates nothing; a payload with a hostile slug fails before any `ssh`; `remote(["rm","-rf","x"])` throws; no argv ever contains `eval`, `shell`, `sh -c`, `db query` or `db import`, and no argv holds a `~`. Worker: `touchHelperJob` refreshes the claim for its device and returns false for another device or a done job.
- [ ] **Step 2: Run `npm run test:helper` and `npx vitest run test/helper-touch.test.ts`.** Expected: FAIL.
- [ ] **Step 3: Implement the handler, `touch` on the client and the route.**
- [ ] **Step 4: Run both.** Expected: PASS.
- [ ] **Step 5: Commit** `feat(helper): care.update with backup, checks and rollback`.

---

### Task 6: The update kind on the Worker: results, incidents and the CARE-5 task

**Files:**
- Create: `src/worker/care/updateKind.ts`, `src/worker/care/incidents.ts`
- Modify: `src/worker/helper/kinds.ts` (import), `src/worker/sop/seeds.ts` (CARE-5 seed), `src/worker/monitoring/fleet.ts` (`incidentView` words the two new kinds)
- Test: `test/care-update-kind.test.ts`

**Interfaces:**
- Consumes: Task 1 db functions; `openIncident`, `closeIncident` (`db/monitoring.ts`); `insertTasks` (`db/tasks.ts`); `getTemplate` (`db/sops.ts`); `logActivity`; `onRunDone` (the Task 7 stub in `care/batch.ts` until Task 7 fills it).
- Produces: `export const CARE_UPDATE_KIND = "care.update"`; `CareUpdatePayload` (zod, every field through `WP_ARG`; `paths` at most `MAX_PATHS`; `updates` 1 to 40); `CareUpdateResult` (zod of Task 5's result); `carePageKeys(runId, i): { before; after; diff }`; `queueRun(env, o: { batchId; site: Site; wave: 0 | 1 | 2; approvalId; updates: CareUpdate[] }): Promise<CareRun | null>` (inserts the run `queued` and the job with `dedupeKey = care.update:<siteId>`, so one open update per site; null and a `dropped` run when a job is already open for the site); `apply`: refuses a result for a run that is not `queued`/`running` (`HelperRefused`), refuses a page key it did not get (`env.RAW.head` each uploaded key), writes page checks, maps step outcomes onto `care_updates.status`, sets the run to `rolled_back` / `failed` / `changed` / `ok`, logs `care_updated` or `care_rolled_back`, then: `rolled_back`, `failed` or any `rollback_failed` → `openUpdateIncident`; a fully `ok` run → `closeIncident(…, "update_failed")`; each `changed` page → `setReview(…, "pending")` (Task 9 adds the Claude task for it here); finally `onRunDone(env, run.batchId)` (Task 7). `onFail`/`onExpire`: run → `failed` (expire: `dropped` with "your Mac helper didn't pick this up in time"), its updates back to `available`, `onRunDone`.
- Produces (`care/incidents.ts`): `openUpdateIncident(env, run: CareRun, site: Site, why: string, now: Date): Promise<void>` (opens `update_failed` with a fixed sentence: "updates rolled back: <slug list> broke <path>", "rollback failed for <slug>: restore from <backupFile>", "update failed on the Mac helper"; and, only when the incident is new, inserts ONE task on the client's live Care project, owner `logan`, title `Fix: <domain> after updates`, checklist from the CARE-5 template's steps, `cadenceKey = "CARE-5"`, `periodKey = incident id`, so a rerun adds none); `closeUpdateIncident(env, siteId, now)`.
- CARE-5 seed (kind `project`, `cadence: null`, `appliesTo` the three Care keys, `active: true`) with the four steps of kb §10.6 written fresh: contain (C), restore or clean (CL), tell the client (CL), post-incident note (CL). It is never instantiated as a project; it is the checklist source.

- [ ] **Step 1: Write the failing test.** A result with both updates `applied` and every page `ok` gives run `ok`, both updates `applied`, no incident, no task; one `changed` page gives run `changed` and review `pending`, and a second `apply` (crash-retry) changes nothing; a `rolledBack` result opens one `update_failed` incident with the slug and path in its detail, inserts one CARE-5 task on the Care project and logs `care_rolled_back`, and the same result again changes nothing; `rollback_failed` names the backup file; a later `ok` run on that site closes the incident (the task stays: it is Logan's to close); a result naming a key not in `outputs` or not uploaded is refused and the run stays `running`; a result for a `dropped` run is refused; `onExpire` puts the updates back to `available`; a hostile slug in a stored `care_updates` row makes `queueRun` throw `InvalidHelperJobError` and queue nothing; `incidentView` words `update_failed` and `cert_expiring` (fixed text, not the stored detail, for a closed one).
- [ ] **Step 2: Run `npx vitest run test/care-update-kind.test.ts`.** Expected: FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run it, then `npx vitest run test/sop-seeds.test.ts test/monitoring-incidents.test.ts`.** Expected: PASS.
- [ ] **Step 5: Commit** `feat(care): apply update results; update_failed incident and CARE-5 task`.

---

### Task 7: The batch: inventory, waves, the approval and the cron

**Files:**
- Create: `src/worker/care/batch.ts`, `src/worker/approvals/careUpdates.ts`
- Modify: `src/worker/index.ts` (`import "./approvals/careUpdates";` beside the other approval imports), `src/worker/schedule.ts` (daily list)
- Test: `test/care-batch.test.ts`

**Interfaces:**
- Consumes: Tasks 1, 2, 3, 6; `getTemplate(db, "CARE-1")` for `cadenceDay`; `periodKey`, `zoneOf`; `createApproval`; `enqueueHelperJob`.
- Produces: `startWeeklyBatch(env, now): Promise<{ batch: CareBatch | null; queued: number }>` (only on CARE-1's ISO weekday in the zone, and only when the template is active; `ensureWeeklyBatch` for this week's period; queues one `care.inventory` per `updatableSites(…, { includeTest: false })` with `dedupeKey = care.inventory:<siteId>:<period>`; a second call the same day queues nothing); `startSingleRun(env, siteId, now): Promise<CareBatch>` (any day, test sites allowed, one site; refuses with a plain sentence a site that is not updatable or already has an open run); `onInventoryDone(env, batchId)` (when no inventory job for the batch is still open: weekly → `draftWave(env, batch, 1)`; single → `draftWave(env, batch, 0)`); `onRunDone(env, batchId)` (when wave 1 has no open run: `draftWave(env, batch, 2)`; when wave 2 or 0 is done: batch `done`); `draftWave(env, batch, wave): Promise<Approval | null>` (wave 1 = canary sites from `pickCanaries` over sites that have due updates; wave 2 = the rest, minus any update whose run on a canary ended `rolled_back`/`failed`, minus a group whose canary has a page still `pending` review (that group waits; the wave is drafted again when the review lands, Task 9 calls `onRunDone`); wave 0 = the one site; only `isDue` updates; none due → no approval and the batch moves on; compare-and-set on the batch status, so two callers draft one approval).
- Produces (approval kind `care.updates`): payload `{ batchId, wave, sites: { siteId, domain, updates: { id, type, slug, name, from, to, risk, needsTick }[] }[] }`; title `Care updates: wave 1 (3 sites, 11 updates)` / `wave 2` / `<domain>`; preview lists each site and its updates one per line, majors and `needsTick` ones marked `[needs your OK]` (the approval itself is the OK; an update Logan does not want is held on the Care page before approving); `execute`: for each site, re-read the site (`updatableSites` rule, test allowed for wave 0) and its `care_updates` rows, keep the ones still `available`, not `held`, same `to_version`, call `queueRun`; a site with nothing left gets a `dropped` run with the reason; marks those updates `queued`; returns normally (the approval's `error` is not used for drops; the run summaries carry them).
- Produces: `careBackstop(env, now): Promise<{ drafted: number; cancelled: number }>`.
- `schedule.ts` daily list: `await part("care updates", () => startWeeklyBatch(env, now));` after "domain expiry", and `await part("care backstop", () => careBackstop(env, now));` where `careBackstop` calls `onInventoryDone`/`onRunDone` for every open batch (a lost hook never strands a batch) and cancels a weekly batch older than 6 days that is still in `inventory`.

- [ ] **Step 1: Write the failing test.** On a Wednesday in Los Angeles (fixed clock `2026-12-02T17:00:00Z`) `startWeeklyBatch` queues one inventory per updatable site and on a Tuesday queues none; twice on Wednesday queues once; with three brochure sites inventoried, wave 1 is one approval naming only the cheapest; approving it queues one `care.update` job for that site; when its run is `ok`, wave 2 is drafted for the other two; when it `rolled_back` plugin `x`, wave 2 leaves `x` out for every site; a canary page `pending` review keeps that group out of wave 2 until the review lands; a major first seen 3 days ago is in no wave; one marked `security` is; a `held` update is in no wave and an update held after the draft but before approval is not queued; executing an approval after the site was archived, after Care was cancelled, and after the update was applied by hand (`gone`) queues nothing for it and leaves a `dropped` run with a reason; a newer `to_version` seen after drafting is not queued under the old one; `startSingleRun` on a test site works and on a `mainwp` site refuses; `careBackstop` drafts the wave an `onRunDone` missed and does not draft it twice.
- [ ] **Step 2: Run `npx vitest run test/care-batch.test.ts`.** Expected: FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run it, then `npx vitest run test/schedule.test.ts test/approvals.test.ts`.** Expected: PASS.
- [ ] **Step 5: Commit** `feat(care): weekly batch, canary waves and the care.updates approval`.

---

### Task 8: Ticking the CARE-1 weekly task

**Files:**
- Create: `src/worker/care/tasks.ts`
- Modify: `src/worker/care/batch.ts` (calls), `src/worker/approvals/careUpdates.ts` (call on execute)
- Test: `test/care-tasks.test.ts`

**Interfaces:**
- Consumes: `listTasks`, `patchTask` (`db/tasks.ts`); the CARE-1 recurring task (`cadenceKey = "CARE-1"`, `periodKey` = the batch's period, checklist in template step order).
- Produces: `tickCare1(env, businessId, period, steps: ("1.1" | "1.2" | "1.3" | "1.4" | "1.5" | "1.6")[], now): Promise<boolean>` (finds the client's CARE-1 task for `period` by `cadenceKey`/`periodKey`, ticks the checklist items at the indexes of those step keys in the current CARE-1 template; does nothing if the task is done or skipped, or the template's steps changed so a key is missing; never un-ticks; returns whether anything changed). Calls: after wave planning, 1.1 and 1.2 for every client with a site in the batch; after a canary run ends, 1.3 for its client; on approval execute, 1.4 for every client in it; after all of a client's runs in the batch end with nothing `failed`/`rolled_back`, 1.5 and 1.6, and the task is set `done` through `completeTask` only if every item is ticked; a client whose run failed gets 1.5 ticked only when nothing is left queued, and 1.6 stays for Logan (the CARE-5 task is the real work).

- [ ] **Step 1: Write the failing test.** A client with one site through a clean batch ends with every CARE-1 item ticked and the task `done`; a client whose site rolled back has 1.6 open and the task not done; a CARE-1 task for another week is untouched; a CARE-1 task Logan already marked done is untouched; a template edited to drop step 1.2 makes `tickCare1(…, ["1.2"])` change nothing and not throw; a client with no Care project and no CARE-1 task is fine.
- [ ] **Step 2: Run `npx vitest run test/care-tasks.test.ts`.** Expected: FAIL.
- [ ] **Step 3: Implement and wire the calls.**
- [ ] **Step 4: Run it, then `npx vitest run test/care-batch.test.ts test/projects-sweep.test.ts`.** Expected: PASS.
- [ ] **Step 5: Commit** `feat(care): the batch ticks each client's CARE-1 task`.

---

### Task 9: Claude looks at a changed page

**Files:**
- Create: `src/worker/queue/careReview.ts`
- Modify: `src/worker/queue/kinds.ts` (import), `src/worker/care/updateKind.ts` (`apply` queues `queueReview(env, checkId)` for each `changed` page, dedupe key the check id, so a crash-retry queues one), `src/worker/routes/care.ts` (`POST /api/care/checks/:id/ok`: Logan marks a page fine, review → `logan_ok`)
- Test: `test/care-review.test.ts`

**Interfaces:**
- Consumes: `pageChecksFor`, `setReview`, `getRun` (Task 1); `onRunDone` (Task 7); `openUpdateIncident` (Task 6).
- Produces: `export const CARE_REVIEW_KIND = "care.review"`, `suggestedModel: "sonnet"`; payload `{ checkId }`; result `{ verdict: "fine" | "broken" | "unsure", note: string (1 to 500) }`; `build`: stale when the check's review is not `pending`; instructions (trusted, fixed): what the three images are (before, after, the difference: bright means changed), that rotating sliders, dates, cookie banners, live chat bubbles and ads are fine, that a missing header, menu, form, button, phone number or a broken layout is broken, and to answer `unsure` rather than guess; untrusted parts: the three JPEGs (`{ type: "image", r2Key, mimeType: "image/jpeg" }`) and the path and the updated plugin names as text. `apply`: `fine` → review `fine`; `broken` or `unsure` → review `broken`/`unsure` and `openUpdateIncident(…, "a page looks different after updates: <path>")` (no rollback: Logan decides); then `onRunDone`. `onExpire`/`onFail`: review `unsure`, the same incident, `onRunDone`.
- Today: a check with review `unsure` or `broken` is covered by the `update_failed` incident row (Task 11); a check left `pending` for more than 24 hours adds the reason "a page changed after updates and is waiting for a look" at priority 70 under the existing `site_incident` kind.

- [ ] **Step 1: Write the failing test.** An update result with one `changed` page queues exactly one `care.review` task, and the same result applied again queues none; `build` returns three image parts with the check's keys and puts the plugin names only in the untrusted block; a `fine` result marks the review and lets wave 2 draft for that group; `broken` opens one incident and no rollback job; a second `apply` changes nothing; `onExpire` gives `unsure` and the incident; Logan's `POST /api/care/checks/:id/ok` on a `pending` check marks it `logan_ok`, stales the Claude task and lets the wave go on; on a check that is not pending it answers 409.
- [ ] **Step 2: Run `npx vitest run test/care-review.test.ts`.** Expected: FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run it.** Expected: PASS.
- [ ] **Step 5: Commit** `feat(care): Claude looks at pages that changed after updates`.

---

### Task 10: Certificate expiry from the helper

**Files:**
- Create: `src/worker/care/certsKind.ts`, `helper/src/handlers/careCerts.ts`
- Modify: `src/worker/helper/kinds.ts`, `helper/src/cli.ts`, `src/worker/schedule.ts` (daily: `part("certificates", () => queueCertCheck(env, now))`)
- Test: `test/care-certs.test.ts`, `helper/test/care-certs.test.ts`

**Interfaces:**
- Produces (kind `care.certs`): payload `{ hosts: { siteId, host }[] }` (1 to 500, `host` matches `/^[a-z0-9.-]+\.[a-z]{2,}$/i`, built from `monitoredSites` whose URL passes `monitorableUrl`); result `{ certs: { siteId, validTo: string | null }[] }` (ISO date or null); `queueCertCheck(env, now)` with `dedupeKey = care.certs:<zone date>`; `apply`: for each known site, `cert_expires_on` and `cert_checked_at`; ≤ `CERT_WARN_DAYS = 14` days left (zone dates, as `domainDaysLeft`) opens `cert_expiring` ("certificate expires in 9 days" / "certificate expired 2 days ago"); more than 14 closes it; `null` changes no incident and does not stamp `cert_checked_at`.
- Helper handler: for each host, `tls.connect({ host, port: 443, servername: host, rejectUnauthorized: false, timeout: 10_000 })`, `getPeerCertificate().valid_to` → ISO date; an IP literal or a name ending `.local`/`.internal` is never connected (null); at most 5 at a time.

- [ ] **Step 1: Write the failing tests.** Helper: a fake `connect` returning `valid_to: "Dec 11 23:59:59 2026 GMT"` gives `2026-12-11`; a connect that errors or times out gives null; `10.0.0.5` and `printer.local` are never connected. Worker: 9 days left opens one incident, a second apply opens none, 60 days closes it, `null` keeps it open and leaves `cert_checked_at`; a site no longer monitored in the result is ignored; the daily cron queues one job a day.
- [ ] **Step 2: Run both.** Expected: FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run both.** Expected: PASS.
- [ ] **Step 5: Commit** `feat(care): certificate expiry from the Mac helper`.

---

### Task 11: Health, Today, routes and the MCP read tool

**Files:**
- Modify: `src/worker/clients/health.ts` and `src/worker/clients/healthData.ts` (two deductions, Call 14), `src/worker/today.ts` (`incidentAttention`: `update_failed` at 85 "updates broke acme.com: rolled back", `cert_expiring` at 66, the 24-hour pending-look reason at 70), `src/worker/routes/care.ts`, `src/worker/routes/clients.ts` (`patchSite` accepts the three new fields), the MCP tools folder (`src/worker/mcp/tools/`)
- Test: `test/care-update-routes.test.ts`, additions to `test/health.test.ts`, `test/today.test.ts`, `test/mcp-care.test.ts`, `test/mcp-leaks.test.ts`

**Interfaces:**
- Produces (routes under `/api`, behind `requireAuth`): `GET /care/updates` → `{ batch: CareBatch | null, sites: { siteId, domain, group, canUpdate: boolean, why: string | null, updates: CareUpdateView[], lastRun: CareRunView | null }[] }` (this week's batch, every Care site, `why` for one that can't update: "no SSH access", "not WordPress", "SSH alias or path missing"); `PUT /care/updates/:id` `{ held?: boolean; security?: boolean }`; `POST /care/batches` (starts this week's batch now, any weekday; 409 when one exists); `POST /sites/:id/care-run` (`startSingleRun`); `GET /care/runs/:id` (run, page checks with signed links to the three JPEGs through the existing owner R2 route); `POST /incidents/:id/close` (only `update_failed`; the others close themselves: 409). Views never include the alias, the path or the backup directory listing; the backup file name appears only on the run view and the incident.
- Produces (MCP, in `src/worker/mcp/tools/care.ts` beside `get_care_overview`): `get_care_updates` (read-only: this week's batch, per site domain, due updates with risk, last run status, open `update_failed`), never the alias, path or a page body. Tool count goes from 27 to 28.

- [ ] **Step 1: Write the failing tests.** Routes: the updates view lists a `mainwp` site with `canUpdate: false, why: "no SSH access"`; holding an update removes it from the next draft; `PUT` of an unknown id is 404; `POST /care/batches` twice is 201 then 409; `POST /sites/:id/care-run` on a test site is 201 and on an archived one 409; `patchSite` with alias `a;b` is 400 with the sentence and with `client-1` saves; `care_paths` with six entries or `//evil.com` is 400; `POST /incidents/:id/close` closes an `update_failed` and refuses a `down`; no response body contains the alias or path (search the JSON). Health: an open `update_failed` is −15 and a `cert_expiring` −15, and the board, the client record and `get_care_overview` agree. Today: `update_failed` shows at 85 above a domain warning; the MCP tool returns finite numbers and no alias.
- [ ] **Step 2: Run the four files.** Expected: FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run them, then `npm test`.** Expected: PASS (known flakes aside).
- [ ] **Step 5: Commit** `feat(care): update routes, Today, health and get_care_updates`.

---

### Task 12: The pages

**Files:**
- Create: `src/client/pages/CareUpdates.tsx`, `src/client/careUpdatesView.ts`
- Modify: `src/client/pages/Care.tsx` (an "Updates" tab), `src/client/pages/CarePanel.tsx` (last run, "Run updates on this site" button, the three site fields), the site edit form, `src/client/App.tsx` routes
- Test: `test/client-care-updates-view.test.ts`

**Interfaces:**
- Consumes: Task 11 routes.
- Produces: `/care/updates` lists this week's batch: per site the due updates with risk chip in words ("major · waits until 9 Dec", "security", "needs your OK"), a Hold and a Security switch per update, sites that can't update with their reason, and a "Start this week's batch now" button; `/care/runs/:id` shows each page's before, after and difference images side by side (stacked at phone width), its verdict and review, and a "Looks fine" button for a pending one; the client Care panel shows the last run and "Run updates on this site" (it makes an approval; the button says so). Pure helpers in `careUpdatesView.ts`: `riskLabel(u, now, zone)`, `runLabel(r)`, `whyLabel(why)`.

- [ ] **Step 1: Write the failing test** for the three helpers (a major first seen 3 days ago reads "major · waits until <date in the zone>"; a held one reads "held"; each run status has a sentence).
- [ ] **Step 2: Run it.** Expected: FAIL.
- [ ] **Step 3: Build the pages.** Text labels, not colour alone; images have `alt` ("before", "after", "difference"); buttons use `aria-disabled` while a request runs.
- [ ] **Step 4: Run it, `npm run typecheck`, `npm run build`.** Expected: PASS.
- [ ] **Step 5: Commit** `feat(care): updates board, run view and site controls`.

---

### Task 13: The end-to-end test, the helper README and the open-items note

**Files:**
- Create: `test/care-updates-flow.test.ts`, `docs/superpowers/notes/2026-11-plan-12-open-items.md`
- Modify: `helper/README.md` (a "Care updates" section: the `~/.ssh/config` alias, `BatchMode`, Chrome path, what the helper runs and never runs, how to rehearse on a throwaway WordPress site), `README.md` (Care limits line)

- [ ] **Step 1: Write the flow test.** Fixed clock Wednesday 2 December 2026, 09:00 Los Angeles. Three Care clients (brochure sites; one cheapest), one `mainwp` Care client, one test client with a test site, one client without Care. Fakes: the helper is played by the test (claim, upload fake JPEG bytes to the given keys, complete with chosen results through the real `/helper` routes and a real device token); the mail transport must see nothing. Story: the daily cron queues three inventories (not the `mainwp`, test or no-Care sites); completing them drafts one wave-1 approval naming the cheapest site; a major seen today is in no wave; approving it queues one `care.update` job whose payload carries the alias and path and nothing else secret; the canary completes `ok` with one `changed` page; a `care.review` task appears, wave 2 is not drafted; Claude's `fine` through the queue's real completion drafts wave 2 for the other two; approving it; one completes `ok`, one `rolledBack` (plugin `x`, page `/contact` 500): one `update_failed` incident, one CARE-5 task, Today row at 85, health −15, `care_rolled_back` on the timeline; the clean clients' CARE-1 tasks are `done`, the rolled-back client's has 1.6 open; a single-site run on the test site works end to end; the certificate job with 9 days left opens `cert_expiring`; at the end the approvals are exactly the three wave approvals and the single-site one, no mail was sent, and no MCP answer or `/api` body contains an alias, a path or a page body.
- [ ] **Step 2: Run it.** Expected: PASS, or fix the defect it finds in the task that owns it and note it.
- [ ] **Step 3: Write the README sections and the open-items note** (same shape as Plan 11's: what was built, Needs Logan (apply 0062 with a restore bookmark first, deploy, update the helper to 0.2.0, add the SSH alias and path on one throwaway WordPress site and rehearse a single-site run, confirm Chrome and ffmpeg paths with `doctor`, look at the pages at phone width, allow `get_care_updates` in Claude Code), the calls, rulings, known gaps, rollback).
- [ ] **Step 4: Run `npm test`, `npm run test:helper`, `npm run typecheck`, `npm run build`.** Expected: PASS (known flakes aside).
- [ ] **Step 5: Commit** `test(care): update batch flow; docs: Plan 12 notes`.
