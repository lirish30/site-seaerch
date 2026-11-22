import { z } from "zod";
import { monthRange } from "../care/reportFacts";
import { getSettings } from "../db/settings";
import {
  getProfile, listCitations, listContent, listKeywords, listReviews, rankChecksFor, snapshotsFor, type GbpSnapshot, type RankCheck, type RankPoint,
} from "../db/seo";
import type { Env } from "../env";
import { periodLabel, zoneOf } from "../sop/cadence";
import { hasTrafficData, plainTraffic, TrafficFacts } from "../traffic/facts";
import { trafficFor } from "../traffic/forClient";
import { isUsable } from "./grid";
import { parseNapResult } from "./nap";

// The facts a client's monthly Local SEO report is built from (Plan 14), frozen into the report row when it is made. Only what the app measured goes in: a number it could not measure is null,
// never 0. A rank is only ever "in our check" (nine points around the business, page one of Google's own results), and nothing here says what a position will be. NOTHING a client or a stranger
// wrote goes in beyond the client's own name and search terms: no review text, no reviewer name, no Google place id, no map location, no token, no text from the client's site.

const NAP_PART = z.enum(["match", "mismatch", "missing", "unknown"]);
const Count = z.number().int().min(0).max(1_000_000);
const CONTENT_KIND = z.enum(["page", "post", "gbp_post"]);

export const SeoReportFacts = z.object({
  version: z.literal(1),
  /** The month reported, `YYYY-MM`. */
  period: z.string().regex(/^\d{4}-(0[1-9]|1[0-2])$/),
  /** `November 2026`. */
  label: z.string().min(1).max(40),
  clientName: z.string().max(200),
  /** The booking-zone date of the check the ranks are from (the first usable one on or after the 1st of the next month), or null when there was none. */
  rankAsOf: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).nullable(),
  /** The date of the usable check before it, or null (this is the first check, or there was no check to compare with). */
  previousRankAsOf: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).nullable(),
  terms: z.array(z.object({
    term: z.string().min(1).max(200),
    town: z.string().min(1).max(200).nullable(),
    /** The nine grid points, row by row from the north-west: `pos` null with `ok` true is "not in the top 20", `ok` false is "not checked". Where they are on the map is not kept. */
    points: z.array(z.object({ pos: z.number().int().min(1).max(100).nullable(), ok: z.boolean() })).max(9),
    /** How many points were measured (`ok`). */
    measured: z.number().int().min(0).max(9),
    /** How many points showed the business at position 3 or better, or null when the check is not usable (too few points measured). */
    visible: z.number().int().min(0).max(9).nullable(),
    /** The same for the previous usable check, or null when there is none. */
    previousVisible: z.number().int().min(0).max(9).nullable(),
  })).max(50),
  gbp: z.object({
    rating: z.number().min(0).max(5).nullable(),
    reviewCount: Count.nullable(),
    /** The rise in the review count since the snapshot before, null when it fell, there is no earlier snapshot, or this is the first report (no earlier rank check, so nothing is compared). */
    reviewsGained: Count.nullable(),
    ratingChange: z.number().min(-5).max(5).nullable(),
  }),
  /** Reviews first seen in the month: how many, how many have a reply posted, and how many low ones still wait for an answer. Counts only. */
  reviews: z.object({ seen: Count, posted: Count, needsYou: Count }),
  content: z.object({
    published: z.array(z.object({ kind: CONTENT_KIND, title: z.string().max(300) })).max(50),
    drafted: Count,
    planned: Count,
  }),
  /** The directory list's counts, or null when the client has no list. */
  citations: z.object({ listed: Count, needsFix: Count, todo: Count }).nullable(),
  /** The last name, address and phone check of the website, or null when there is none. */
  nap: z.object({ phone: NAP_PART, address: NAP_PART, name: NAP_PART }).nullable(),
  /** What Google counted for the client's sites that month (Plan 16). Absent (a report frozen before it) or null: no section, and nothing said. Search Console's average `position` lives only in here: the rank grid above is the only rank claim. */
  traffic: TrafficFacts.nullable().optional(),
  generatedAt: z.string().min(1).max(40),
});
export type SeoReportFacts = z.infer<typeof SeoReportFacts>;

type Point = { pos: number | null; ok: boolean };
type Term = SeoReportFacts["terms"][number];

const SUMMARY_MAX = 600;
/** A point at this position or better counts as "visible". */
const VISIBLE_AT = 3;
const MONTHS = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];

/** The calendar date `n` days after the `YYYY-MM-DD` date `day`. */
function daysAfter(day: string, n: number): string {
  const [y, m, d] = day.split("-").map(Number);
  return new Date(Date.UTC(y, m - 1, d + n)).toISOString().slice(0, 10);
}

/** A stored point as the report keeps it. One that cannot be read (no true or false for `ok`, or a position that is not a whole number from 1 to 100) is "not checked": never a guess at "not found". */
function cleanPoint(p: RankPoint): Point {
  if (!p || p.ok !== true) return { pos: null, ok: false };
  if (p.pos === null) return { pos: null, ok: true };
  return Number.isInteger(p.pos) && p.pos >= 1 && p.pos <= 100 ? { pos: p.pos, ok: true } : { pos: null, ok: false };
}
const cleaned = (c: RankCheck): Point[] => c.points.slice(0, 9).map(cleanPoint);
const NOT_CHECKED: Point[] = Array.from({ length: 9 }, () => ({ pos: null, ok: false }));
/** The same rule as everywhere else (enough points measured), through its one definition. */
const usable = (points: Point[]): boolean => isUsable(points.map((p) => ({ lat: 0, lng: 0, ...p })));
const measuredOf = (points: Point[]): number => points.filter((p) => p.ok).length;
const visibleOf = (points: Point[]): number => points.filter((p) => p.ok && p.pos !== null && p.pos <= VISIBLE_AT).length;

/**
 * One term's numbers. Its check is the first usable one on or after `after` (the 1st of the month after the one reported), or, when none of those is usable, the first check on or after it, shown
 * with `visible` null. The previous check is the last usable one before the check shown, and only a usable check has one.
 */
function termFacts(term: string, town: string, checks: RankCheck[], after: string): { fact: Term; asOf: string | null; previousAsOf: string | null } {
  const later = checks.filter((c) => c.takenOn >= after);
  const good = later.find((c) => usable(cleaned(c)));
  const shown = good ?? later[0] ?? null;
  const points = shown ? cleaned(shown) : NOT_CHECKED;
  const before = good ? checks.filter((c) => c.takenOn < good.takenOn && usable(cleaned(c))).at(-1) ?? null : null;
  return {
    fact: {
      term: term.slice(0, 200), town: town.trim() === "" ? null : town.slice(0, 200), points, measured: measuredOf(points),
      visible: good ? visibleOf(points) : null, previousVisible: before ? visibleOf(cleaned(before)) : null,
    },
    asOf: good?.takenOn ?? null, previousAsOf: before?.takenOn ?? null,
  };
}

const earliest = (days: (string | null)[]): string | null => days.reduce<string | null>((low, d) => (d !== null && (low === null || d < low) ? d : low), null);

/**
 * The snapshots a report compares: the first one on or after `after` (the month's end as the rank check sees it), or, when none was taken yet, the last one inside the month; and the last one before that.
 * A snapshot from before the month is never the current one.
 */
function snapshotPair(all: GbpSnapshot[], fromDay: string, after: string): { current: GbpSnapshot | null; previous: GbpSnapshot | null } {
  const current = all.find((s) => s.takenOn >= after) ?? all.filter((s) => s.takenOn >= fromDay && s.takenOn < after).at(-1) ?? null;
  const previous = current ? all.filter((s) => s.takenOn < current.takenOn).at(-1) ?? null : null;
  return { current, previous };
}

/**
 * The facts of the report of `period` (the month REPORTED, `YYYY-MM`) for a client, as of `now`. Days are the booking zone's: a check is stored under its local date, so one taken late on the last
 * evening of the month is the month's, and `rankAsOf` is the first usable check on or after the 1st of the next month (null when there is none yet).
 */
export async function buildSeoFacts(env: Env, businessId: string, period: string, now: Date): Promise<SeoReportFacts> {
  const tz = zoneOf(await getSettings(env.DB));
  const range = monthRange(period, tz);
  const after = daysAfter(range.toDay, 1);
  const name = (await env.DB.prepare(`SELECT name FROM businesses WHERE id = ?`).bind(businessId).first<{ name: string }>())?.name ?? "";

  const keywords = await listKeywords(env.DB, businessId, { activeOnly: true });
  const checks = await rankChecksFor(env.DB, businessId, {});
  const terms = keywords.map((k) => termFacts(k.term, k.town, checks.filter((c) => c.keywordId === k.id), after));

  const { current, previous } = snapshotPair(await snapshotsFor(env.DB, businessId, {}), range.fromDay, after);
  const previousRankAsOf = earliest(terms.map((t) => t.previousAsOf));
  // A first report (no earlier rank check) says nothing is compared, so it claims no gain either, even when an earlier snapshot makes one possible.
  const gained = previousRankAsOf !== null && current?.reviewCount != null && previous?.reviewCount != null && current.reviewCount >= previous.reviewCount ? current.reviewCount - previous.reviewCount : null;
  const change = current?.rating != null && previous?.rating != null ? Math.round((current.rating - previous.rating) * 10) / 10 || 0 : null;

  // Only counts leave the reviews: their text, authors and ids are never copied.
  const seen = (await listReviews(env.DB, businessId)).filter((r) => r.firstSeenOn >= range.fromDay && r.firstSeenOn <= range.toDay);

  const content = await listContent(env.DB, { businessId, period });
  const citations = await listCitations(env.DB, businessId);
  const profile = await getProfile(env.DB, businessId);
  const nap = parseNapResult(profile?.napResult ?? null);

  return SeoReportFacts.parse({
    version: 1, period, label: periodLabel("monthly", period), clientName: name.slice(0, 200),
    rankAsOf: earliest(terms.map((t) => t.asOf)), previousRankAsOf,
    terms: terms.map((t) => t.fact),
    gbp: { rating: current?.rating ?? null, reviewCount: current?.reviewCount ?? null, reviewsGained: gained, ratingChange: change },
    reviews: {
      seen: seen.length, posted: seen.filter((r) => r.replyStatus === "posted").length,
      needsYou: seen.filter((r) => r.flagged && r.replyStatus !== "posted" && r.replyStatus !== "skipped").length,
    },
    content: {
      published: content.filter((c) => c.status === "published").map((c) => ({ kind: c.kind, title: c.title.slice(0, 300) })).slice(0, 50),
      drafted: content.filter((c) => c.status === "drafted" || c.status === "approved").length,
      planned: content.filter((c) => c.status === "planned" || c.status === "drafting").length,
    },
    citations: citations.length ? {
      listed: citations.filter((c) => c.status === "listed").length, needsFix: citations.filter((c) => c.status === "needs_fix").length, todo: citations.filter((c) => c.status === "todo").length,
    } : null,
    nap: nap ? { phone: nap.phone, address: nap.address, name: nap.name } : null,
    traffic: await trafficFor(env.DB, businessId, period),
    generatedAt: now.toISOString(),
  });
}

// --- the plain summary -----------------------------------------------------------------------------------------------------------------------------------------------

const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;
const dayText = (day: string) => `${MONTHS[Number(day.slice(5, 7)) - 1]} ${Number(day.slice(8, 10))}`;
const sum = (xs: number[]) => xs.reduce((a, b) => a + b, 0);
const listOf = (xs: string[]) => (xs.length <= 2 ? xs.join(" and ") : `${xs.slice(0, -1).join(", ")} and ${xs.at(-1)}`);

/**
 * A summary written by code from the numbers alone, in fixed sentences: what Claude's draft falls back to. At most 600 characters (a sentence that would pass the limit is left out whole), no
 * address, no search term or any other entered text, and no promise. It says "first check" when there is nothing earlier to compare with, and only compares what was measured both times.
 * What was not measured is left out, never said as zero.
 */
export function plainSeoSummary(f: SeoReportFacts): string {
  const lines: string[] = [`Local SEO report for ${f.label}.`];

  if (f.rankAsOf === null) lines.push("No rank check was available for this report.");
  else {
    const shown = f.terms.filter((t) => t.visible !== null);
    lines.push(`In our check on ${dayText(f.rankAsOf)}, the business showed in the top 3 at ${sum(shown.map((t) => t.visible!))} of ${sum(shown.map((t) => t.measured))} checked points across ${plural(shown.length, "search term", "search terms")}.`);
    if (f.previousRankAsOf === null) lines.push("This is the first check, so nothing to compare yet.");
    else {
      const both = shown.filter((t) => t.previousVisible !== null);
      if (both.length === shown.length && both.length > 0) lines.push(`That compares with ${sum(both.map((t) => t.previousVisible!))} points at the previous check on ${dayText(f.previousRankAsOf)}.`);
      else if (both.length > 0) lines.push(`For the ${plural(both.length, "search term", "search terms")} checked both times it was ${sum(both.map((t) => t.visible!))} points, compared with ${sum(both.map((t) => t.previousVisible!))} at the previous check on ${dayText(f.previousRankAsOf)}.`);
    }
    if (shown.length < f.terms.length) lines.push(`${plural(f.terms.length - shown.length, "search term", "search terms")} did not have enough measured points to show.`);
  }

  const g = f.gbp;
  if (g.reviewCount !== null) lines.push(`The Google profile shows ${plural(g.reviewCount, "review", "reviews")}${g.rating !== null ? `, rated ${g.rating} out of 5` : ""}.`);
  else if (g.rating !== null) lines.push(`The Google profile is rated ${g.rating} out of 5.`);
  if (g.reviewsGained !== null) lines.push(g.reviewsGained > 0 ? `It gained ${plural(g.reviewsGained, "review", "reviews")} since the previous check.` : "It gained no new reviews since the previous check.");

  // A part of the name check that did not match matters more than the counts after it, so it comes before them; a clean result is the last thing said, if there is room.
  const parts: (keyof NonNullable<SeoReportFacts["nap"]>)[] = ["name", "address", "phone"];
  const off = f.nap ? parts.filter((p) => f.nap![p] === "mismatch") : [], gone = f.nap ? parts.filter((p) => f.nap![p] === "missing") : [];
  if (off.length) lines.push(`The ${listOf(off)} on the website did not match the details on file.`);
  if (gone.length) lines.push(`The ${listOf(gone)} could not be found on the website.`);

  if (f.reviews.seen > 0) {
    lines.push(`${plural(f.reviews.seen, "new review was", "new reviews were")} seen${f.reviews.posted > 0 ? `, and ${plural(f.reviews.posted, "reply was", "replies were")} posted` : ""}.`);
  }
  if (f.reviews.needsYou > 0) lines.push(`${plural(f.reviews.needsYou, "low-rated review still needs", "low-rated reviews still need")} an answer.`);

  if (f.content.published.length) lines.push(`${plural(f.content.published.length, "piece of content was", "pieces of content were")} published.`);
  if (f.content.drafted > 0) lines.push(`${plural(f.content.drafted, "piece of content is", "pieces of content are")} written and waiting to go live.`);

  if (f.citations) {
    const total = f.citations.listed + f.citations.needsFix + f.citations.todo;
    if (total > 0) lines.push(`${f.citations.listed} of ${plural(total, "directory listing is", "directory listings are")} confirmed${f.citations.needsFix > 0 ? `, and ${f.citations.needsFix} need fixing` : ""}.`);
  }

  // A part that was not compared (the listing has nothing to compare it with) is never mentioned to the client.
  const same = f.nap ? parts.filter((p) => f.nap![p] === "match") : [];
  if (f.nap && !off.length && !gone.length && same.length > 0) lines.push(`The ${listOf(same)} on the website match the details on file.`);

  // Last, so what Google counted never pushes out a sentence about the rank check or the listing.
  if (hasTrafficData(f.traffic)) lines.push(...plainTraffic(f.traffic, { positionWording: "average position in Google Search" }));

  let text = lines[0];
  for (const line of lines.slice(1)) {
    if (`${text} ${line}`.length > SUMMARY_MAX) continue;
    text = `${text} ${line}`;
  }
  return text;
}
