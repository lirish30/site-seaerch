import { z } from "zod";
import type { ReportFacts } from "../care/reportFacts";
import type { SeoReportFacts } from "../seo/reportFacts";

// The scenes of a report's short video (Plan 16): a title card, up to four numbers and an end card, built ONLY from the numbers and fixed phrases of the report's frozen facts. No word Claude wrote
// (the summary, the recommendation, the priorities) and no text a stranger wrote (a search query, a page, a channel, a review) can reach a scene: the facts' text fields are never read except the
// client's own name and the month's label. ONE RULE for the numbers: a null or zero count never gets a scene (it is a highlights reel, and the end card points to the full report), so nothing is shown as 0 or "0 of 9".

/** The most a payload may carry, and what a scene's text may be (the helper puts it on a 1080 px square). */
export const MAX_SCENES = 6;
export const SCENE_LIMITS = { title: 80, big: 40, small: 120 } as const;
/** The least a video is worth making with: a title card, one number and an end card. */
const MIN_SCENES = 3;
/** Between the title card and the end card. */
const MAX_NUMBERS = 4;

export interface Scene { title: string; big: string; small: string }
export const SceneSchema: z.ZodType<Scene> = z.object({
  title: z.string().max(SCENE_LIMITS.title), big: z.string().max(SCENE_LIMITS.big), small: z.string().max(SCENE_LIMITS.small),
});

type Traffic = NonNullable<ReportFacts["traffic"]>;

const daysIn = (period: string): number => new Date(Date.UTC(Number(period.slice(0, 4)), Number(period.slice(5, 7)), 0)).getUTCDate();
const whole = (n: number): string => n.toLocaleString("en-US");
const sum = (xs: number[]): number => xs.reduce((a, b) => a + b, 0);
const scene = (title: string, big: string, small: string): Scene => ({ title: title.slice(0, SCENE_LIMITS.title), big: big.slice(0, SCENE_LIMITS.big), small: small.slice(0, SCENE_LIMITS.small) });

/** What Google counted: the two scenes that say so. A count of 0 (or a source that was not read) gives no scene. */
function trafficScenes(t: Traffic | null | undefined): Scene[] {
  const out: Scene[] = [];
  if (t?.search && t.search.clicks > 0) out.push(scene("Found on Google", whole(t.search.clicks), "Clicks from Google search to your site, counted by Google"));
  if (t?.visits && t.visits.sessions > 0) out.push(scene("Visits to your site", whole(t.visits.sessions), "Visits to your site, counted by Google"));
  return out;
}

function careNumbers(f: ReportFacts): Scene[] {
  const out: Scene[] = [];
  // A site is only counted when its figure and the day it was first watched are both known. Watched for less than the whole month (the way `plainSummary` tells it), the line says "of the time we checked" and the days.
  const measured = f.sites.filter((s) => s.uptimePercent !== null && s.monitoredSince !== null);
  if (measured.length) {
    const low = Math.min(...measured.map((s) => s.uptimePercent!));
    const partial = measured.some((s) => s.monitoredSince! > `${f.period}-01` || s.coveredDays < daysIn(f.period));
    const days = Math.min(...measured.map((s) => s.coveredDays));
    const when = partial ? `we checked this month (${days} ${days === 1 ? "day" : "days"})` : "this month";
    out.push(scene("Your site stayed up", `${low}%`, `Of the time ${when}${measured.length === 1 ? ", as measured by our monitoring" : " at the lowest of your sites, as measured by our monitoring"}`));
  }
  // An update run is what measured the update and backup numbers: a site none covered says nothing about them.
  const tracked = f.sites.filter((s) => s.updatesTracked === true);
  const updates = sum(tracked.map((s) => s.updatesApplied));
  if (updates > 0) out.push(scene("Updates done", whole(updates), tracked.length === 1 ? "Updates applied to your site this month" : "Updates applied to your sites this month"));
  const backups = sum(tracked.map((s) => s.backups));
  if (backups > 0) out.push(scene("Backups taken", whole(backups), "Safety copies saved before updates went in"));
  return [...out, ...trafficScenes(f.traffic)];
}

function seoNumbers(f: SeoReportFacts): Scene[] {
  const out: Scene[] = [];
  const shown = f.rankAsOf === null ? [] : f.terms.filter((t) => t.visible !== null);
  const measured = sum(shown.map((t) => t.measured));
  const visible = sum(shown.map((t) => t.visible!));
  if (shown.length && measured > 0 && visible > 0) out.push(scene("Where you show on Google", `${visible} of ${measured}`, "points in the top 3 in our check"));
  if (f.gbp.reviewsGained !== null && f.gbp.reviewsGained > 0) out.push(scene("New reviews", whole(f.gbp.reviewsGained), "New reviews on your Google profile since the last check"));
  return [...out, ...trafficScenes(f.traffic)];
}

/**
 * The scenes of the video of a report's frozen facts: the title card (the client's name, the month, "Your monthly report"), up to four numbers in a fixed order (Care: uptime, updates, backups, search clicks,
 * visits; Local SEO: rank points, new reviews, search clicks, visits) and the end card. Fewer than three scenes in all gives none, and no video is made.
 */
export function buildScenes(kind: "care" | "seo", facts: ReportFacts | SeoReportFacts): Scene[] {
  const numbers = (kind === "care" ? careNumbers(facts as ReportFacts) : seoNumbers(facts as SeoReportFacts)).slice(0, MAX_NUMBERS);
  const name = facts.clientName.trim() || "Your business";
  const scenes = [scene(name, facts.label, "Your monthly report"), ...numbers, scene(name, "Thank you", "The full report is on this page")];
  return scenes.length < MIN_SCENES ? [] : scenes;
}
