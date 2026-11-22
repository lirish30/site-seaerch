import type { GridRow } from "../worker/seo/overview";
import type { NapPart, NapResult } from "../worker/seo/nap";
import type { SeoReportRow } from "../worker/seo/reportAdmin";
import type { Citation, CitationStatus, ContentKind, ContentStatus, ContentItem, GbpSnapshot, ReplyStatus, SeoKeyword, SeoProfile, SeoReview } from "../worker/db/seo";
import { periodLabel } from "../worker/sop/cadence";
import { statusChip } from "./careReportsView";

/**
 * The words on the owner's Local SEO pages (the panel on a client's page and the /seo board): pure functions, so the pages only lay text out. Ranks are only ever "in our check", and no sentence here
 * looks forward. Worker types are imported as types only; nothing from the worker runs in the browser except the month label.
 */

export type { GridRow, SeoReportRow };

/** How many search terms a client may have switched on at once; the server refuses an eleventh (`MAX_ACTIVE_KEYWORDS` in the routes). */
export const MAX_ACTIVE_KEYWORDS = 10;
const SEO_PLANS = ["local_seo", "local_seo_growth"];
/** True when one of the client's subscriptions is a Local SEO plan that is billing (active, or late on a bill). */
export function hasSeoPlan(subs: { packageKey: string; status: string; test?: boolean }[]): boolean {
  return subs.some((s) => SEO_PLANS.includes(s.packageKey) && (s.status === "active" || s.status === "past_due") && !s.test);
}

/** The template key of the Local SEO onboarding project (`SEO_ONBOARDING_KEY` in the worker; a test checks they match, and it is not imported here so no worker code reaches the browser). */
export const SEO_ONBOARDING = "SEO-0";
/**
 * True when the client has a Local SEO onboarding project that is not cancelled and not a rehearsal. The profile and the baseline are set up in SEO-0 before billing is live, so the panel has to open then.
 * A done SEO-0 counts (it is the ongoing service) and a paused one still shows the panel.
 */
export function hasSeoOnboarding(projects: { templateKey: string | null; status: string; test: boolean }[]): boolean {
  return projects.some((p) => p.templateKey === SEO_ONBOARDING && p.status !== "cancelled" && !p.test);
}

/** The grid is nine points: three rows of three from the north-west. */
export const GRID_POINTS = 9;

export type CellTone = "good" | "mid" | "low" | "none" | "unmeasured";
export interface Cell { label: string; tone: CellTone }
type Point = { pos: number | null; ok: boolean };

function cell(p: Point | undefined): Cell {
  if (!p || p.ok !== true) return { label: "not checked", tone: "unmeasured" };
  if (p.pos === null || !Number.isFinite(p.pos) || p.pos > 20) return { label: "not in the top 20", tone: "none" };
  if (p.pos <= 3) return { label: "1-3", tone: "good" };
  return p.pos <= 10 ? { label: "4-10", tone: "mid" } : { label: "11-20", tone: "low" };
}

/** The nine cells of one rank check, row by row from the north-west: the band the business showed in, "not in the top 20" for a point that was checked and did not show it, and "not checked" for a point that was not measured. A short list is filled with "not checked", a long one is cut at nine. */
export function gridCells(points: Point[]): Cell[] {
  return Array.from({ length: GRID_POINTS }, (_, i) => cell(points[i]));
}

const pts = (n: number) => `${n} ${n === 1 ? "point" : "points"}`;

/** How many of the nine points had the business in the top 3 compared with the check before: "first check", "+2 points of 9", "-2 points of 9", "no change", or "not comparable" when this check could not be measured. */
export function movement(visible: number | null, previous: number | null): string {
  if (visible === null) return "not comparable";
  if (previous === null) return "first check";
  const d = visible - previous;
  if (d === 0) return "no change";
  return `${d > 0 ? "+" : "-"}${pts(Math.abs(d))} of ${GRID_POINTS}`;
}

/** The movement line of one term: a first check is said so, and an earlier check that was too thin to measure is "not comparable" rather than a first check. */
export function termMovement(row: Pick<GridRow, "visible" | "previous">): string {
  if (row.previous !== null && row.previous.visible === null && row.visible !== null) return "not comparable";
  return movement(row.visible, row.previous?.visible ?? null);
}

/** How many more search terms can be switched on (ten at most are on at once). Switched-off ones do not count. */
export function keywordLimitLeft(keywords: Pick<SeoKeyword, "active">[]): number {
  return Math.max(0, MAX_ACTIVE_KEYWORDS - keywords.filter((k) => k.active).length);
}

/** `drain cleaning in Tigard`, or just the term. Entered text: the pages show it as text only. */
export const termName = (k: { term: string; town: string | null }): string => (k.town && k.town.trim() ? `${k.term} in ${k.town}` : k.term);

const REPLY: Record<ReplyStatus, string> = { new: "No reply yet", drafting: "Claude is writing a reply", drafted: "Reply ready for you", posted: "You posted it", skipped: "Skipped" };
/** A review's reply state in words. The colour only helps: the chip always says it. */
export const replyStatusLabel = (s: ReplyStatus): string => REPLY[s] ?? "Unknown";
/** The chip's tone: a reply that waits on Logan is amber, a posted one is green. */
export const replyStatusTone = (s: ReplyStatus): "" | "positive" | "warning" => (s === "drafted" ? "warning" : s === "posted" ? "positive" : "");

/** The reviews that need Logan first (a drafted reply, then a low rating with no reply posted, then the rest that are open), then the ones that are settled; newest first inside each group (the list comes newest first, and the sort keeps that order). */
export function sortReviews<T extends Pick<SeoReview, "replyStatus" | "flagged">>(reviews: T[]): T[] {
  const rank = (r: T) => (r.replyStatus === "drafted" ? 0 : r.flagged && r.replyStatus !== "posted" && r.replyStatus !== "skipped" ? 1 : r.replyStatus === "posted" || r.replyStatus === "skipped" ? 3 : 2);
  return reviews.map((r, i) => ({ r, i })).sort((a, b) => rank(a.r) - rank(b.r) || a.i - b.i).map((x) => x.r);
}

const CONTENT: Record<ContentStatus, string> = {
  planned: "Planned", drafting: "Claude is writing it", drafted: "Ready for you to look at", approved: "Approved, not on the site yet", published: "You put it live", rejected: "Rejected",
};
export const contentStatusLabel = (s: ContentStatus): string => CONTENT[s] ?? "Unknown";
export const contentStatusTone = (s: ContentStatus): "" | "positive" | "warning" | "critical" => (s === "drafted" ? "warning" : s === "published" ? "positive" : s === "rejected" ? "critical" : "");
const KIND: Record<ContentKind, string> = { page: "Page", post: "Blog post", gbp_post: "Google post" };
export const kindLabel = (k: ContentKind): string => KIND[k] ?? "Page";

/** The text to copy for a piece of content: a Google post is its body alone; a page or post is its title and then its body. */
export function contentCopy(c: Pick<ContentItem, "kind" | "title" | "body">): string {
  return c.kind === "gbp_post" ? c.body : `${c.title}\n\n${c.body}`;
}

/** Content grouped by month, newest month first, each group in the order it came. */
export function contentByMonth<T extends Pick<ContentItem, "period">>(items: T[]): { period: string; label: string; items: T[] }[] {
  const periods = [...new Set(items.map((i) => i.period))].sort().reverse();
  return periods.map((period) => ({ period, label: periodLabel("monthly", period), items: items.filter((i) => i.period === period) }));
}

/** The limits the server holds the words to (the text rules are checked there and its sentence is shown). */
export const CONTENT_LIMITS = { title: 120, metaTitle: 60, metaDescription: 160, body: 12000, gbpBody: 1500 } as const;

const CITATION: Record<CitationStatus, string> = { todo: "To do", listed: "Listed", needs_fix: "Needs fixing", not_applicable: "Not applicable" };
export const citationLabel = (s: CitationStatus): string => CITATION[s] ?? "Unknown";
/** The four statuses a directory can be set to, in the order the buttons show them. */
export const CITATION_STATUSES: CitationStatus[] = ["todo", "listed", "needs_fix", "not_applicable"];

const NAP: Record<NapPart, string> = { match: "matches the listing", mismatch: "differs from the listing", missing: "not found on the site" };
/** One part of the name, address and phone check as a line: "Phone: matches the listing". */
export const napPartLine = (label: string, part: NapPart): string => `${label}: ${NAP[part] ?? "not checked"}`;
export const napTone = (part: NapPart): "positive" | "warning" | "critical" => (part === "match" ? "positive" : part === "mismatch" ? "critical" : "warning");

/** The whole name, address and phone result as three lines and how many pages were read. */
export function napLines(nap: NapResult): { label: string; line: string; tone: "positive" | "warning" | "critical" }[] {
  return [["Name", nap.name], ["Address", nap.address], ["Phone", nap.phone]].map(([label, part]) => ({ label, line: napPartLine(label, part as NapPart), tone: napTone(part as NapPart) }));
}

/** A rating in words, for a reader who cannot see stars. */
export const starsLabel = (rating: number): string => `${rating} of 5 stars`;

/** A sentence for the Google listing's numbers; an unknown number is left out, never shown as zero. */
export function snapshotFacts(s: GbpSnapshot): { label: string; value: string }[] {
  const out: { label: string; value: string }[] = [];
  if (s.rating !== null) out.push({ label: "Rating", value: `${s.rating} out of 5` });
  if (s.reviewCount !== null) out.push({ label: "Reviews", value: String(s.reviewCount) });
  if (s.category) out.push({ label: "Category", value: s.category });
  if (s.photoCount !== null) out.push({ label: "Photos", value: String(s.photoCount) });
  if (s.hasHours !== null) out.push({ label: "Opening hours", value: s.hasHours ? "Set" : "Not set" });
  return out;
}

/** The profile's status in words. */
export const profileStatusLabel = (s: SeoProfile["status"]): string => (s === "active" ? "Watching" : s === "paused" ? "Paused" : "Set up, not watching yet");

/** The month's report as the board says it: `November 2026: ready to send`. A report that has not been started says so. */
export function boardReportLine(report: { period: string; status: SeoReportRow["status"] } | null, period: string): string {
  if (!report) return `${periodLabel("monthly", period)}: not started`;
  const words: Record<SeoReportRow["status"], string> = { collecting: "collecting numbers", ready: "ready to send", sent: "sent", revoked: "taken back", cancelled: "cancelled" };
  return `${periodLabel("monthly", report.period)}: ${words[report.status] ?? "unknown"}`;
}
/** A report's status chip text (the same words as the Care reports). */
export const reportChip = (s: SeoReportRow["status"]): string => statusChip(s);

export interface Words { summary: string; recommendation: string; priorities: string[] }
export interface WordsForm extends Words {
  /** True when what the report holds is only the summary the code wrote: a recommendation and three priorities have to be added before it can be saved. */
  needsMore: boolean;
  /** One sentence for the owner when `needsMore`, else empty. */
  note: string;
}

const PLAIN_NOTE = "This summary was written by the app from the numbers. A recommendation and exactly three priorities are needed before it can be saved, and then the words are yours.";

/** The words boxes for a `ready` report. A plain (code-written) report has a summary and nothing else, so the summary is pre-filled and the form says what is still needed. There are always three priority boxes. */
export function reportWordsForm(r: Pick<SeoReportRow, "summary" | "recommendation" | "priorities" | "source">): WordsForm {
  const priorities = [0, 1, 2].map((i) => r.priorities[i] ?? "");
  const needsMore = r.source === "plain" || r.source === "none" ? r.recommendation.trim() === "" || priorities.some((p) => p.trim() === "") : false;
  return { summary: r.summary, recommendation: r.recommendation, priorities, needsMore, note: needsMore ? PLAIN_NOTE : "" };
}

/** True when the words could be saved: a summary, a recommendation and three priorities, each with something in it. The server still checks the rules. */
export function wordsReady(w: Words): boolean {
  return w.summary.trim() !== "" && w.recommendation.trim() !== "" && w.priorities.length === 3 && w.priorities.every((p) => p.trim() !== "");
}

export type { Citation, ContentItem, GbpSnapshot, SeoKeyword, SeoProfile, SeoReview };
