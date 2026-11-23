import type { PublicSeoReport, PublicSeoTerm } from "../worker/seo/reportPublic";
import { dayLabel } from "./careReportPageView";

/**
 * Pure helpers for the client's monthly Local SEO report page (`/l/<token>`). Plain values in, plain text out: no DOM, no fetch, no clock. Every rank is "in our check" (nine points around the business,
 * page one of Google's own results), and nothing here says what a position will be: no sentence of ours looks forward.
 */

export type { PublicSeoReport, PublicSeoTerm };
type Point = PublicSeoTerm["points"][number];
export interface SeoWords { summary: string; recommendation: string; priorities: string[] }
/** The numbers of a report: everything on the public page but the words written for it and the day it was sent. */
export type SeoFacts = Omit<PublicSeoReport, keyof SeoWords | "sentOn">;

const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;

/** One grid cell: the band the position is in, "not in the top 20" for a point that was checked and did not show the business, and "not checked" for a point that was not measured. */
export function cellText(p: Point): string {
  if (!p || p.ok !== true) return "not checked";
  if (p.pos === null || !Number.isFinite(p.pos) || p.pos > 20) return "not in the top 20";
  if (p.pos <= 3) return "1-3";
  return p.pos <= 10 ? "4-10" : "11-20";
}

/** The nine cells as three rows of three, row by row from the north-west; a list that is short is filled with "not checked", a long one is cut at nine. */
function gridRows(points: Point[]): string[][] {
  const cells = Array.from({ length: 9 }, (_, i) => cellText(points[i] ?? { pos: null, ok: false }));
  return [cells.slice(0, 3), cells.slice(3, 6), cells.slice(6, 9)];
}

const KIND_LABEL: Record<string, string> = { page: "Page", post: "Blog post", gbp_post: "Google post" };

export interface SeoTermView {
  /** `drain cleaning in Tigard`, or just the term when it has no town. Entered text: show it as text only. */
  heading: string;
  rows: string[][];
  /** How many of the measured points had the business in the top 3, or why that cannot be said. */
  summaryLine: string;
  /** What the previous check had, only when both checks measured enough points; null for a first report. */
  movement: string | null;
}

export interface SeoReportView {
  title: string;
  /** `in our check on 1 Dec`, or null when there was no rank check. */
  rankLine: string | null;
  /** The sentence that says what the grids are and which check they show. */
  gridNote: string;
  firstCheck: boolean;
  /** Whether there was a rank check to draw: with none, `terms` is empty and the page draws no grid (it says there is none). */
  hasGrids: boolean;
  terms: SeoTermView[];
  profile: { label: string; value: string }[];
  content: { titles: { kind: string; title: string }[]; line: string };
  citations: { label: string; value: string }[];
  summary: string;
  recommendation: string;
  priorities: string[];
}

function termView(t: PublicSeoTerm, previousRankAsOf: string | null): SeoTermView {
  const rows = gridRows(t.points);
  if (t.visible === null) return { heading: t.town ? `${t.term} in ${t.town}` : t.term, rows, summaryLine: "Not enough points were checked to say how often the business showed in the top 3.", movement: null };
  const before = dayLabel(previousRankAsOf);
  const movement = previousRankAsOf !== null && t.previousVisible !== null && before
    ? `In the check on ${before}, ${t.previousVisible === 1 ? "1 point was" : `${t.previousVisible} points were`} in the top 3.`
    : null;
  return { heading: t.town ? `${t.term} in ${t.town}` : t.term, rows, summaryLine: `In the top 3 at ${t.visible} of ${t.measured} points.`, movement };
}

/** The page's content as plain text, from the report's facts (the public part of them) and the words written for it. */
export function seoReportPageView(facts: SeoFacts, words: SeoWords): SeoReportView {
  const asOf = dayLabel(facts.rankAsOf);
  const g = facts.gbp;
  const profile: { label: string; value: string }[] = [];
  if (g.rating !== null) profile.push({ label: "Rating", value: `${g.rating} out of 5` });
  if (g.reviewCount !== null) profile.push({ label: "Reviews", value: String(g.reviewCount) });
  if (g.reviewsGained !== null) profile.push({ label: "Reviews gained", value: g.reviewsGained > 0 ? `${g.reviewsGained} since the previous check` : "None since the previous check" });
  profile.push({ label: "New reviews seen this month", value: String(facts.reviews.seen) }, { label: "Replies posted", value: String(facts.reviews.posted) });

  const published = facts.content.published;
  return {
    title: `Local SEO report, ${facts.label}`,
    rankLine: asOf ? `in our check on ${asOf}` : null,
    gridNote: asOf
      ? `Each grid shows our check from ${asOf}: Google was searched from nine points around the business, and each cell says where the business showed in the results from that point. The top left is the north-west.`
      : "There was no rank check for this report, so there are no grids to show.",
    firstCheck: facts.rankAsOf !== null && facts.previousRankAsOf === null,
    hasGrids: facts.rankAsOf !== null,
    terms: facts.rankAsOf === null ? [] : facts.terms.map((t) => termView(t, facts.previousRankAsOf)),
    profile,
    content: {
      titles: published.map((c) => ({ kind: KIND_LABEL[c.kind] ?? "Page", title: c.title })),
      line: published.length === 0 ? "Nothing was published this month." : `${plural(published.length, "piece was", "pieces were")} published this month.`,
    },
    citations: facts.citations ? [
      { label: "Confirmed", value: String(facts.citations.listed) }, { label: "Need fixing", value: String(facts.citations.needsFix) }, { label: "Still to do", value: String(facts.citations.todo) },
    ] : [],
    summary: words.summary,
    recommendation: words.recommendation,
    priorities: words.priorities.slice(0, 3),
  };
}

export type GlanceTone = "neutral" | "positive" | "warning" | "info" | "signal";

/** The line and chips at the top of the report: the best term's top-3 count, then reviews, what was published and listings to fix. Only measured figures; nothing looks forward. */
export function seoGlance(facts: Pick<PublicSeoReport, "rankAsOf" | "terms" | "gbp" | "content" | "citations">): { headline: string; chips: { text: string; tone: GlanceTone }[] } {
  const measured = facts.rankAsOf === null ? [] : facts.terms.filter((t) => t.visible !== null);
  const best = measured.reduce<PublicSeoTerm | null>((a, t) => (a === null || (t.visible ?? 0) > (a.visible ?? 0) ? t : a), null);
  const headline = best
    ? `In the top 3 at ${best.visible} of ${best.measured} points for "${best.town ? `${best.term} in ${best.town}` : best.term}"`
    : facts.rankAsOf === null ? "No rank check this month" : "Your first rank check";
  const chips: { text: string; tone: GlanceTone }[] = [];
  if (best && best.previousVisible !== null && best.visible !== null && best.visible !== best.previousVisible) {
    chips.push(best.visible > best.previousVisible ? { text: `Up from ${best.previousVisible}`, tone: "positive" } : { text: `Down from ${best.previousVisible}`, tone: "warning" });
  }
  if (facts.gbp.rating !== null) chips.push({ text: `${facts.gbp.rating} stars${facts.gbp.reviewCount !== null ? `, ${facts.gbp.reviewCount} reviews` : ""}`, tone: "neutral" });
  if (facts.gbp.reviewsGained !== null && facts.gbp.reviewsGained > 0) chips.push({ text: `${plural(facts.gbp.reviewsGained, "new review", "new reviews")}`, tone: "positive" });
  const n = facts.content.published.length;
  if (n > 0) chips.push({ text: `${plural(n, "piece", "pieces")} published`, tone: "info" });
  if (facts.citations && facts.citations.needsFix > 0) chips.push({ text: `${plural(facts.citations.needsFix, "listing", "listings")} to fix`, tone: "warning" });
  return { headline, chips };
}
