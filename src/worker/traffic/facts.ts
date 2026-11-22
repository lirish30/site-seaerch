import { z } from "zod";
import type { GbpMonth } from "../google/businessProfile";
import type { Ga4Month } from "../google/analytics";
import type { GscMonth } from "../google/searchConsole";
import { BLANK_LINES, MARKDOWN, REFUSED } from "../queue/wordGuards";
import { looksSecret } from "../sites/access";

// The traffic a client's site had in a month, as Google counted it (Plan 16), frozen into the report row when it is made. Only what Google measured goes in: a figure that was not measured (a source
// that is not linked, a property that could not be read, a month with nothing to compare with) is null, never 0. A real 0 is a month Google counted and found empty. Search queries and page paths are
// text written by strangers, so they pass `cleanQuery` / `cleanPath` first and are dropped (never trimmed) when they carry a link, an email, an amount, markdown or a key. Nothing about a person
// who visited exists here: Google withholds it. `profile` (Google Business Profile: calls, directions, website clicks) is filled only for a site with a Business Profile location, after the owner's profile consent.

const Count = z.number().int().min(0).max(1_000_000);
const COUNT_MAX = 1_000_000;
const QUERY_MAX = 80;
const PATH_MAX = 120;
const CHANNEL_MAX = 40;
const TOP_QUERIES = 5;
const TOP_PAGES = 5;
const TOP_CHANNELS = 6;

export const TrafficFacts = z.object({
  version: z.literal(1),
  /** The month reported, `YYYY-MM`, in Google's own month. */
  period: z.string().regex(/^\d{4}-(0[1-9]|1[0-2])$/),
  /** Search Console: how often the site showed in Google results and was clicked. Null when it is not linked or could not be read. */
  search: z.object({
    clicks: Count,
    impressions: Count,
    /** Average position in results, 1 to 100 to one decimal, or null when Google gave none (no impressions). */
    position: z.number().min(1).max(100).nullable(),
    previousClicks: Count.nullable(),
    previousImpressions: Count.nullable(),
    queries: z.array(z.object({ query: z.string().min(1).max(QUERY_MAX), clicks: Count, impressions: Count })).max(TOP_QUERIES),
    pages: z.array(z.object({ path: z.string().min(1).max(PATH_MAX), clicks: Count })).max(TOP_PAGES),
  }).nullable(),
  /** Analytics: visits to the site. Null when it is not linked or could not be read. */
  visits: z.object({
    sessions: Count,
    users: Count,
    /** Sessions that came from organic search. */
    organic: Count,
    /** Null when Google's answer carried no key-events figure. */
    keyEvents: Count.nullable(),
    previousSessions: Count.nullable(),
    previousOrganic: Count.nullable(),
    channels: z.array(z.object({ channel: z.string().min(1).max(CHANNEL_MAX), sessions: Count })).max(TOP_CHANNELS),
  }).nullable(),
  /** Google Business Profile: what people did on the listing. Null when no location is linked or it could not be read. */
  profile: z.object({ calls: Count, directions: Count, websiteClicks: Count, previousCalls: Count.nullable() }).nullable(),
});
export type TrafficFacts = z.infer<typeof TrafficFacts>;

/** Whether a month's traffic has a search, a visits or a profile block (something Google counted). A traffic value with none of them counts as no traffic for the report sections and Claude's rules. */
export function hasTrafficData(t: TrafficFacts | null | undefined): t is TrafficFacts {
  return !!t && (t.search !== null || t.visits !== null || t.profile !== null);
}

/** Whether a month's traffic has a search or a visits block. The strategy memo has no use for Business Profile counts (its own "profile" is the listing's rating and reviews), so it keeps this narrower test. */
export function hasSearchOrVisits(t: TrafficFacts | null | undefined): t is TrafficFacts {
  return !!t && (t.search !== null || t.visits !== null);
}

type Search = NonNullable<TrafficFacts["search"]>;
type Visits = NonNullable<TrafficFacts["visits"]>;
type Profile = NonNullable<TrafficFacts["profile"]>;

/** A count Google gave, kept inside what a `Count` allows. */
const count = (n: number): number => (Number.isFinite(n) ? Math.min(COUNT_MAX, Math.max(0, Math.round(n))) : 0);
const oneDecimal = (n: number): number => Math.round(n * 10) / 10;

/** A search query as a stranger typed it, cleaned for showing: whitespace collapsed. Null (dropped, not trimmed) when it is empty, over 80 characters, or carries a link, an email, a `$` amount,
 *  markdown, a `<` `>` or a backtick, or looks like a credential. */
export function cleanQuery(s: string): string | null {
  if (BLANK_LINES.test(s)) return null;
  const q = s.trim().replace(/\s+/g, " ");
  if (!q || q.length > QUERY_MAX) return null;
  if (/[<>`]/.test(q) || REFUSED.test(q) || MARKDOWN.test(q) || looksSecret(q)) return null;
  return q;
}

/** The path of a page address, nothing else: no host, query or fragment. Null when the address is not an http(s) one or a rooted path, the path is over 120 characters, uses a character outside
 *  `A-Z a-z 0-9 - . _ ~ / %`, or (decoded) would not pass as a query. */
export function cleanPath(url: string): string | null {
  const raw = url.trim();
  let path: string;
  try {
    const u = raw.startsWith("/") && !raw.startsWith("//") ? new URL(raw, "https://placeholder.invalid") : new URL(raw);
    if (u.protocol !== "https:" && u.protocol !== "http:") return null;
    path = u.pathname || "/";
  } catch { return null; }
  if (path.length > PATH_MAX || !/^[A-Za-z0-9\-._~/%]+$/.test(path)) return null;
  let decoded: string;
  try { decoded = decodeURIComponent(path); } catch { return null; }
  if (REFUSED.test(decoded) || looksSecret(decoded)) return null;
  return path;
}

/** Add `clicks` (and `impressions`) of equal keys together, keeping first-seen order for ties, then the top `n` by clicks. */
function top<T extends { clicks: number }>(rows: T[], key: (r: T) => string, add: (a: T, b: T) => T, n: number): T[] {
  const by = new Map<string, T>();
  for (const r of rows) { const k = key(r); const had = by.get(k); by.set(k, had ? add(had, r) : r); }
  return [...by.values()].sort((a, b) => b.clicks - a.clicks).slice(0, n);
}

type Q = Search["queries"][number];
type P = Search["pages"][number];
const addQ = (a: Q, b: Q): Q => ({ query: a.query, clicks: count(a.clicks + b.clicks), impressions: count(a.impressions + b.impressions) });
const addP = (a: P, b: P): P => ({ path: a.path, clicks: count(a.clicks + b.clicks) });

/** Search Console's month as the report keeps it. `prev` is the month before's totals, or null when there is none to compare with. */
export function shapeSearch(cur: GscMonth, prev: { clicks: number; impressions: number } | null): Search {
  const queries = cur.queries.flatMap((q) => {
    const query = cleanQuery(q.query);
    return query ? [{ query, clicks: count(q.clicks), impressions: count(q.impressions) }] : [];
  });
  const pages = cur.pages.flatMap((p) => {
    const path = cleanPath(p.page);
    return path ? [{ path, clicks: count(p.clicks) }] : [];
  });
  return {
    clicks: count(cur.clicks),
    impressions: count(cur.impressions),
    position: cur.position == null || !Number.isFinite(cur.position) ? null : Math.min(100, Math.max(1, oneDecimal(cur.position))),
    previousClicks: prev ? count(prev.clicks) : null,
    previousImpressions: prev ? count(prev.impressions) : null,
    queries: top(queries, (q) => q.query, addQ, TOP_QUERIES),
    pages: top(pages, (p) => p.path, addP, TOP_PAGES),
  };
}

/** An Analytics month as the report keeps it: the largest six channels by sessions. */
export function shapeVisits(r: Ga4Month): Visits {
  const channels = r.channels.flatMap((c) => {
    const channel = c.channel.trim().replace(/\s+/g, " ").slice(0, CHANNEL_MAX);
    return channel ? [{ channel, sessions: count(c.sessions) }] : [];
  });
  return {
    sessions: count(r.sessions),
    users: count(r.users),
    organic: count(r.organic),
    keyEvents: r.keyEvents == null ? null : count(r.keyEvents),
    previousSessions: count(r.previous.sessions),
    previousOrganic: count(r.previous.organic),
    channels: channels.sort((a, b) => b.sessions - a.sessions).slice(0, TOP_CHANNELS),
  };
}

/** A Business Profile month as the report keeps it. */
export function shapeProfile(r: GbpMonth): Profile {
  return { calls: count(r.calls), directions: count(r.directions), websiteClicks: count(r.websiteClicks), previousCalls: r.previousCalls === null ? null : count(r.previousCalls) };
}

const sum = (xs: number[]): number => count(xs.reduce((a, b) => a + b, 0));
/** The sum of a figure, or null unless EVERY part has it (a partial sum would understate the month). */
const sumAll = (xs: (number | null)[]): number | null => (xs.length > 0 && xs.every((x) => x != null) ? sum(xs as number[]) : null);

function mergeSearch(parts: Search[]): Search | null {
  if (!parts.length) return null;
  // Position is averaged by impressions; a part with no impressions or no position says nothing about it.
  const weighted = parts.filter((p) => p.position != null && p.impressions > 0);
  const weight = weighted.reduce((a, p) => a + p.impressions, 0);
  return {
    clicks: sum(parts.map((p) => p.clicks)),
    impressions: sum(parts.map((p) => p.impressions)),
    position: weight > 0 ? Math.min(100, Math.max(1, oneDecimal(weighted.reduce((a, p) => a + p.position! * p.impressions, 0) / weight))) : null,
    previousClicks: sumAll(parts.map((p) => p.previousClicks)),
    previousImpressions: sumAll(parts.map((p) => p.previousImpressions)),
    queries: top(parts.flatMap((p) => p.queries), (q) => q.query, addQ, TOP_QUERIES),
    pages: top(parts.flatMap((p) => p.pages), (p) => p.path, addP, TOP_PAGES),
  };
}

function mergeVisits(parts: Visits[]): Visits | null {
  if (!parts.length) return null;
  const by = new Map<string, number>();
  for (const c of parts.flatMap((p) => p.channels)) by.set(c.channel, (by.get(c.channel) ?? 0) + c.sessions);
  return {
    sessions: sum(parts.map((p) => p.sessions)),
    users: sum(parts.map((p) => p.users)),
    organic: sum(parts.map((p) => p.organic)),
    keyEvents: sumAll(parts.map((p) => p.keyEvents)),
    previousSessions: sumAll(parts.map((p) => p.previousSessions)),
    previousOrganic: sumAll(parts.map((p) => p.previousOrganic)),
    channels: [...by].map(([channel, sessions]) => ({ channel, sessions: count(sessions) })).sort((a, b) => b.sessions - a.sessions).slice(0, TOP_CHANNELS),
  };
}

function mergeProfile(parts: Profile[]): Profile | null {
  if (!parts.length) return null;
  return {
    calls: sum(parts.map((p) => p.calls)),
    directions: sum(parts.map((p) => p.directions)),
    websiteClicks: sum(parts.map((p) => p.websiteClicks)),
    previousCalls: sumAll(parts.map((p) => p.previousCalls)),
  };
}

/** Several sites of one client as one month. A block is null when no part has it; the whole is null when no part has any block. */
export function mergeTraffic(period: string, parts: TrafficFacts[]): TrafficFacts | null {
  const search = mergeSearch(parts.flatMap((p) => (p.search ? [p.search] : [])));
  const visits = mergeVisits(parts.flatMap((p) => (p.visits ? [p.visits] : [])));
  const profile = mergeProfile(parts.flatMap((p) => (p.profile ? [p.profile] : [])));
  if (!search && !visits && !profile) return null;
  return TrafficFacts.parse({ version: 1, period, search, visits, profile });
}

const n = (x: number, one: string, many: string) => `${x.toLocaleString("en-US")} ${x === 1 ? one : many}`;

/** One short sentence for each block that is not null, every one saying who counted. Nothing about a block that is null, nothing about what the numbers led to, and no query or page (the page shows those). */
export function plainTraffic(t: TrafficFacts): string[] {
  const out: string[] = [];
  if (t.search) {
    const s = t.search;
    const pos = s.position == null ? "" : `, at an average position of ${s.position}`;
    out.push(`In Google's search results, counted by Google, your site was shown ${n(s.impressions, "time", "times")} and clicked ${n(s.clicks, "time", "times")}${pos}.`);
  }
  if (t.visits) {
    const v = t.visits;
    out.push(`Your site had ${n(v.sessions, "visit", "visits")} from ${n(v.users, "person", "people")}, counted by Google, and ${v.organic.toLocaleString("en-US")} of the visits came from search.`);
  }
  if (t.profile) {
    const p = t.profile;
    out.push(`On your Google Business Profile, counted by Google, people tapped to call ${n(p.calls, "time", "times")}, asked for directions ${n(p.directions, "time", "times")} and clicked through to your website ${n(p.websiteClicks, "time", "times")}.`);
  }
  return out;
}
