# Siteline Mac helper

A small Node program that runs on Logan's Mac. It asks Agency OS (the Worker) for work every few seconds, does it with local tools (cloned
voice, ffmpeg, HyperFrames) and sends the result back. It never receives a connection: the Worker cannot reach into the Mac, so nothing on
the Mac needs to be exposed. Everything it does is $0 and local.

It keeps no state except `~/.siteline-helper/config.json` and a cache folder (`~/.siteline-helper/cache`). **Deleting the cache is always safe.**
The jobs it understands: `voice.segment` (one script line in the cloned voice), `voice.sample` (one clip of the blind voice test), `render` (the finished
video, see "Rendering" below), `meetily.sync` (see "Meetily" below) and three Care jobs: `care.inventory`, `care.update` and `care.certs` (see "Care updates" below).

## Requirements

- macOS on Apple Silicon.
- Node **22.18 or newer** (it runs the TypeScript directly, no build step). On an older Node 22, use `npx tsx` wherever this file says `node`.
- `ffmpeg` and `ffprobe` (`brew install ffmpeg`).
- Python 3.11 or 3.12 for the voice engines, one venv per engine (below).
- No `npm install`: the helper has no dependencies.

## Pair this Mac

1. In Agency OS, open Settings > Mac helper and pair a Mac. The token (`hlp_...`) is shown once.
2. From the repo root:

   ```sh
   node helper/src/cli.ts pair https://<your-agency-os-address> -
   ```

   and paste the token when it waits (the `-` reads it from the keyboard, so it does not end up in your shell history or `ps`).
   Passing it as an argument also works: `pair <apiBase> <token>`.

   This writes `~/.siteline-helper/config.json` (owner-only permissions) and checks the token with the server. The token is never printed.
   Set `SITELINE_HELPER_CONFIG=/path/to/config.json` to use a different file.
3. `node helper/src/cli.ts doctor` shows the config, whether the server accepts the token, each voice engine's state, the ffmpeg, ffprobe and hyperframes versions, and Chrome's path and version (or "not found"; only care updates need Chrome).

Pairing again keeps every other setting already in the file. If the token is revoked in Settings, the helper stops with a clear message; pair the Mac again.

### Config file

Only `apiBase` and `token` are required. Everything else has a default:

```json
{
  "apiBase": "https://agency.example.com",
  "token": "hlp_...",
  "pollSeconds": 5,
  "cacheDir": "~/.siteline-helper/cache   (written out in full)",
  "python": {
    "qwen3-tts":    "~/.siteline-helper/venvs/qwen3-tts/bin/python",
    "chatterbox":   "~/.siteline-helper/venvs/chatterbox/bin/python",
    "openvoice-v2": "~/.siteline-helper/venvs/openvoice-v2/bin/python"
  },
  "ffmpeg": "ffmpeg",
  "ffprobe": "ffprobe",
  "hyperframes": "hyperframes",
  "meetilyDb": "~/Library/Application Support/com.meetily.ai/meeting_minutes.sqlite   (written out in full)"
}
```

A wrong value stops the helper with a message that names the field (`pollSeconds must be a number from 1 to 3600`). `apiBase` must be `https://` (plain `http://` only for `localhost`), so the token never crosses a network in the clear.

## Run it

```sh
node helper/src/cli.ts run      # keep working (what launchd runs)
node helper/src/cli.ts once     # do at most one waiting job, then exit
node helper/src/cli.ts doctor   # check everything
```

One job at a time. A job that fails is reported to Agency OS with the reason and the loop goes on; a job that was claimed and never finished (the Mac slept) is handed out again by the server after 20 minutes.

## Voice engines

Each engine is a thin Python script in `helper/scripts/` that reads a text file and a reference recording and writes a wav. Each lives in its own venv so
the three libraries cannot fight over versions. The helper converts the result to mono 24 kHz PCM, normalises the loudness (`loudnorm`) and uploads it.

> **None of the three scripts has been run against its real engine.** They are written from each library's documented minimal API, on a machine
> with no models installed. **Each must be verified on Logan's Mac in the engine spike** (the last section) before anything depends on it. Expect to
> adjust a call or two when the installed version differs from what is written here.

Create the venvs (one time; downloads models, a few GB each):

```sh
mkdir -p ~/.siteline-helper/venvs

# Qwen3-TTS through mlx-audio (Apple Silicon, MLX). Needs a Qwen3-TTS *Base* model for voice cloning.
python3.12 -m venv ~/.siteline-helper/venvs/qwen3-tts
~/.siteline-helper/venvs/qwen3-tts/bin/pip install -U pip mlx-audio
#   SITELINE_QWEN3_MODEL overrides the model id (default mlx-community/Qwen3-TTS-12Hz-1.7B-Base-bf16)

# Chatterbox (Resemble AI)
python3.12 -m venv ~/.siteline-helper/venvs/chatterbox
~/.siteline-helper/venvs/chatterbox/bin/pip install -U pip chatterbox-tts
#   SITELINE_TORCH_DEVICE=cpu if mps misbehaves

# OpenVoice V2 (MyShell): the converter, plus MeloTTS as the base voice
python3.12 -m venv ~/.siteline-helper/venvs/openvoice-v2
git clone https://github.com/myshell-ai/OpenVoice ~/.siteline-helper/openvoice/src
~/.siteline-helper/venvs/openvoice-v2/bin/pip install -U pip -e ~/.siteline-helper/openvoice/src
~/.siteline-helper/venvs/openvoice-v2/bin/pip install git+https://github.com/myshell-ai/MeloTTS.git
~/.siteline-helper/venvs/openvoice-v2/bin/python -m unidic download
#   download checkpoints_v2 (link in the OpenVoice README) and unpack it to ~/.siteline-helper/openvoice/checkpoints_v2
#   (SITELINE_OPENVOICE_CKPT points elsewhere)
```

Then `node helper/src/cli.ts doctor` should list all three as `available`. An engine that is not available only fails its own jobs, with the reason `doctor` shows.

Notes for the spike:

- Each line starts a fresh Python process, so every line pays the model's load time. If that is too slow, the fix is a long-lived worker per engine;
  `VoiceEngine.synth` is the one place that would change.
- The reference recording is converted to mono 24 kHz wav before it reaches an engine, whatever format it was uploaded in.
- Environment variables the scripts read: `SITELINE_QWEN3_MODEL`, `SITELINE_QWEN3_REF_TEXT`, `SITELINE_TORCH_DEVICE`, `SITELINE_OPENVOICE_CKPT`, `SITELINE_OPENVOICE_SPEAKER`.

## Meetily

The `meetily.sync` job reads the meetings Meetily recorded on this Mac and sends Agency OS **only the ones that match a booking or calendar event**. It
reads Meetily's database (`meetilyDb`, default `~/Library/Application Support/com.meetily.ai/meeting_minutes.sqlite`) read-only and never changes it.
The same database file holds Meetily's API keys and licence; the helper only ever queries the `meetings`, `transcripts` and `summary_processes` tables, so
those never leave the Mac.

- A meeting matches a booking or calendar window only when it overlaps the booked time itself by a positive amount AND more than half of the recording lies inside the window widened by 15 minutes each side. A recording that merely ends when the call starts (or starts when it ends), a long one that only touches the edge, a zero-length one, or a tie between two windows means no match, and a meeting that matches nothing never leaves the Mac.
- A meeting is held back, and picked up by a later sync, when it might not be finished: its record or summary changed, or its audio ended, in the last 5 minutes
  (still recording); a date in its record cannot be read; its summary is still pending or processing (for up to 24 hours after it ended); or it has no summary
  yet and ended under 30 minutes ago. All of it is read inside one read transaction, so a meeting and its transcript come from the same moment.
- A meeting that matches nothing is never uploaded, named in a result, or written to a log.
- It needs Node's built-in `node:sqlite` (Node 22.18 or newer, no install). If your Node prints an "ExperimentalWarning: SQLite is an experimental feature"
  line, it is harmless; run with `NODE_NO_WARNINGS=1` to hide it. Do not switch to a different SQLite tool: this one opens the file read-only.
- If Meetily is recording or saving when a sync runs, the job fails with "Meetily is busy with its database"; the next sync tries again.
- `doctor` shows whether the database file is where the config says (it is optional, so a missing file does not fail `doctor`).

## Care updates

The weekly Care update batch (version 0.2.0 and up). The helper reads a client's WordPress over SSH with WP-CLI, and only after you approve a wave in Agency OS it takes a backup, updates plugins, themes and core, checks the pages and puts the old code back if a page breaks. It also reads each site's certificate expiry once a day. An older helper does not claim these jobs, so it keeps doing voice and render.

### Set up one site

Agency OS stores only a host alias and the WordPress folder for each site (the site panel on the client page: "SSH host alias" and "WordPress folder on the server", plus the access method set to SSH and WP-CLI). The alias is a `Host` entry in `~/.ssh/config` on this Mac. Nothing else about the login is stored anywhere in Agency OS.

```
Host client-alias
  HostName ssh.example-host.com
  User example-user
  Port 22
  IdentityAgent "~/Library/Group Containers/<1password-group-id>/t/agent.sock"
```

- `client-alias` is what you type in Agency OS. It must be a plain name: letters, digits, `.`, `_` and `-`, starting with a letter or digit, up to 64 characters.
- The WordPress folder is the full path of the install on the server (the folder with `wp-config.php`): `/` first, letters, digits, `.`, `_`, `-` and `/`, no `..`.
- Keys come from ssh-agent or the 1Password SSH agent. The helper runs `ssh -o BatchMode=yes`, so a missing key or a question from the server **fails the job** instead of waiting for a password. Test it by hand first: `ssh client-alias -- wp --path=/full/path core version`.
- WP-CLI (`wp`) must be installed for that SSH user.

### What it runs

Every command goes to `ssh` as an argument list (no local shell), every word is checked against a fixed pattern on both sides and each remote word is single-quoted. The only things it runs on the server:

- Reading: `wp core version`, `wp core check-update --format=json`, `wp cli info --format=json`, `wp plugin list --fields=... --format=json`, `wp theme list --fields=... --format=json`, `wp plugin get <slug> --field=version`, `wp theme get <slug> --field=version`.
- Updating (only a site an approved wave covers): `wp db export`, `wp plugin update <slug> --version=<to>`, `wp theme update <slug> --version=<to>`, `wp core update --version=<to>`, `wp core update-db`, then `wp cache flush` once after the updates (best effort: a site with no object cache, or a refusal, changes nothing).
- A **premium** plugin or theme (not on wordpress.org, marked "can't roll back") is updated with `wp plugin update <slug>` (or `wp theme update <slug>`) **without** `--version`: its own updater only offers its newest version. It counts as applied only when the version it then reads is the one the plan showed; otherwise it is failed, and as it cannot be put back the incident names the backup.
- Putting back (only after a page breaks or an update fails): `wp plugin install <slug> --version=<from> --force`, `wp theme install ... --force`, `wp core update --version=<from> --force`, `wp core update-db`.
- Housekeeping in the SSH user's home folder, nothing else: `mkdir -m 700 -p siteline-backups` (only the SSH user can read the dumps), `test -e` and `gzip -t` and `gzip -f` on a backup file, `find siteline-backups -name '*.sql.gz' -mtime +28 -delete`.

It never runs `wp eval`, `wp shell`, `wp db query`, `wp db import`, `sh -c` or anything built from text a site returned. Plugin names, page HTML and WP-CLI output are only stored and shown as data.

### Backups

Before any update the helper runs `wp db export` and gzips it to `siteline-backups/<domain>-<run id>.sql.gz` in the SSH user's **home folder** on the server. Backups older than 28 days are deleted after a new one is safe. If several sites share one SSH user (one hosting account), they share that folder and each run's sweep covers all of them. It is a database backup only: files are left to the host's own backups. The rollback puts old **code** back and never imports the database (that would lose orders and form entries made since). If a rollback fails, the incident names the backup file and you restore it by hand.

### Retries and the contact guard

- A job that was claimed and never finished (the Mac slept, the helper was killed) is handed out again after 20 minutes. A **retry never applies an update**. It reads the versions, reports what is already at the target version, runs the page checks and rolls back if a page is broken. The updates it did not start wait for the next batch. A second backup is never taken over the first.
- While it works, the helper tells Agency OS it is still alive after every step. If it cannot reach Agency OS for 10 minutes, it starts no new update ("stopped: lost contact with Agency OS"); it can still check pages and put code back.

### Page checks and Chrome

For each site it opens up to five pages (the site's check pages, default `/`) in headless Google Chrome at 1280 wide and 1600 tall, first screen only, before and after the updates. It reads the status, looks for the "critical error" text and counts `<form>` elements (forms are counted, never submitted).

A cache in front of the site (WP Rocket, the host's Varnish, Cloudflare) could answer with a copy saved before the update and hide a broken page. So every read and every screenshot asks for its own address, the page plus `?siteline-check=<run id>-<attempt>-<page>-<before|after|recheck>` (no cache has that copy, and a retried job never reuses an address an earlier attempt asked for), each read sends `cache-control: no-cache` and `pragma: no-cache`, and `wp cache flush` runs after the updates. A read that gets no answer at all is tried once more, 2 seconds later, before it counts as broken. The query shows up in the site's access log and analytics as a visit to the page with that query. It compares the two screenshots with ffmpeg's SSIM (under 0.95 counts as changed) and uploads a before, an after and a difference picture for each page.

Chrome's path is `chrome` in `~/.siteline-helper/config.json`; the default is `/Applications/Google Chrome.app/Contents/MacOS/Google Chrome`. Set it if Chrome is somewhere else. `node helper/src/cli.ts doctor` shows Chrome's path and its `--version`, or "not found".

### Certificates

Once a day the helper opens a TLS connection to port 443 of each monitored site's host name, reads the certificate's expiry date and closes the connection. It sends no request, trusts nothing and stores only the date. A site it cannot reach keeps its last reading. IP addresses and `.local` or `.internal` names are never connected to.

### Rehearse on a throwaway site first

Do this before any client.

1. Make a throwaway WordPress site you can break (a cheap host or a copy) with SSH and WP-CLI. Add it in Agency OS as a **test** client with a test Care subscription and its address, set its SSH alias and WordPress folder, and set its WordPress access method to SSH.
2. Put the alias in `~/.ssh/config`. Run `ssh <alias> -- wp --path=<folder> core version` by hand. It must answer without asking for anything.
3. Run `node helper/src/cli.ts doctor`. Its `chrome` line must show a version, not "not found".
4. On the client's Care panel, press "Plan updates for this site" (the single-site run). The helper reads the site; you approve one approval; the helper backs up, updates, checks the pages and reports. Look at the run view: the backup file name, each page and its pictures.
5. Make it fail on purpose (for example a plugin update that breaks a page) and check that the code is put back. On a **test** client, what you will see is the run view, `/care/runs/<run id>`: status `rolled_back`, the summary, the backup file name and each page's pictures. Nothing links to it for a test client (the Care panel reads the updates board, which leaves test clients out, so it says "No update run yet."): open it by hand, with the id from D1 (`SELECT id, status, summary FROM care_runs ORDER BY created_at DESC LIMIT 1`). What you will NOT see: Today, the Care board, `/care/updates` and every incident list (including the "Last 5 incidents" on the client's Care panel, which says "No incidents yet.") leave test clients out, so the `update_failed` incident exists only in the database. It stays open until you close it with `POST /api/incidents/<id>/close` (find the id in D1: `SELECT id, detail FROM site_incidents WHERE kind = 'update_failed' AND closed_at IS NULL`); it blocks nothing, as a test site is never in a weekly batch. The CARE-5 fix task is made only when the client has a **live Care project** (CARE-0 started and not cancelled): start one for the test client before the rehearsal to see the task on that project, otherwise there is no task, only a warning in the log. A single-site run on a test site touches no weekly checklist.
6. Only then add a real client's alias.

## Start it at login (launchd)

```sh
mkdir -p ~/Library/LaunchAgents ~/Library/Logs
sed -e "s|__NODE__|$(command -v node)|" -e "s|__HELPER__|$PWD/helper|" -e "s|__HOME__|$HOME|" \
  helper/launchd/com.siteline.helper.plist > ~/Library/LaunchAgents/com.siteline.helper.plist

launchctl bootstrap gui/$(id -u) ~/Library/LaunchAgents/com.siteline.helper.plist     # load (and start)
launchctl bootout   gui/$(id -u)/com.siteline.helper                                  # unload (stop)
launchctl kickstart -k gui/$(id -u)/com.siteline.helper                               # restart, e.g. after re-pairing
tail -f ~/Library/Logs/siteline-helper.log                                            # what it is doing
```

It restarts after a crash (`KeepAlive`) but not after a clean exit, so a revoked token leaves it stopped instead of looping. If you move the repo, edit and reload the plist: it holds the absolute path.

## Tests

```sh
npm run test:helper      # from the repo root: plain Node, no models, no network; engines and the server are faked
npx tsc -p helper/tsconfig.json
```

The tests that touch ffmpeg use the real one when it is installed and skip otherwise.

## Engine spike (needs Logan, on this Mac)

This is the part no test can do. Record the outcome in `docs/superpowers/notes/2026-11-voice-engines.md`.

1. Create the three venvs above and run `doctor` until the engines are `available` (fix each script as needed).
2. Record a clean 60-second reference (quiet room, one voice, no music) and upload it in Settings.
3. Create a voice test from the Voice page; run `node helper/src/cli.ts once` until all three clips arrive (or run `run`).
4. Write down: the install steps that worked, the seconds each engine took to synthesize about 20 seconds of speech, and which engine you picked.
5. **Gate:** if no engine sounds right, switch new videos to "record yourself" (already the default when no engine is set). The rest of the plan continues.

## Rendering

The `render` job turns a video's plan into the MP4, a short preview GIF and a poster JPEG. It downloads every screenshot and every line's audio (a recording
from the browser is converted to a wav first), measures each line with ffprobe, writes a HyperFrames project (`src/render/composition.ts`), renders it
(`src/render/render.ts`: 1280x720, 30 fps, H.264 + AAC, `+faststart`, at most 40 MB, one retry at a lower bitrate), makes the GIF (480 px wide, 8 fps, at most 1.5 MB)
and the poster (2 seconds in), and uploads the three files to the keys the job lists. A render of a long video takes a minute or two.

### The report video (`report.render`)

The short, silent video that goes with a client's monthly Care or Local SEO report (needs helper 0.2.0 and up, the same HyperFrames, Chrome and ffmpeg as above). It is 1080 x 1080, about 6 seconds a scene, and shows
captions only: a title card, up to four numbers (uptime, updates, backups, search clicks, visits, rank points, new reviews) and a thank-you card, all from the report's own numbers. It downloads nothing: the scenes are
in the job. The helper renders the page `buildReportComposition` makes (`src/render/composition.ts`), takes the first frame as the poster and uploads exactly the two files the job lists (an `.mp4` and a `.jpg`).
The report page shows it only once the report has been sent.

Never run for real from the test suite (the tests use fakes). To try it once on this Mac:

1. `node helper/src/cli.ts doctor` shows `hyperframes`, `ffmpeg` and `ffprobe` with versions (and no "NOT FOUND").
2. In Agency OS, open a client with a Care or Local SEO report whose words are ready (Claude's task done, or the plain summary) and wait for the report's job: it is queued on its own when the words are stored.
3. `node helper/src/cli.ts once` claims it, renders (a minute or less) and uploads. Check the log for `report.render` and `done`.
4. Approve and send the report to yourself, open its link and press play: the video shows the month and the numbers, and nothing the summary says. A report with fewer than three numbers makes no video.
5. A failed render says why on the video's row in the database (`report_videos.error`); the report page is not affected and shows no video.

Install HyperFrames once, pinned to the version this was checked with (see `docs/superpowers/notes/2026-11-hyperframes.md`):

```sh
npm install -g hyperframes@0.9.69        # then "hyperframes": "hyperframes" in the config works as it is
# or, without a global install:
cd ~/.siteline-helper && npm install hyperframes@0.9.69      # and set "hyperframes": "<that folder>/node_modules/.bin/hyperframes"
```

It also needs Google Chrome (or `hyperframes browser`), ffmpeg, and **internet on every render**: the page loads GSAP from jsdelivr (pinned to an exact
version and checked with a Subresource Integrity hash, so a changed file is refused; GSAP is not bundled). The page itself uses system fonts only and asks
no font service for anything, but HyperFrames' own compiler maps every font family to a web font (Inter) and downloads it from Google Fonts the first time
(then it reads `~/.cache/hyperframes/fonts`), so the very first render on a Mac needs Google Fonts reachable too.
The helper switches HyperFrames' own usage reporting off for every render. If a newer HyperFrames changes a flag, the command line is written in one place:
`hyperframesArgs` in `src/render/render.ts`. `doctor` shows the installed version.
