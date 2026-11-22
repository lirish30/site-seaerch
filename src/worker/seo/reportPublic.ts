import { dayKey } from "../booking/slots";
import { getSeoReportByToken, recordSeoView } from "../db/seoReports";
import { getSettings } from "../db/settings";
import { isClientToken } from "../documents/token";
import type { Env } from "../env";
import { zoneOf } from "../sop/cadence";
import { SeoReportFacts } from "./reportFacts";

// What a client sees at `/l/<token>` (Plan 14): the monthly Local SEO report, field by field. Nothing is spread from the stored facts and nothing is added to them here, so a field that is not listed in
// `PublicSeoReport` can never reach a client: no id, no approval or task id, no raw facts, no Google place id or map location, no review text or reviewer name, no alias or vault name, no token.

export interface PublicSeoTerm {
  term: string;
  town: string | null;
  /** The nine grid points, row by row from the north-west: `pos` null with `ok` true is "not in the top 20", `ok` false is "not checked". */
  points: { pos: number | null; ok: boolean }[];
  measured: number;
  visible: number | null;
  previousVisible: number | null;
}

export interface PublicSeoReport {
  clientName: string;
  /** `November 2026`. */
  label: string;
  summary: string;
  recommendation: string;
  /** What to work on next month: up to three, none for a summary the code wrote. */
  priorities: string[];
  /** The date of the check the ranks are from (`YYYY-MM-DD`, the booking zone's), or null when there was none. */
  rankAsOf: string | null;
  previousRankAsOf: string | null;
  terms: PublicSeoTerm[];
  gbp: { rating: number | null; reviewCount: number | null; reviewsGained: number | null; ratingChange: number | null };
  /** Counts only: the reviews first seen in the month and how many have a reply posted. */
  reviews: { seen: number; posted: number };
  content: { published: { kind: "page" | "post" | "gbp_post"; title: string }[] };
  citations: { listed: number; needsFix: number; todo: number } | null;
  /** The day the report was sent, `YYYY-MM-DD` in the booking zone. */
  sentOn: string;
}

/**
 * The report behind a link, or null. Null is one answer for a malformed token (never looked up), an unknown one, and every report that is not `sent` (collecting, ready, revoked, cancelled), so the caller
 * cannot tell them apart. A view is counted only on a `sent` report, and only when the page can be shown, and not when `o.countView` is false (the owner opening the link themselves).
 */
export async function publicSeoReport(env: Pick<Env, "DB">, token: string, now: Date, o: { countView?: boolean } = {}): Promise<PublicSeoReport | null> {
  if (!isClientToken(token)) return null;
  const report = await getSeoReportByToken(env.DB, token);
  if (!report || report.status !== "sent") return null;
  const parsed = SeoReportFacts.safeParse(report.facts);
  if (!parsed.success) return null;
  const f = parsed.data;

  const tz = zoneOf(await getSettings(env.DB));
  if (o.countView !== false) await recordSeoView(env.DB, report.id, now.toISOString());

  return {
    clientName: f.clientName,
    label: f.label,
    summary: report.summary,
    recommendation: report.recommendation,
    priorities: report.priorities.slice(0, 3),
    rankAsOf: f.rankAsOf,
    previousRankAsOf: f.previousRankAsOf,
    terms: f.terms.map((t) => ({
      term: t.term, town: t.town, points: t.points.map((p) => ({ pos: p.pos, ok: p.ok })), measured: t.measured, visible: t.visible, previousVisible: t.previousVisible,
    })),
    gbp: { rating: f.gbp.rating, reviewCount: f.gbp.reviewCount, reviewsGained: f.gbp.reviewsGained, ratingChange: f.gbp.ratingChange },
    reviews: { seen: f.reviews.seen, posted: f.reviews.posted },
    content: { published: f.content.published.map((c) => ({ kind: c.kind, title: c.title })) },
    citations: f.citations ? { listed: f.citations.listed, needsFix: f.citations.needsFix, todo: f.citations.todo } : null,
    sentOn: dayKey(Date.parse(report.sentAt ?? "") || now.getTime(), tz),
  };
}
