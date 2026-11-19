# Agency OS — Plan 3 of 5: Video Audits Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Turn a full audit into a narrated video Logan approves, host it on the lead's `/r/<token>` page with view tracking, and make Email 1 carry its link and a GIF preview. Narration and rendering run free on Logan's Mac.

**Architecture:** A Workflow captures screenshot shots; Claude writes the script and pre-places markups through the Plan 2.5 task queue (kind `video.script`); Logan edits both in an annotation editor and approves. Approval enqueues Mac-helper jobs (per-line voice, then render) in a new `helper_jobs` table that a small Node CLI on the laptop polls with its own revocable token. A finished render creates a `video.publish` approval; approving it makes the existing public report page show the video. Everything the helper does is idempotent, and nothing client-facing depends on the Mac being on.

**Tech Stack:** Existing stack, plus a Node 22 helper in `helper/` (no runtime dependencies: `fetch`, `child_process`), mlx-audio (Qwen3-TTS), Chatterbox, OpenVoice V2, ffmpeg/ffprobe and HyperFrames (all local, $0).

**Spec:** `docs/superpowers/specs/2026-11-17-agency-os-design.md` (source: `/Users/loganirish/Project Sites/agency/docs/specs/2026-11-17-agency-os-design.md`). Sections implemented: §5 (Mac helper, client pages, Workflows), §9.2 (video pipeline, all 8 points except report videos, point 8), §9.3 (Email 1 carries the video), §9.13 (queue, approval inbox), §12 Phase 1 line "Video audit pipeline, including the Mac helper (voice + HyperFrames) and the voice A/B test".

**Phase 1 roadmap:** 1 Foundations (done) · 2 Mail + sequences (done) · 2.5 Queue migration (assumed landed) · **3 Video audits (this plan)** · 4 Sales · 5 Close.

**Starts from:** `main` after Plan 2.5 is merged. This plan relies on 2.5's `registerTaskKind`/`TaskKindDef`, `enqueueTask`, `completeTask`, `work-the-queue` skill and `QueueCard`. Migration numbers below are placeholders: take the next free number after the last one on `main`, in order.

## Global Constraints

- Branch `feat/agency-os-video` from `main`. One task per commit group; `npm test && npm run typecheck` pass after every task. Never edit an applied migration.
- Claude never uses the paid API (spec §2 goal 5): script writing is a queue task. Voice is free open-source models only, run locally (spec §9.2 point 4): Qwen3-TTS via mlx-audio, Chatterbox (MIT), OpenVoice V2 (MIT). No paid voice service.
- Nothing becomes visible to a prospect without Logan's approval (spec §2): the video page content is gated by an approved `video.publish` approval. The helper and the queue worker can never approve, publish or send.
- Footer note "Narrated with an AI version of my voice" is on by default and shown only when the narration is cloned (spec §9.2 point 7).
- Script length is "about 90–120 seconds" (spec §9.2 point 3): validation accepts an estimated 80–130 seconds at 150 words per minute. Structure: hook, exactly 3 problems each with its business result, the offer, one CTA to book a call.
- Cold links use the host in `OUTREACH_LINK_BASE` (a hellositeline.com subdomain), never `workers.dev` and never the brand domain (spec §5). Video, GIF and poster are served under that same host.
- Scraped site content (page text, screenshots) is untrusted data, always delivered inside the queue bundle's delimited block (Plan 2.5).
- The helper authenticates with its own revocable device token (spec §5), never `MCP_TOKEN` or the login cookie. It may read and write only R2 keys under the job's own `video/<videoId>/` or `voice-tests/<testId>/` prefix.
- No Webfor names, content or pricing. Follow existing patterns: zod validation, DB helpers in `src/worker/db/*.ts`, pure view helpers in `src/client/*View.ts` with tests in `test/*-view.test.ts`. Run from the worktree. Test: `npm test`; helper tests `npm run test:helper`; types `npm run typecheck`.

## Scope decisions (flag to Logan)

- **"Scroll capture" is shot slices, not a screen recording.** Capture stores up to 4 desktop slices (1440 wide, one viewport tall, evenly spaced down the page) and 2 mobile screens (390 wide). The render pans and zooms over them. A live scroll recording is a later upgrade.
- **Two human gates.** (1) The editor: Logan edits script lines and markups, then approves; that starts voice and render. (2) The finished MP4 arrives in the approval inbox as `video.publish`; approving it makes the page live. Rejecting sends him back to the editor.
- **Script lines re-record one at a time.** Narration is stored per line, so re-synthesizing or re-recording a line does not redo the rest. Browser recording uses `MediaRecorder` (webm/opus); the helper converts it with ffmpeg.
- **Voice engine is unset until the A/B test is done.** With no engine picked, new videos default to "record yourself". The test is blind: three engines read the same line, labelled A/B/C, and the names show after Logan picks.
- **Booking link is a setting for now.** `settings.booking_url` holds Logan's current link; Plan 4's built-in booking page replaces it.
- **One campaign switch, `video_email`.** When on, Email 1 needs a published video (otherwise the sequence will not start) and carries the link plus the GIF. When off, behavior is unchanged.
- **Semantic validation uses Plan 2.5's `TaskRefused`.** `video.script`'s `apply` throws it when a finding code or shot id is unknown, which returns the message to the worker and keeps the task claimable. Its `onExpire` and `onFail` hooks set the video to `failed` so it never waits forever.
- **HyperFrames is unverified at build time** (research notes v0.9.65). Task 9 starts with a spike on Logan's Mac and stops there if the CLI differs.
- **Cut line (spec §12):** if Phase 1 runs long, drop Task 10's Today card and watch depth (keep play/complete events), then drop the GIF hero from Task 11. The Mac helper, editor and publish gate stay.

## Review Focus

1. **Nothing goes public unapproved.** A rendered but unapproved, rejected, or other-audit video must never be served. Tests in Task 8: `unpublished video is not served`, `rejected video can be re-edited and returns to review`, `token for another audit does not serve this video`.
2. **A stolen or confused helper is contained.** A revoked token, a path outside the job's prefix, an oversized upload, two helpers claiming one job, or a result for another video must all fail. Tests in Task 5.
3. **Mac offline and mid-job death.** A claimed job whose helper vanished is reclaimed; jobs older than 14 days expire; editing a line after its audio exists invalidates only that line; a render never uses a plan older than the approved one. Tests in Tasks 5 and 9.
4. **Real-device playback and noisy views.** Safari needs `206` Range responses, and mail scanners prefetch links. Views count only from the page's own beacon, not from fetching the page or video. Tests in Tasks 8 and 10.
5. **A script that claims things the audit does not say.** A problem line must cite a real finding code from this audit, shot ids and coordinates must exist, and the script must land in the length window. Test in Task 3: `script citing an unknown finding is sent back with the reason`.

---

### Task 1: Branch and baseline

**Files:**
- Modify: `package.json` (script `test:helper`), `.gitignore` (`helper/node_modules`, `helper/.cache`)

- [ ] **Step 1: Confirm Plan 2.5 landed.** Run: `git log --oneline main | head -20 && git grep -n "ANTHROPIC_API_KEY" -- src | head`. Expected: the queue commits are on `main` and no source file names the key. If not, stop and tell Logan: this plan assumes the registry from 2.5.
- [ ] **Step 2: Branch in the worktree.** Run: `cd ../site-search-agency-os && git switch main && git pull && git switch -c feat/agency-os-video`. Expected: clean tree.
- [ ] **Step 3: Baseline is green.** Run: `npm test && npm run typecheck`. Expected: all pass. If anything fails, stop and report it.
- [ ] **Step 4: Add the `test:helper` script** (`vitest run --config helper/vitest.config.ts`, created in Task 7) and the two ignore lines. Run: `npm run typecheck`. Expected: PASS.
- [ ] **Step 5: Commit** — `git add -A && git commit -m "chore: video audit plan baseline"`

---

### Task 2: Video plan model and records

**Files:**
- Create: `migrations/<next free>_video_audits.sql`, `src/worker/video/plan.ts`, `src/worker/db/videoAudits.ts`
- Test: `test/video-plan.test.ts`, `test/video-audits-db.test.ts`

**Interfaces:**
- Produces (`video/plan.ts`; coordinates are fractions 0–1 of a shot's full-size image):
  - `Shot { id: string; viewport: "desktop" | "mobile"; scrollY: number; width: number; height: number; fullKey: string; previewKey: string }`
  - `Markup`, a zod discriminated union on `type`: `circle { x, y, r }`, `arrow { from: {x,y}, to: {x,y} }`, `blur { x, y, w, h }`, `callout { x, y, text }` (text one line, at most 60 chars).
  - `Segment { id: string; role: "hook" | "problem" | "offer" | "cta"; findingCode?: string; text: string; shotId: string; focus?: { x, y, w, h }; markups: Markup[]; audio?: { key: string; source: "clone" | "recorded"; durationMs: number; textHash: string } }`
  - `VideoPlan { shots: Shot[]; segments: Segment[]; narration: "clone" | "recorded"; version: number }`; whether the AI-voice note shows is derived, never stored: `settings.ai_voice_note` is on and at least one line has `audio.source "clone"`
  - `DraftPlanSchema`: what Claude returns: `{ segments: Omit<Segment,"audio">[] }`. Structural rules in `superRefine`: first segment `hook`, last `cta`, exactly one `offer`, exactly 3 `problem` segments with distinct `findingCode`, each line 5–60 words, at most 6 markups per segment, every coordinate within 0–1.
  - `estimateDurationMs(text: string): number` (words ÷ 150 wpm); `planDurationMs(segments): number` sums lines plus 350 ms gaps; `SCRIPT_MS = { min: 80_000, max: 130_000 }`.
  - `checkPlanAgainst(plan: Pick<VideoPlan,"shots"|"segments">, findingCodes: string[]): string[]`: human-readable problems (unknown `shotId`, unknown `findingCode`, duration outside `SCRIPT_MS`); empty means fine.
  - `lineStale(seg: Segment): boolean`: true when `audio` is missing or `audio.textHash` no longer matches `hashText(seg.text)`; `hashText(text: string): string`.
- Produces (`db/videoAudits.ts`): table `video_audits(id, business_id, audit_id, status, plan, steering_note, video_key, gif_key, poster_key, duration_ms, publish_approval_id, error, created_at, updated_at, published_at)`, `status` in `capturing | scripting | review | producing | rendered | published | failed | cancelled`, `plan` JSON text. A partial unique index allows one open video (status not `failed`/`cancelled`) per `audit_id`.
  - `createVideoAudit(db, o: { businessId: string; auditId: string }): Promise<VideoAudit | null>` (null when one is open), `getVideoAudit(db, id)`, `latestVideoFor(db, businessId)`, `savePlan(db, id, plan: VideoPlan)` (bumps `version`), `setVideoStatus(db, id, status, patch?)`, `publishedVideoForAudit(db, auditId)`.

- [ ] **Step 1: Write the failing tests.** `test/video-plan.test.ts`: `accepts a hook, three problems, an offer and a cta`; `rejects two offers`; `rejects four problems`; `rejects repeated finding codes`; `rejects a coordinate of 1.2`; `rejects a 70-word line`; `a 225-word script estimates 90 seconds`; `checkPlanAgainst names an unknown shot and an unknown finding code`; `a 40-second script is outside the window`; `lineStale is true after the text changes`. `test/video-audits-db.test.ts`: `second open video for one audit returns null`; `a failed video frees the audit`; `savePlan bumps version`.
- [ ] **Step 2: Run** `npx vitest run test/video-plan.test.ts test/video-audits-db.test.ts`. Expected: FAIL (modules missing).
- [ ] **Step 3: Implement** the migration, `plan.ts` and `db/videoAudits.ts`.
- [ ] **Step 4: Run all** `npm test && npm run typecheck`. Expected: PASS.
- [ ] **Step 5: Commit** — `git add -A && git commit -m "feat(video): plan model, validation and records"`

---

### Task 3: Capture and the script task

**Files:**
- Create: `src/worker/video/capture.ts`, `src/worker/queue/videoScript.ts`, `src/worker/routes/video.ts`
- Modify: `src/worker/workflows.ts` (class `VideoAuditWorkflow`), `wrangler.jsonc` (workflow binding `VIDEO_WORKFLOW`), `src/worker/env.ts`, `vitest.config.ts`, `src/worker/index.ts` (mount `/api/video-audits` and `POST /api/leads/:id/video`), `.claude/skills/work-the-queue/SKILL.md` (one line naming `video.script`)
- Test: `test/video-capture.test.ts`, `test/video-script.test.ts`

**Interfaces:**
- Consumes: Task 2; Plan 2.5's `registerTaskKind`, `enqueueTask`, `completeTask`; the existing Browser Rendering helpers in `src/worker/render/render.ts`; `getSettings` (`your_name`, `business_name`, `bio`, `tone_preset`, `tone_notes`, `services_blurb`).
- Produces:
  - `captureShots(env, videoId: string, url: string, deps?: { browser: BrowserLike }): Promise<Shot[]>`: up to 4 desktop slices and 2 mobile screens, JPEG q85 stored at `video/<videoId>/shots/<id>.jpg`, plus a preview of at most 1 MB (width 1000, q70) at `…/<id>.preview.jpg`. Shot ids `d1..d4`, `m1..m2`.
  - Kind `video.script`: payload `{ videoId: string; steeringNote?: string | null }` (dedupe key `videoId`); result `DraftPlanSchema`; `suggestedModel "sonnet"`. `build` returns the instructions (structure, length window in words, "speak as <your_name> in the first person", the voice settings, "state each problem with its business result; promise no rankings, revenue or timelines; do not read out a URL; one CTA to book a call") and the untrusted parts: the audit's findings (code, severity, evidence), business facts, and the shot previews as images with their ids. `apply` first runs `checkPlanAgainst` with the audit's finding codes and throws `TaskRefused(problems.join("; "))` when it returns any; then it stores the plan (`narration` from `defaultNarration(settings): "clone" | "recorded"`, which returns `"recorded"` in this task because `voice_engine` does not exist until Task 6, which changes it to `"clone"` when `settings.voice_engine` is set), sets status `review`; stale when the video is no longer `scripting`, the audit is no longer the lead's latest, or the lead is suppressed. `onExpire` and `onFail` set the video `failed` with `"Claude didn't write the script. Try again."` when it is still `scripting`.
  - `VideoAuditWorkflow` steps: `capture` (sets status `capturing`, saves shots) then `enqueue-script`; a capture failure sets `failed` with the error text.
  - Routes (authed): `POST /api/leads/:id/video` → `202 { videoId }`, 409 if one is open, 422 if the lead has no full audit; `GET /api/video-audits/:id` (video, plan, jobs, state line); `POST /api/video-audits/:id/regenerate-script { steeringNote?: string }` (only from `review`; sets status `scripting` and enqueues a fresh `video.script`, and the editor keeps showing the current plan until the new one is applied) → 202.

- [ ] **Step 1: Write the failing tests.** `test/video-capture.test.ts` (fake browser): `stores full and preview for every shot`; `a page shorter than a screen yields one desktop slice`; `preview is under 1 MB`. `test/video-script.test.ts`: `lead video request creates one capture and returns 202`; `second request returns 409`; `script task bundle puts findings and shots in the untrusted block only`; `script citing an unknown finding is sent back with the reason` (task stays claimable); `a 40-second script is sent back`; `valid script lands in review with narration recorded when no engine is set`; `superseded audit makes the task stale`; `suppressed lead makes the task stale`; `regenerate is refused outside review`; `expired script task fails the video`.
- [ ] **Step 2: Run** `npx vitest run test/video-capture.test.ts test/video-script.test.ts test/queue.test.ts`. Expected: FAIL.
- [ ] **Step 3: Implement.** Reuse the existing screenshot code for the browser session; do not change the lead pipeline's own screenshots.
- [ ] **Step 4: Run all + build** `npm test && npm run typecheck && npm run build`. Expected: PASS.
- [ ] **Step 5: Commit** — `git add -A && git commit -m "feat(video): shot capture and the Claude script task"`

---

### Task 4: Annotation editor and script review

**Files:**
- Create: `src/client/videoView.ts`, `src/client/pages/VideoEditor.tsx`, `src/client/components/video/{ShotCanvas,SegmentList,RecordButton}.tsx`
- Modify: `src/client/App.tsx` (route `/leads/:id/video`), `src/client/pages/LeadDetail.tsx` (a "Video audit" panel with the state line and a button), `src/worker/routes/video.ts`
- Test: `test/video-view.test.ts`, `test/video-editor-routes.test.ts`

**Interfaces:**
- Consumes: Tasks 2–3; `GET /api/video-audits/:id`.
- Produces routes (authed): `PUT /api/video-audits/:id/plan { segments, narration }` (only in `review`; re-validates with the plan schema and `checkPlanAgainst`; keeps `audio` on lines whose text hash is unchanged); `PUT /api/video-audits/:id/segments/:segId/recording` (raw `audio/webm` or `audio/wav` body at most 8 MB, sets `audio.source "recorded"`, `durationMs` from a header the client measured); `POST /api/video-audits/:id/approve` → calls `startProduction(env, videoId)` from the new `src/worker/video/production.ts` (this task creates it and it only sets status `producing`; Task 5 adds the helper jobs) and returns 202; 409 unless `review` and `checkPlanAgainst` is empty.
- Produces (`videoView.ts`, all pure): `moveMarkup(m: Markup, dx: number, dy: number): Markup` (clamps to 0–1), `addMarkup(seg: Segment, type: Markup["type"]): Segment` (default placement at the centre), `scriptSummary(plan: VideoPlan): { words: number; seconds: number; inWindow: boolean }`, `approveBlockers(plan: VideoPlan, findingCodes: string[]): string[]`, `videoStateLine(v: { status: string; jobs: { kind: string; status: string }[]; helperOnline: boolean }): string`. Exact copy: `scripting` → `"Waiting for Claude. The script will be written in your next queue session."`; `review` → `""`; `producing` with the helper offline → `"Waiting for your Mac. Voice and video are made when the helper is running."`; `producing` online → `"Making the video."`; `rendered` → `"Ready to approve. Watch it, then approve it in the inbox."`; `published` → `"Live on the report page."`; `failed` → `"Something went wrong: "` plus the error.
- The editor: left, the segment list (edit text, change shot, choose narration source per line, re-record or regenerate one line); right, the shot with an SVG overlay for markups (drag, resize, delete; blur and callout text). Autosave on blur; a banner while a regenerate-script task is queued ("Write it myself" simply keeps editing).

- [ ] **Step 1: Write the failing tests.** `test/video-view.test.ts`: `moveMarkup clamps at the edges`; `addMarkup puts a callout at the centre with empty text rejected by approveBlockers`; `scriptSummary reports 225 words as 90 seconds and in window`; `approveBlockers lists a missing recording for a recorded line`; the seven `videoStateLine` strings above. `test/video-editor-routes.test.ts`: `plan edit outside review is refused`; `unchanged line keeps its audio, edited line loses it`; `recording upload over 8 MB is refused`; `approve is refused with blockers and returns them`; `approve twice starts production once`.
- [ ] **Step 2: Run** `npx vitest run test/video-view.test.ts test/video-editor-routes.test.ts`. Expected: FAIL.
- [ ] **Step 3: Implement.** No component tests; keep logic in `videoView.ts`.
- [ ] **Step 4: Run all + build** `npm test && npm run typecheck && npm run build`. Expected: PASS.
- [ ] **Step 5: Commit** — `git add -A && git commit -m "feat(video): annotation editor and script review"`

---

### Task 5: Helper job queue and device tokens

**Files:**
- Create: `migrations/<next free>_helper_jobs.sql`, `src/worker/helper/{jobs,auth,kinds}.ts`, `src/worker/routes/helper.ts`, `src/worker/routes/helperAdmin.ts`, `src/client/helperView.ts`, `src/client/components/home/HelperCard.tsx`, `src/client/pages/settings/Helper.tsx`
- Modify: `wrangler.jsonc` (`run_worker_first` adds `"/helper/*"`), `src/worker/index.ts` (mount `/helper` before `requireAuth`'s scope; mount `/api/helper`), `src/worker/schedule.ts` (daily run expires old helper jobs), `src/worker/video/production.ts` (extend `startProduction` from Task 4), `src/client/pages/Today.tsx`, `src/client/App.tsx`
- Test: `test/helper-jobs.test.ts`, `test/helper-routes.test.ts`, `test/helper-view.test.ts`

**Interfaces:**
- Produces tables `helper_devices(id, name, token_hash, created_at, last_seen_at, revoked_at)` and `helper_jobs(id, kind, video_id, payload, status, dedupe_key, attempts, claimed_at, claimed_by, result, error, created_at, done_at)`, `status` in `pending | claimed | done | failed | expired`; one open job per `(kind, dedupe_key)`.
- Produces (`helper/kinds.ts`): `interface HelperKindDef<P, R> { kind: string; payload: z.ZodType<P>; result: z.ZodType<R>; inputs(p: P): string[]; outputs(p: P): string[]; apply(env, p: P, r: R): Promise<void> }` (`inputs`/`outputs` are R2 keys; `outputs` are exact keys the job may write), `registerHelperKind`, `getHelperKind`. Kinds: this task registers `voice.segment` (payload `{ videoId, segmentId, engine, text }`, result `{ key: string; durationMs: number }`, output key `video/<videoId>/audio/<segmentId>-<hashText(text)>.wav`); Task 6 registers `voice.sample`; Task 9 registers `render`.
- Produces (`helper/jobs.ts`): `enqueueHelperJob(db, kind, payload: unknown, o?: { videoId?: string; dedupeKey?: string }): Promise<{ id: string; created: boolean }>`; `claimHelperJob(db, deviceId: string, now: Date, kinds?: string[]): Promise<HelperJob | null>` (atomic; reclaims claims older than 20 minutes and counts `attempts`; the fourth reclaim fails the job); `completeHelperJob(env, id, deviceId, result: unknown): Promise<{ ok: true } | { ok: false; error: string }>` (validates with the kind's schema, runs `apply`, a second completion returns `already done`); `failHelperJob(db, id, deviceId, error: string)`; `expireOldHelperJobs(db, now, maxAgeDays = 14): Promise<number>`; `helperStatus(db, now): Promise<{ online: boolean; lastSeenAt: string | null; pending: Record<string, number> }>` (online means seen within 3 minutes).
- Produces (`video/production.ts`): `startProduction(env, videoId: string): Promise<void>`: sets status `producing` and enqueues one `voice.segment` job per line with `source "clone"` that is `lineStale` (dedupe key `videoId:segId:hash`); when every line has audio (including recorded ones), enqueues `render` (Task 9 defines its payload; this task calls `enqueueRender(env, videoId)`, a stub exported from `video/production.ts` until Task 9). A job's `apply` for `voice.segment` writes `audio` onto the line only if the line text hash still matches, then calls `enqueueRender` when the last line is done.
- Helper HTTP API (bearer token `hlp_` + 32 random bytes, base64url; only its SHA-256 is stored; shown once at creation):
  - `POST /helper/hello` → `{ serverTime, minHelperVersion }`, updates `last_seen_at`
  - `POST /helper/jobs/claim { kinds?: string[] }` → `{ job } | {}` with the job's `inputs` and `outputs` lists
  - `GET /helper/jobs/:id/input?key=` streams an R2 object only if `key` is in the job's `inputs`
  - `PUT /helper/jobs/:id/output?key=` writes only if `key` is in the job's `outputs`; refuses bodies over 80 MB
  - `POST /helper/jobs/:id/complete { result }`, `POST /helper/jobs/:id/fail { error }`
- Admin routes (authed): `GET /api/helper/status`, `GET/POST /api/helper/devices` (POST returns the token once), `DELETE /api/helper/devices/:id`.
- `helperView.ts`: `helperLine(s: { online: boolean; pending: Record<string, number> }): string`. Exact copy: online → `"Your Mac helper is online."`; offline with nothing waiting → `"Your Mac helper is offline."`; offline with n waiting → `` `Your Mac helper is offline. ${n} job${n === 1 ? "" : "s"} waiting.` ``. `HelperCard` sits on Today under the queue card.

- [ ] **Step 1: Write the failing tests.** `test/helper-jobs.test.ts` with two test-only kinds: `enqueue twice with one key creates one job`; `claim is atomic across two devices`; `stale claim is reclaimed and attempts counted`; `fourth reclaim fails the job`; `invalid result is rejected and applies nothing`; `completing twice applies once`; `completion from a device that does not hold the claim is refused`; `expireOldHelperJobs expires after 14 days`; `startProduction enqueues one voice job per stale cloned line and none for recorded lines`; `finishing the last line enqueues one render`; `a late result for an edited line is discarded`. `test/helper-routes.test.ts`: `revoked token gets 401`; `no token gets 401`; `input outside the job's list is refused`; `output outside the job's list is refused`; `upload over 80 MB is refused`; `hello updates last_seen_at`; `device creation returns the token once and never again`; `helper routes never accept the login cookie`. `test/helper-view.test.ts`: the three `helperLine` strings.
- [ ] **Step 2: Run** `npx vitest run test/helper-jobs.test.ts test/helper-routes.test.ts test/helper-view.test.ts`. Expected: FAIL.
- [ ] **Step 3: Implement.** Compare tokens by hash with a constant-time check; log one `agent_actions` row per claim and completion (`actor "helper"`).
- [ ] **Step 4: Run all + build** `npm test && npm run typecheck && npm run build`. Expected: PASS.
- [ ] **Step 5: Commit** — `git add -A && git commit -m "feat(helper): job queue, device tokens and helper API"`

---

### Task 6: Voice reference, A/B test and settings

**Files:**
- Create: `migrations/<next free>_video_settings.sql`, `src/worker/video/voiceTest.ts`, `src/worker/routes/voiceTest.ts`, `src/client/pages/settings/VoiceTest.tsx`, `src/client/voiceTestView.ts`
- Modify: `src/worker/queue/videoScript.ts` (`defaultNarration` reads `voice_engine`), `src/worker/types.ts` and `src/worker/db/settings.ts` (new fields), `src/worker/routes/settings.ts` (`booking_url`, `ai_voice_note` editable), `src/client/pages/settings/SettingsHome.tsx`, `src/client/App.tsx`
- Test: `test/voice-test.test.ts`, `test/voice-test-view.test.ts`

**Interfaces:**
- Migration: `settings` gains `voice_engine TEXT NULL CHECK (voice_engine IN ('qwen3-tts','chatterbox','openvoice-v2'))`, `voice_ref_key TEXT NULL`, `booking_url TEXT NOT NULL DEFAULT ''`, `ai_voice_note INTEGER NOT NULL DEFAULT 1`; new table `voice_tests(id, created_at, line_text, labels TEXT, chosen TEXT NULL)` where `labels` is JSON `{ A: engine, B: engine, C: engine }`.
- Produces (`voiceTest.ts`): `createVoiceTest(env, lineText?: string): Promise<{ id: string }>` (requires `voice_ref_key`; shuffles the labels; enqueues three `voice.sample` jobs, payload `{ testId, engine, line, refKey }`, output key `voice-tests/<testId>/<engine>.wav`; the default line is a 20-second read of a sample script paragraph kept in the file); `chooseVoice(db, testId, label: "A" | "B" | "C"): Promise<{ engine: string }>` (sets `settings.voice_engine`, stores `chosen`); kind `voice.sample` (result `{ durationMs: number }`; `apply` is a no-op).
- Routes (authed): `PUT /api/settings/voice-reference` (raw audio, 30–120 s measured by the client and re-checked by the helper, at most 15 MB; stores `voice-reference/reference.<ext>` and sets `voice_ref_key`); `POST /api/voice-tests` → 202; `GET /api/voice-tests/latest` (labels hidden until `chosen`; clips as authed media URLs, and which clips are still pending); `POST /api/voice-tests/:id/choose { label }`.
- `voiceTestView.ts`: `voiceTestLine(t: { pending: number; chosen: string | null }): string`. Exact copy: pending → `` `Waiting for your Mac: ${pending} of 3 clips left.` ``; all ready and unchosen → `"Listen to A, B and C, then pick the one that sounds most like you."`; chosen → `"Picked. New videos will use this voice."` Page also offers "None of these: I'll record my own", which sets `voice_engine` to null and shows the recording instructions.

- [ ] **Step 1: Write the failing tests.** `test/voice-test.test.ts`: `test needs a reference recording first` (409); `creates three jobs with distinct engines under shuffled labels`; `labels are hidden until a pick`; `choosing sets the engine and reveals the names`; `choosing twice is refused`; `second test replaces the pending one` (old jobs cancelled); `reference over 15 MB is refused`. `test/voice-test-view.test.ts`: the three strings.
- [ ] **Step 2: Run** `npx vitest run test/voice-test.test.ts test/voice-test-view.test.ts`. Expected: FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run all + build** `npm test && npm run typecheck && npm run build`. Expected: PASS.
- [ ] **Step 5: Commit** — `git add -A && git commit -m "feat(video): voice reference, blind A/B test and video settings"`

---

### Task 7: The Mac helper (loop, voice engines, ffmpeg)

**Files:**
- Create: `helper/package.json`, `helper/tsconfig.json`, `helper/vitest.config.ts`, `helper/README.md`, `helper/launchd/com.siteline.helper.plist`, `helper/src/{cli,config,api,loop,ffmpeg}.ts`, `helper/src/voice/{engine,qwen3,chatterbox,openvoice,python}.ts`, `helper/src/handlers/{voiceSegment,voiceSample}.ts`, `helper/scripts/{qwen3.py,chatterbox.py,openvoice.py}`
- Test: `helper/test/{loop,api,ffmpeg,config,voice-handlers}.test.ts`, `helper/test/fixtures/`

**Interfaces:**
- Produces (`helper/src`):
  - `loadConfig(path?: string): Config`, with `Config { apiBase: string; token: string; pollSeconds: number; cacheDir: string; python: Record<"qwen3-tts" | "chatterbox" | "openvoice-v2", string>; ffmpeg: string; ffprobe: string; hyperframes: string }`, read from `~/.siteline-helper/config.json`; an invalid file throws a message naming the bad field.
  - `ApiClient`: `hello()`, `claim(kinds)`, `download(jobId, key, toPath)`, `upload(jobId, key, fromPath, contentType)`, `complete(jobId, result)`, `fail(jobId, error)`; a `401` throws `TokenRevoked` and the loop exits with a clear message.
  - `JobHandler { kind: string; run(ctx: { job: ClaimedJob; api: ApiClient; cfg: Config; workDir: string }): Promise<unknown> }`; `runLoop(deps: { api; handlers: JobHandler[]; sleep(ms): Promise<void>; once?: boolean }): Promise<void>`: claims, runs in a fresh temp work dir, completes with the handler's result, reports `fail` with the error text on a throw, deletes the work dir, and never lets one job's failure stop the loop.
  - `probeDurationMs(file: string, cfg): Promise<number>` (ffprobe), `toWav(inFile, outFile, cfg)` (mono 24 kHz PCM, loudness-normalised with `loudnorm`), `parseProbe(json: string): number`.
  - `VoiceEngine { id: "qwen3-tts" | "chatterbox" | "openvoice-v2"; available(): Promise<{ ok: boolean; why?: string }>; synth(o: { text: string; refAudioPath: string; outPath: string }): Promise<void> }`, each adapter running its `helper/scripts/*.py` in the configured venv through `runPython(py: string, script: string, args: string[]): Promise<void>` (timeout 5 minutes per line).
  - Handlers: `voice.segment` (payload `{ videoId, segmentId, engine, text }`; downloads the reference, synthesizes, converts, uploads to `video/<videoId>/audio/<segmentId>-<hash>.wav`, returns `{ key, durationMs }`) and `voice.sample` (returns `{ durationMs }`). Recorded lines are not helper jobs; the render handler converts them (Task 8).
- CLI: `npx tsx helper/src/cli.ts run | once | doctor | pair <apiBase> <token>`. `doctor` prints, per engine, `available()` and ffmpeg/ffprobe/hyperframes versions.
- The helper keeps no state other than `config.json` and the cache dir; deleting the cache is always safe.

- [ ] **Step 1: Write the failing tests** (node environment; fake `ApiClient`, fake engine, fixture ffprobe output): `loop claims, runs the handler, completes with its result`; `a handler throw reports fail and the loop continues`; `a 401 stops the loop with the revoked message`; `two idle polls sleep pollSeconds twice`; `work dir is removed after success and after failure`; `config naming a missing field says which`; `parseProbe reads seconds into milliseconds`; `voice.segment uploads to the hashed key and returns its duration`; `an unavailable engine fails the job with the engine's reason`; `voice.sample for each engine uses the same line and reference`.
- [ ] **Step 2: Run** `npm run test:helper`. Expected: FAIL.
- [ ] **Step 3: Implement** the helper. The three Python scripts are thin wrappers (read text and reference path, write a wav); read each library's README at its pinned version for the call. Write `README.md` (install, `pair`, the venv setup per engine, launchd load and unload) and the plist (`KeepAlive`, `RunAtLoad`, logs in `~/Library/Logs/siteline-helper.log`).
- [ ] **Step 4: Run all** `npm run test:helper && npm test && npm run typecheck`. Expected: PASS.
- [ ] **Step 5: Engine spike (needs Logan; do not skip).** On his Mac: create the three venvs, run `doctor`, put a clean 60-second reference recording through Task 6's upload, create a voice test from the page, run `once` until three clips arrive. Record in `docs/superpowers/notes/2026-11-voice-engines.md`: install steps that worked, seconds to synthesize 20 seconds of speech per engine, and which engine Logan picked. **Gate:** if no engine sounds right, Logan switches new videos to "record yourself" (already the default with no engine set) and the plan continues.
- [ ] **Step 6: Commit** — `git add -A && git commit -m "feat(helper): Mac helper loop, voice engines and ffmpeg"`

---

### Task 8: Publish approval and the public page

**Files:**
- Create: `src/worker/approvals/videoPublish.ts`, `src/worker/video/media.ts`
- Modify: `src/worker/routes/public.ts`, `src/worker/db/reports.ts` (`PublicReport.video`), `src/worker/index.ts` (import the approval kind), `src/client/reportView.ts`, `src/client/pages/Report.tsx`, `src/client/public.css`, `src/client/pages/VideoEditor.tsx` (preview player and approve/reject buttons that call the approvals API), `src/client/approvalsView.ts` (title and link for `video.publish`)
- Test: `test/video-publish.test.ts`, `test/video-media.test.ts`; extend `test/reports.test.ts`, `test/reportview.test.ts`

**Interfaces:**
- Produces:
  - Approval kind `video.publish`: payload `{ videoId: string }`; `createPublishApproval(env, videoId): Promise<void>` stores `publish_approval_id`, with `preview` showing the lead, the duration and the script text. `execute` requires status `rendered`, a non-suppressed lead and the audit still the lead's latest; it sets `published`, `published_at`, and is idempotent. The editor reads a rejected approval as "rejected" and offers "Edit and re-render" (it returns the video to `review` and bumps `version`).
  - `PublicReport.video: { durationMs: number; aiVoiceNote: boolean } | null` (`aiVoiceNote` derived as in Task 2) and `bookingUrl: string` (from `settings.booking_url`, only `https:`), included only when `publishedVideoForAudit(db, report.audit_id)` exists. Media URLs are fixed: `/api/public/report/<token>/media/video.mp4 | poster.jpg | preview.gif`.
  - `serveMedia(env, token: string, name: string, range: string | null): Promise<Response>`: resolves the token the same way `publicReport` does; `404` for unknown, expired, revoked, malformed or unpublished; honours `Range` with `206` and `Content-Range`; sets `Accept-Ranges: bytes`, `Content-Type`, and `Cache-Control: private, max-age=3600` (the only public responses that are not `no-store`; `X-Robots-Tag` and `Referrer-Policy` stay).
  - `reportView.ts`: `videoNote(v: { aiVoiceNote: boolean }): string` returns `"Narrated with an AI version of my voice."` when on, else `""`; `bookingLabel(url: string): string` returns `"Book a 20-minute call"` for an https URL, else `""`.
  - The report page shows the player (poster, controls, no autoplay), the note, the booking button and then the existing report, unchanged.

- [ ] **Step 1: Write the failing tests.** `test/video-publish.test.ts`: `execute publishes a rendered video`; `execute twice publishes once`; `execute refuses a suppressed lead`; `execute refuses a superseded audit`; `rejected publish leaves the page without a video`; `rejected video can be re-edited and returns to review`. `test/video-media.test.ts`: `unpublished video is not served`; `token for another audit does not serve this video`; `expired and revoked tokens get 404`; `a range request returns 206 with Content-Range`; `a range past the end returns 416`; `public headers keep noindex and no referrer`; `non-https booking url is dropped`. In `test/reports.test.ts`: `public report has video only after publish`. In `test/reportview.test.ts`: the two helper strings.
- [ ] **Step 2: Run** `npx vitest run test/video-publish.test.ts test/video-media.test.ts test/reports.test.ts test/reportview.test.ts`. Expected: FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run all + build** `npm test && npm run typecheck && npm run build`. Expected: PASS.
- [ ] **Step 5: Commit** — `git add -A && git commit -m "feat(video): publish approval and the video report page"`

---

### Task 9: Render (HyperFrames composition and the render job)

**Files:**
- Create: `helper/src/render/{composition,render,gif}.ts`, `helper/src/handlers/render.ts`, `helper/test/{composition,render-handler}.test.ts`, `src/worker/video/renderJob.ts`
- Modify: `src/worker/video/production.ts` (replace the `enqueueRender` stub), `src/worker/routes/video.ts` (plan edit after production bumps `version`, returns to `review`, cancels open helper jobs)
- Test: `test/video-render-job.test.ts`

**Interfaces:**
- Produces (worker, `renderJob.ts`): `enqueueRender(env, videoId: string): Promise<void>` creates a `render` job (dedupe key `videoId:<plan.version>`) with payload `RenderPayload { videoId: string; planVersion: number; plan: { shots: Shot[]; segments: Segment[] }; brand: { name: string; business: string }; ctaText: string; inputs: string[] }`; kind `render`: result `{ videoKey: string; gifKey: string; posterKey: string; durationMs: number; bytes: number }`; outputs `video/<videoId>/out/v<planVersion>.mp4`, `.gif`, `.jpg`. `apply` is a no-op unless the video is still `producing` and `planVersion` equals the plan's current `version` (else the result is discarded); otherwise it stores the keys, sets status `rendered` and creates the `video.publish` approval with Task 8's `createPublishApproval(env, videoId)`.
- Editing the plan after production started (`PUT …/plan`) bumps `version`, returns the video to `review` and cancels its open helper jobs, so the old render is discarded.
- Produces (helper): `buildComposition(input: { plan: RenderPlan; durationsMs: Record<string, number>; brand: Brand; ctaText: string }): { files: Record<string, string>; totalMs: number; sceneStartsMs: number[] }`, pure and deterministic. Rules: scene per segment, `GAP_MS = 350` between scenes, an end card of `END_CARD_MS = 4000` showing `brand.name`, `brand.business` and `ctaText`; each scene shows its shot, eases to the segment's `focus` (or the whole shot) over the first 600 ms, and draws its markups 400 ms in, in order; blur markups blur the region for the whole scene; callouts fade in with the markup. `files` is the HyperFrames project (an `index.html` plus assets) with the audio track laid out at `sceneStartsMs`.
  - `renderVideo(o: { files; workDir; cfg }): Promise<{ mp4: string; durationMs: number }>`: 1280×720, 30 fps, H.264 + AAC, `+faststart`, at most 40 MB (retry once at a lower bitrate if over), then `makeGif` (first 6 seconds of the hook scene, 480 px wide, 8 fps, at most 1.5 MB, palette optimised) and a poster JPEG at 2 seconds.
  - Handler `render`: downloads the shots and every line's audio (recorded lines go through `toWav`), measures each line with ffprobe (the measurement wins over stored durations), builds the composition, renders, uploads the three outputs, returns the result.

- [ ] **Step 1: HyperFrames spike (needs Logan; do first).** On his Mac: `npx hyperframes --help` and the project's docs for the installed version; render a 5-second composition with one image, a moving highlight and an audio file; record the project layout, the render command and flags, the timing model, and the version in `docs/superpowers/notes/2026-11-hyperframes.md`. **Gate:** if the CLI cannot take an HTML project with an audio track and produce an MP4 headlessly, stop and tell Logan; the spec's fallback is Remotion (free under 4 people).
- [ ] **Step 2: Write the failing tests.** `helper/test/composition.test.ts`: `total length is the sum of lines, gaps and the end card`; `scene starts follow the audio durations, not the stored ones`; `markups appear 400 ms into their own scene only`; `blur covers the whole scene`; `the same input gives the same files`; `a missing audio file is a clear error`. `helper/test/render-handler.test.ts` (fake ffmpeg): `an oversize first encode retries once at a lower bitrate`; `the gif is capped at 1.5 MB or the handler fails with its size`; `recorded webm lines are converted before use`. `test/video-render-job.test.ts`: `render result for an older plan version is discarded`; `render result sets rendered and creates one publish approval`; `editing the plan cancels open jobs and returns to review`; `a render job is not enqueued until every line has audio`; `a failed render sets failed with the helper's error`.
- [ ] **Step 3: Run** `npx vitest run test/video-render-job.test.ts` and `npm run test:helper`. Expected: FAIL.
- [ ] **Step 4: Implement,** following the spike notes for the composition syntax.
- [ ] **Step 5: Run all + build** `npm test && npm run test:helper && npm run typecheck && npm run build`. Expected: PASS.
- [ ] **Step 6: Real render (needs Logan).** Take one real lead through capture, script, edit, approve, voice and render, with the helper running. Expected: an MP4 of 80–130 seconds under 40 MB that plays in Safari and on a phone, a GIF under 1.5 MB, and the `video.publish` approval waiting. Fix anything that looks off in `buildComposition`.
- [ ] **Step 7: Commit** — `git add -A && git commit -m "feat(video): HyperFrames render job and composition"`

---

### Task 10: View and watch-depth tracking

**Files:**
- Create: `migrations/<next free>_video_views.sql`, `src/worker/video/views.ts`, `src/client/components/home/WatchedCard.tsx`, `src/client/videoViewsView.ts`, `src/client/beacon.ts`
- Modify: `src/worker/routes/public.ts` (beacon), `src/worker/routes/video.ts` (`GET /api/video-audits/watched`), `src/client/pages/Report.tsx`, `src/client/pages/Today.tsx`, `src/client/pages/LeadDetail.tsx` (a "Watched" line in the video panel)
- Test: `test/video-views.test.ts`, `test/video-views-view.test.ts`

**Interfaces:**
- Produces: table `video_sessions(token, session, first_at, last_at, opened, plays, max_pct, PRIMARY KEY (token, session))`.
  - `recordEvent(env, token: string, e: { session: string; type: "open" | "play" | "progress" | "end"; pct?: number }, now: Date): Promise<void>`: ignores unknown tokens, events for unpublished videos, sessions beyond 50 per token per day, and `pct` outside 0–100; `max_pct` only rises. It logs one activity entry on the first play, one when `max_pct` first reaches 50 and one at 90 or `end` (`"Watched 50% of the video"`), each at most once per token.
  - `POST /api/public/report/:token/events` (JSON at most 200 bytes, zod; always `204`, whether or not anything was stored).
  - `watchedLeads(db, now: Date): Promise<{ businessId: string; name: string; maxPct: number; lastAt: string }[]>`: sessions in the last 7 days with `max_pct >= 50`, for leads not `replied`, `won`, `lost` or `skip`, newest first, at most 10; `GET /api/video-audits/watched` returns it.
  - `beacon.ts`: `sendEvent(token, e)` using `navigator.sendBeacon` with a `fetch` keepalive fallback; the session id is a random id made on page load and never stored. The report page sends `open` after first paint, `play`, `progress` at 25/50/75/90 and `end`.
  - `videoViewsView.ts`: `watchedLine(w: { maxPct: number; lastAt: string }, now: Date): string`. Exact copy: `` `Watched ${maxPct}% ${ago}` `` with `ago` from the existing relative-time helper in `src/client/eta.ts` (or the nearest one that exists); the Today card's heading is `"Watched your video, no reply yet"`.

- [ ] **Step 1: Write the failing tests.** `test/video-views.test.ts`: `fetching the page or the video records nothing`; `open then play then 50 logs two activity entries once each`; `max_pct never goes down`; `the 51st session in a day is ignored`; `unknown token returns 204 and stores nothing`; `unpublished video returns 204 and stores nothing`; `pct of 140 is ignored`; `watchedLeads excludes replied leads and sessions under 50`. `test/video-views-view.test.ts`: `watchedLine` for 50 and 100 percent.
- [ ] **Step 2: Run** `npx vitest run test/video-views.test.ts test/video-views-view.test.ts`. Expected: FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run all + build** `npm test && npm run typecheck && npm run build`. Expected: PASS.
- [ ] **Step 5: Commit** — `git add -A && git commit -m "feat(video): watch tracking, lead activity and the Watched card"`

---

### Task 11: Email 1 carries the video

**Files:**
- Create: `migrations/<next free>_campaign_video_email.sql`
- Modify: `src/worker/approvals/emailSend.ts` (`heroImage`), `src/worker/email/render.ts` (`composeEmail` hero), `src/worker/mail/send.ts` (link guard), `src/worker/sequence/engine.ts` (`startSequence`), `src/worker/db/campaigns.ts`, `src/worker/routes/campaigns.ts`, `src/client/pages/CampaignEditor.tsx`, `src/client/campaignView.ts`
- Test: `test/video-email.test.ts`; extend `test/email-render.test.ts`, `test/email-send.test.ts`, `test/campaigns.test.ts`, `test/sequence.test.ts`

**Interfaces:**
- Migration: `campaigns.video_email INTEGER NOT NULL DEFAULT 0`.
- `EmailSendSchema` gains `heroImage?: { src: string; href: string; alt: string }`: https only, both URLs on the host in `OUTREACH_LINK_BASE`, `href` under `/r/`, `src` under `/api/public/report/`, `alt` one line at most 120 chars.
- `composeEmail(s, d: Composable & { hero?: { src: string; href: string; alt: string } })`: the HTML puts the image (linked, `width="480"`, `alt`) right after the body paragraphs and before the signature; the plain text gets one line `Watch it here: <href>` after the body. With no hero, output is byte-identical to today (existing tests unchanged).
- `startSequence`: when `campaign.video_email` is 1 it requires a published video for the lead's latest audit (400 `"make and approve the video first"` otherwise), mints the report link with `ensureReport`, and sets `heroImage` (`src` the `preview.gif` media URL, `href` the `/r/<token>` URL, `alt` `"Video audit for <business name>"`). The Email 1 preview in the approvals inbox shows `Video: <href>`.
- `linkProblem` (Plan 2) keeps checking body links; the hero is checked by the schema above.
- The campaign editor gets one checkbox, "Email 1 carries the video audit (needs a published video)".

- [ ] **Step 1: Write the failing tests.** `test/video-email.test.ts`: `video campaign refuses to start without a published video`; `video campaign puts the gif and link in the approval payload`; `campaign with the switch off is unchanged`; `hero on another host is refused by the schema`; `hero href not under /r/ is refused`. `test/email-render.test.ts`: `no hero gives identical output`; `hero image sits after the body and before the signature`; `plain text carries the watch line`; `alt text is escaped`. In `test/sequence.test.ts`: `a published video is still found after the 30-day report link expired and was re-minted`.
- [ ] **Step 2: Run** `npx vitest run test/video-email.test.ts test/email-render.test.ts test/email-send.test.ts test/campaigns.test.ts test/sequence.test.ts`. Expected: FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run all + build** `npm test && npm run typecheck && npm run build`. Expected: PASS.
- [ ] **Step 5: Commit** — `git add -A && git commit -m "feat(video): Email 1 carries the video link and GIF"`

---

### Task 12: Ship

- [ ] **Step 1: Full verification.** `npm test && npm run test:helper && npm run typecheck && npm run build && npx wrangler deploy --dry-run`. Expected: PASS.
- [ ] **Step 2: Remote migrations (Logan runs or OKs):** `npx wrangler d1 migrations apply site-search --remote`. Expected: the five video migrations apply.
- [ ] **Step 3: Open a PR** from `feat/agency-os-video` to `main`, linking the spec and this plan. Deploy after merge with `npm run deploy`.
- [ ] **Step 4: Pair the helper (Logan).** In Settings > Helper create a device token; on the Mac run `npx tsx helper/src/cli.ts pair <apiBase> <token>`, then `doctor`, then load the launchd plist. Expected: Today shows "Your Mac helper is online."
- [ ] **Step 5: Voice (Logan).** Upload the reference recording, run the blind test, pick a voice or choose to record himself. Expected: `settings.voice_engine` is set or deliberately null.
- [ ] **Step 6: Real end-to-end check (Logan).** On one of his own test leads (a site he controls): request a video, run `/work-the-queue` for the script, edit and approve, wait for voice and render, watch the MP4, approve `video.publish`, open the report link on a phone (Safari) and watch it past 50%. Expected: the page plays and seeks, the note and booking button show, the lead's timeline gets "Watched 50% of the video", and the Today "Watched" card lists it.
- [ ] **Step 7: Email check (Logan).** Turn on `video_email` for a campaign, start a sequence on that test lead, approve Email 1 to his own mailbox. Expected: the GIF shows in Gmail and Apple Mail, clicking opens the video page, and the plain-text part has the watch line. Check the message's SPF/DKIM/DMARC results in the headers before any real prospect gets one.
