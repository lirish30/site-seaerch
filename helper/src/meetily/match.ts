const DEFAULT_TOLERANCE_MS = 15 * 60_000;

/**
 * The key of the window a recorded meeting belongs to: the one it overlaps most once every window is widened by `toleranceMs` on both sides
 * (people start early and run over). `null` when it overlaps none, or when two windows overlap it equally, because guessing would put a
 * meeting on the wrong client.
 */
export function matchMeeting(
  m: { startedAt: string; endedAt: string },
  windows: { key: string; startAt: string; endAt: string }[],
  toleranceMs: number = DEFAULT_TOLERANCE_MS,
): string | null {
  const start = Date.parse(m.startedAt);
  const end = Math.max(Date.parse(m.endedAt), start + 1); // a meeting with no length still occupies its instant
  if (!Number.isFinite(start) || !Number.isFinite(end)) return null;

  let bestKey: string | null = null;
  let best = 0;
  let tied = false;
  for (const w of windows) {
    const from = Date.parse(w.startAt) - toleranceMs;
    const to = Date.parse(w.endAt) + toleranceMs;
    if (!Number.isFinite(from) || !Number.isFinite(to)) continue;
    const overlap = Math.min(end, to) - Math.max(start, from);
    if (!(overlap > 0)) continue;
    if (overlap > best) { best = overlap; bestKey = w.key; tied = false; }
    else if (overlap === best) tied = true;
  }
  return tied ? null : bestKey;
}
