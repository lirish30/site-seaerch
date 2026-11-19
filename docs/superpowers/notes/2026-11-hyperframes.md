# HyperFrames spike (Plan 3, Task 9, step 1)

**Result: VERIFIED on this Mac (Apple Silicon, macOS 26, Node 26.0.0, ffmpeg 8.1.2) with `hyperframes@0.9.69`.** The CLI takes an HTML project with an
audio track and writes an MP4 headlessly. The Remotion fallback is not needed. What is **not** verified is a render of a real lead's real screenshots
and a real cloned voice: that is Task 9 step 6 and still needs Logan.

Run from a scratch folder outside the repo, nothing installed globally (`npx --yes hyperframes@0.9.69 ...`, which keeps the package in `~/.npm/_npx`).
Side effects on this Mac: `~/.hyperframes/` (the tool's own config and install state; telemetry was switched off with `HYPERFRAMES_NO_TELEMETRY=1` and
`DO_NOT_TRACK=1` for every run) and `~/.cache/hyperframes/fonts/` (the Inter font, fetched from Google Fonts on the first render).

## What was run

1. `npx hyperframes --help`, `render --help`, `docs data-attributes|compositions|audio|rendering|gsap`, `doctor` (Chrome found, FFmpeg found, no account needed).
2. A 5 second, 1280x720 composition (`index.html` + `assets/shot1.jpg` + `assets/a1.wav`): one tall image, a camera move over its first 0.6 s, a moving
   highlight ring, one audio clip. `hyperframes check` passed; `hyperframes render p1 -o out.mp4 --fps 30 --quiet` took 14 s and produced H.264
   1280x720 30 fps yuv420p plus AAC, exactly 5.000 s, with the tone audible (-21 dB mean) and the ring and camera move visible in the frames.
3. The real helper code (`handlers/render.ts` -> `buildComposition` -> `renderVideo` -> `makeGif` -> `makePoster`) against the real CLI, with `say`-made
   narration (three cloned-style wavs and one `.webm` recording converted by `toWav`), a 1280x2400 and a 390x844 picture, an arrow, three circles, a blur
   and two callouts. 24 s video: 1.3 MB, 10 s. Then a 126 s video with 24 scenes: **7.2 MB, 20 s**. The frames were looked at: camera moves, markups,
   the blur clamped at the image edge, a right-edge callout growing leftwards and the end card were all right. The GIF came out 480x270 at 8 fps, 100 KB.
   Pictures were synthetic test patterns, so a real page's sizes will differ, but there is a lot of room under 40 MB.

## Project layout

```
<project>/
  index.html            the page (root element carries the timing)
  assets/shot-<id>.jpg  one per shot   (relative paths from index.html)
  assets/line-<id>.wav  one per line
  renders/              output goes here by default; the helper writes renders/raw.mp4 then renders/video.mp4
```

`index.html` is a normal HTML page:

- Root: `<div id="root" data-composition-id="main" data-start="0" data-duration="<seconds>" data-width="1280" data-height="720">`. The output size is the root's
  `data-width` x `data-height`; no flag is needed.
- Timed elements: `class="clip"` plus `data-start="<seconds>" data-duration="<seconds>"` (a scene is visible only inside its window).
- Sound: `<audio src="assets/x.wav" data-start="<s>" data-duration="<s>" data-track-index="1">`. Also `data-volume`, `data-media-start` (trim), `data-fade-in/out`.
- Animation: GSAP (`<script src="https://cdn.jsdelivr.net/npm/gsap@3.15.0/dist/gsap.min.js">`), one paused timeline per composition registered as
  `window.__timelines["main"] = tl;` then `tl.seek(0)`. Only `set / to / from / fromTo` are supported, on `opacity, x, y, scale, scaleX, scaleY, rotation,
  width, height, visibility`. Everything must be deterministic (no `Date.now`, no `Math.random`, no fetches at run time).
- Timing model: **absolute seconds on one timeline.** The renderer seeks the timeline to each frame; audio elements are mixed by their `data-start`.
  `data-layout-allow-overflow` on an element that is meant to run past its container quiets the layout check.

## The render command (one place: `helper/src/render/render.ts`, `hyperframesArgs`)

```
hyperframes render <projectDir> -o <out.mp4> --fps 30 --quiet [--video-bitrate 2000k]
```

Defaults that matter: MP4, H.264 (CRF 16, "looks" quality) + AAC 192 kbit/s, yuv420p. `--video-bitrate <n>k` works (tested) and is mutually exclusive with `--crf`.
`+faststart` is not set by HyperFrames, so the helper remuxes with `ffmpeg -c copy -movflags +faststart` (verified: `moov` comes first). `hyperframes --version`
prints `0.9.69` (the helper's `doctor` uses it). `hyperframes check <dir>` lints and runs the page headless; useful when changing `composition.ts`.

## Things to know

- **Network at render time (updated after review).** A render needs internet for **one script**: GSAP, loaded from jsdelivr, pinned to `gsap@3.15.0` with
  `integrity="sha384-..."` and `crossorigin="anonymous"` (`GSAP_URL` / `GSAP_SRI` in `composition.ts`, with the commands to regenerate the hash). GSAP is deliberately not
  vendored (licence). **HyperFrames honours the integrity attribute**: with the hash edited, the render fails at once with `Subresource integrity mismatch for
  https://cdn.jsdelivr.net/...` and writes no file; with the right hash it renders normally. A jsdelivr outage therefore fails the render (and the video), and the
  error text says so.
- **Fonts.** The page names system fonts only (`-apple-system, BlinkMacSystemFont, "Helvetica Neue", Arial, sans-serif`) and contains no font URL, `@import`, `@font-face` or `<link>`
  (a test checks). But HyperFrames' compiler maps *every* family it sees (tried `system-ui`, `-apple-system`, `Helvetica Neue`, `Arial`, `sans-serif`, `Menlo`) to a Google
  web font (Inter, or JetBrains Mono for Menlo), downloads it itself the first time and keeps it in `~/.cache/hyperframes/fonts` (CSS and woff2 are read from the disk cache
  afterwards: a second render wrote no files there). So the first render on a Mac also needs Google Fonts reachable; later ones should not. Not tested with the network off.
- **Chrome.** It used the system Google Chrome (`doctor` shows it). A Mac without Chrome would need `hyperframes browser` to fetch one.
- **Install for the helper.** `hyperframes` must be a runnable file named in the helper's config (`"hyperframes": "/path/to/hyperframes"`). Either
  `npm install -g hyperframes@0.9.69` (the default `hyperframes` then works) or `npm install hyperframes@0.9.69` in `~/.siteline-helper` and set the path to
  `node_modules/.bin/hyperframes`. Pin the version: the CLI changes quickly (0.9.69 was current on 2026-11-18).
- One render at a time per user account: HyperFrames takes a lock and waits, so a stray manual render slows a job down but does not break it.
- `static-dedup` in the log is HyperFrames reusing identical frames (good: screenshots are mostly still).

## Not verified

- A real lead's screenshots (very tall pages: untested; a browser may refuse images taller than about 16,000 px, so check how tall the capture lets a shot be) and real cloned-voice audio.
- Playing the MP4 in Safari and on a phone (ffprobe says H.264, yuv420p, AAC, `moov` first: the usual requirements, but playing it is the check).
- Behaviour with no network.
