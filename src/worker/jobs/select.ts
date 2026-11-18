import { ROLE_KINDS, type JobPosting, type RoleKind } from "../types";

/** A board is only trusted for what it showed us recently: a role not seen for this long is not "open" for outreach purposes. */
export const SEEN_WITHIN_HOURS = 48;

/** Owner-editable (Settings → role priority); this is the starting point: the work they most want first. */
export const DEFAULT_KIND_ORDER: RoleKind[] = ["web_dev", "cro", "seo", "design", "marketing"];

/** A comma list from settings as a full ranking: unknown and repeated kinds are dropped, kinds left out go last in the default order. */
export function parseKindOrder(s: string | null | undefined): RoleKind[] {
  const given = (s ?? "").split(",").map((k) => k.trim()).filter((k, i, a): k is RoleKind => (ROLE_KINDS as readonly string[]).includes(k) && a.indexOf(k) === i);
  return [...given, ...DEFAULT_KIND_ORDER.filter((k) => !given.includes(k))];
}

export type PostingState = "open" | "unseen" | "closed";

/** "unseen" is open on paper but the board has not shown it for SEEN_WITHIN_HOURS (a failing board leaves roles unclosed), so it cannot be claimed. */
export function postingState(p: Pick<JobPosting, "closed_at" | "last_seen_at">, nowMs: number): PostingState {
  if (p.closed_at) return "closed";
  const seen = Date.parse(p.last_seen_at);
  return Number.isFinite(seen) && nowMs - seen <= SEEN_WITHIN_HOURS * 3_600_000 ? "open" : "unseen";
}

/** May an email or the Today queue name this role? Open, seen within the window, and in the owner's field. */
export const isCitable = (p: JobPosting, nowMs: number) => p.role_kind !== null && postingState(p, nowMs) === "open";

const listedAt = (p: JobPosting) => Date.parse(p.posted_at ?? p.first_seen_at);

/**
 * The one role both drafts and Today name for a lead: the best-ranked kind first, then the newest in that kind (the board's date, else
 * when we first saw it). Kind comes before age so a fresh off-priority role never outranks the work the owner is actually after.
 */
export function pickRole(postings: JobPosting[], order: RoleKind[], nowMs: number): JobPosting | null {
  const rank = (p: JobPosting) => order.indexOf(p.role_kind!);
  let best: JobPosting | null = null;
  for (const p of postings) {
    if (!isCitable(p, nowMs)) continue;
    // NaN dates sort as oldest; id keeps the choice stable between runs.
    const age = (x: JobPosting) => (Number.isFinite(listedAt(x)) ? listedAt(x) : -Infinity);
    if (!best || rank(p) < rank(best) || (rank(p) === rank(best) && (age(p) > age(best) || (age(p) === age(best) && p.id < best.id)))) best = p;
  }
  return best;
}
