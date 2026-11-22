import { z } from "zod";
import { getBusiness } from "../db/businesses";
import { getProfile, listKeywords, snapshotsFor } from "../db/seo";
import { getSettings } from "../db/settings";
import type { Env } from "../env";
import { tidy } from "../seo/profile";
import { zoneOf } from "../sop/cadence";
import { previousMonth } from "../sop/months";
import { hasSearchOrVisits, TrafficFacts } from "../traffic/facts";
import { trafficFor } from "../traffic/forClient";

// What a client's strategy memo is written from (Plan 16): the facts frozen into the memo row when it is made. Claude reads them and the client's page shows them, so nothing in them is text a stranger wrote:
// the search queries and page paths of Google's numbers are left out (`queries` and `pages` are empty), and the client's own name, trade, towns and keywords are tidied and capped. A figure that was not measured
// is null, never 0.

const NAME_MAX = 200;
const TRADE_MAX = 80;
const TOWN_MAX = 80;
const KEYWORD_MAX = 120;
const TOWNS = 8;
const KEYWORDS = 12;
/** How many finished months back from last month the newest traffic is looked for in (last month included). */
const MONTHS_BACK = 3;

export const MemoFacts = z.object({
  version: z.literal(1),
  clientName: z.string().max(NAME_MAX),
  trade: z.string().max(TRADE_MAX).nullable(),
  towns: z.array(z.string().max(TOWN_MAX)).max(TOWNS),
  keywords: z.array(z.string().max(KEYWORD_MAX)).max(KEYWORDS),
  /** Search Console's figures of `period`, with no query or page text. Null when it is not linked, could not be read, or there is no month with data. */
  search: TrafficFacts.shape.search,
  visits: TrafficFacts.shape.visits,
  /** The month the traffic is from (`YYYY-MM`), or null when there is none. */
  period: z.string().regex(/^\d{4}-(0[1-9]|1[0-2])$/).nullable(),
  /** The latest Google Business Profile reading of the listing, or null when there is none. */
  profile: z.object({ rating: z.number().nullable(), reviewCount: z.number().int().nullable() }).nullable(),
  generatedAt: z.string(),
});
export type MemoFacts = z.infer<typeof MemoFacts>;

/** A refusal the owner can read: nothing was made. `status` is the HTTP answer a route gives it. */
export class MemoRefused extends Error {
  readonly status = 409;
  constructor(message: string) { super(message); this.name = "MemoRefused"; }
}

export const NOTHING_MEASURED = "Nothing has been measured for this client yet. Set up their Local SEO profile or link their Search Console first.";

/** Typed text, tidied and capped; null when nothing is left. */
function cleaned(s: string, max: number): string | null {
  const t = tidy(s).slice(0, max).trim();
  return t || null;
}
const uniq = (xs: string[]): string[] => [...new Set(xs)];

/**
 * The facts of a client's memo as they are `now`. The traffic is the newest of the last three finished months (in the booking zone) whose merged pull has a search or a visits block; a month that failed
 * contributes nothing. Refuses (`MemoRefused`) when there is no Local SEO profile, no active keyword and no search block: a memo needs something that was measured.
 */
export async function buildMemoFacts(env: Env, businessId: string, now: Date): Promise<MemoFacts> {
  const db = env.DB;
  const [business, profile, keywords, snapshots, settings] = await Promise.all([
    getBusiness(db, businessId), getProfile(db, businessId), listKeywords(db, businessId, { activeOnly: true }), snapshotsFor(db, businessId, {}), getSettings(db),
  ]);

  let period: string | null = null;
  let traffic: TrafficFacts | null = null;
  const tz = zoneOf(settings);
  let month = previousMonth(now, tz);
  for (let i = 0; i < MONTHS_BACK && !traffic; i++) {
    const found = await trafficFor(db, businessId, month);
    if (hasSearchOrVisits(found)) { traffic = found; period = month; }
    const [y, m] = month.split("-").map(Number);
    month = m === 1 ? `${y - 1}-12` : `${y}-${String(m - 1).padStart(2, "0")}`;
  }
  // Text written by strangers stays out: the figures are kept, the queries and pages are not.
  const search = traffic?.search ? { ...traffic.search, queries: [], pages: [] } : null;

  if (!profile && keywords.length === 0 && !search) throw new MemoRefused(NOTHING_MEASURED);

  const latest = snapshots.at(-1);
  const gbp = latest && (latest.rating !== null || latest.reviewCount !== null) ? { rating: latest.rating, reviewCount: latest.reviewCount } : null;
  const terms = keywords.flatMap((k) => {
    const term = cleaned(k.term, KEYWORD_MAX);
    if (!term) return [];
    const town = cleaned(k.town, TOWN_MAX);
    const text = cleaned(town ? `${term} in ${town}` : term, KEYWORD_MAX);
    return text ? [text] : [];
  });

  return MemoFacts.parse({
    version: 1,
    clientName: cleaned(business?.name ?? "", NAME_MAX) ?? "this client",
    trade: profile ? cleaned(profile.trade, TRADE_MAX) : null,
    towns: uniq((profile?.towns ?? []).flatMap((t) => cleaned(t, TOWN_MAX) ?? [])).slice(0, TOWNS),
    keywords: uniq(terms).slice(0, KEYWORDS),
    search,
    visits: traffic?.visits ?? null,
    period,
    profile: gbp,
    generatedAt: now.toISOString(),
  });
}
