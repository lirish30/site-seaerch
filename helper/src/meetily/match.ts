const DEFAULT_TOLERANCE_MS = 15 * 60_000;

/**
 * The key of the window a recorded meeting belongs to. A recording matches a window only when BOTH hold:
 *   1. it overlaps the booked time itself (not the widened window) by a positive amount, so a recording that ends exactly when the call starts, or starts exactly when it ends, never matches;
 *   2. MORE THAN HALF of its length lies inside the window widened by `toleranceMs` on both sides (people start early and run over, but a long recording that merely touches the edge is another meeting).
 * Back-to-back calls are normal, so this is deliberately strict: a meeting that matches nothing stays on the Mac. Among windows that qualify the one with the larger overlap with its booked time wins;
 * `null` when none qualifies, when two tie (guessing would put a meeting on the wrong client), or when the recording has no length.
 * The worker applies the same two conditions again to what the helper uploads (src/worker/meetings/syncKind.ts): keep them identical.
 */
export function matchMeeting(
  m: { startedAt: string; endedAt: string },
  windows: { key: string; startAt: string; endAt: string }[],
  toleranceMs: number = DEFAULT_TOLERANCE_MS,
): string | null {
  const start = Date.parse(m.startedAt);
  const end = Date.parse(m.endedAt);
  if (!Number.isFinite(start) || !Number.isFinite(end) || !(end > start)) return null;
  const length = end - start;

  let bestKey: string | null = null;
  let best = 0;
  let tied = false;
  for (const w of windows) {
    const from = Date.parse(w.startAt);
    const to = Date.parse(w.endAt);
    if (!Number.isFinite(from) || !Number.isFinite(to)) continue;
    const booked = Math.min(end, to) - Math.max(start, from);
    if (!(booked > 0)) continue;
    const inside = Math.min(end, to + toleranceMs) - Math.max(start, from - toleranceMs);
    if (!(inside > length / 2)) continue;
    if (booked > best) { best = booked; bestKey = w.key; tied = false; }
    else if (booked === best) tied = true;
  }
  return tied ? null : bestKey;
}
