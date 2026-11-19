# Plan 3 (video audits): open items after the build

Branch `feat/agency-os-video`, built 2026-11-18/19 by subagents. 2430 root tests, 110 helper tests, typecheck and build clean. Nothing is deployed, pushed, merged or migrated remotely.

## Needs Logan's Mac (Task 12 and the two spikes)
1. Apply remote migrations 0040-0044 BEFORE deploying (the public report page reads `settings.booking_url` and `ai_voice_note` and errors without them).
2. Install HyperFrames (`npm install -g hyperframes@0.9.69`) and put its absolute path in `~/.siteline-helper/config.json`; launchd PATH lacks nvm/npm-global dirs. Needs Node 22.18+ (runs `.ts` directly). Rendering needs internet (GSAP from jsdelivr with SRI; HyperFrames downloads a Google font on first render).
3. Voice-engine spike (Task 7 step 5): the three Python scripts in `helper/scripts` are unverified against real engines (mlx-audio args, Chatterbox, OpenVoice file names). Run `doctor`, upload a 30-120 s reference, run the blind test, pick or choose "record my own".
4. Real render (Task 9 step 6): one real lead through capture, script, edit, approve, voice, render. Check the MP4 plays in Safari and on a phone, GIF under 1.5 MB, file under 40 MB, the `video.publish` approval appears, tall screenshots look acceptable.
5. Pair the helper, fill `booking_url` in Settings > Video voice, then the end-to-end and email checks (GIF in Gmail/Apple Mail, SPF/DKIM/DMARC in headers) from Task 12.

## Known gaps (decided, not fixed)
- A lead later suppressed or marked do-not-contact keeps an already-published video visible until Logan unpublishes it or revokes the report link (no auto-unpublish).
- An empty `booking_url` bakes "Reply to this email to book a call" into the render; no warning at approve time.
- The script uses `tone_preset`/`tone_notes`/`bio` from settings, not the `logan-voice` skill (the queue worker has no skills).
- Report links last 30 days; Email 1 opened later shows a dead page/GIF (send time now checks the link is live, but not after delivery).
- Server `approve-batch` still accepts `video.publish` ids (only the UI skips them).
- `video.script` `apply` uses an unguarded status write; a result applied at the instant of a cancel could move `cancelled -> review` (harmless-ish; use `moveVideoStatus`).
- Deleting a lead leaves its pending `video.publish` approval and helper_jobs rows.
- Orphaned R2 objects after regenerate/re-render; unpublish breaks the GIF in emails already sent.

## Deferred minors (from per-task reviews)
Segment plan: markup x+w may exceed 1 (renderer clamps), role order beyond hook-first/cta-last not enforced. Helper: chunked upload buffers up to 2x80 MB, forced content-type for outputs, revoke leaves claims for 20 min, SIGINT mid-job reports a failure, stale `job-*` dirs not swept, no client fetch timeout on claim/complete, 422 on complete reported as a hard fail. Voice test: `chooseVoice` not atomic, replacing the reference can strand queued jobs. Render: claim TTL (20 min) vs render timeout (45 min), `PUT /plan` on `producing` uses a stale snapshot. Views: depth is playhead position, `last_at` can move backwards, no pruning of `video_sessions`. Email: send-time host check ignores the port; alt `.slice` can split a surrogate pair.

## Rulings made during the run
Plan fixes (TaskRefused instead of a `check` hook; `defaultNarration`, kind registration order, route lists), the `PUT /plan` length-check deviation, `video_watch` counts as engagement, SRI + system fonts for the render page, the final fix-wave scope, and all subagents on Sonnet. Details are in the commit history and plan.
