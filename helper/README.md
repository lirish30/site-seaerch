# Siteline Mac helper

A small Node program that runs on Logan's Mac. It asks Agency OS (the Worker) for work every few seconds, does it with local tools (cloned
voice, ffmpeg, HyperFrames) and sends the result back. It never receives a connection: the Worker cannot reach into the Mac, so nothing on
the Mac needs to be exposed. Everything it does is $0 and local.

It keeps no state except `~/.siteline-helper/config.json` and a cache folder (`~/.siteline-helper/cache`). **Deleting the cache is always safe.**
The jobs it understands: `voice.segment` (one script line in the cloned voice), `voice.sample` (one clip of the blind voice test), `render` (the finished
video, see "Rendering" below) and `meetily.sync` (see "Meetily" below).

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
3. `node helper/src/cli.ts doctor` shows the config, whether the server accepts the token, each voice engine's state, and the ffmpeg, ffprobe and hyperframes versions.

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
