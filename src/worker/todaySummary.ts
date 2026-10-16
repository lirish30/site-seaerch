import { listAllBusinesses } from "./db/businesses";
import { latestDraftsByBusiness } from "./db/drafts";
import { suppressedLeadIds } from "./db/suppression";
import { PER_LEAD_COST } from "./cost";
import { DRAFT_UNSENT_DAYS } from "./today";
import type { ActivityKind, LeadStatus } from "./types";

/** A lead scores Hot at this lead score (the client's `HOT_AT` in scoreView.ts; a test keeps the two equal). */
export const HOT_SCORE = 60;
export const WEEK_DAYS = 7, RECENT_LIMIT = 8;
const DAY = 86_400_000;

export interface RecentActivity { id: string; businessId: string; businessName: string; kind: ActivityKind; detail: string | null; at: string }

/** GET /api/today/summary: every number on the Home page that the lead list alone cannot give (it needs activity dates or the draft age). */
export interface TodaySummary {
  /** Hot = open lead (new to replied), not on the suppression list, latest lead score 60+. */
  hot: { total: number; newThisWeek: number };
  /** The Outreach "drafts ready" queue; `waiting` are the ones whose latest draft is older than 2 days. */
  drafts: { ready: number; waiting: number };
  replied: { total: number; thisWeek: number };
  /** Leads that are Won now and moved to Won this calendar month (UTC), with their deal values; `openValue` is every open lead's deal value. */
  won: { thisMonth: number; valueThisMonth: number; openValue: number };
  pipeline: Record<LeadStatus, number>;
  totalLeads: number;
  fullScanCostUsd: number;
  recent: RecentActivity[];
}

const OPEN = new Set<LeadStatus>(["new", "reviewed", "contacted", "replied"]);

/** The status a `status` or bulk-status activity row moved the lead to ("contacted → won", "status → won (bulk)"), else null. */
export function movedTo(detail: string | null): LeadStatus | null {
  const m = detail && /→\s*(new|reviewed|contacted|replied|won|lost|skip)\b/.exec(detail);
  return m ? (m[1] as LeadStatus) : null;
}

/** Everything the Home KPI cards, Pipeline card and Activity list show, in a handful of bulk queries. */
export async function buildSummary(db: D1Database, now: Date): Promise<TodaySummary> {
  const t = now.getTime();
  const weekAgo = new Date(t - WEEK_DAYS * DAY).toISOString();
  const monthStart = `${now.toISOString().slice(0, 7)}-01T00:00:00.000Z`;
  const since = monthStart < weekAgo ? monthStart : weekAgo;

  const [leads, drafts, scoreRows, moves, recent] = await Promise.all([
    listAllBusinesses(db, {}), latestDraftsByBusiness(db),
    db.prepare(`SELECT business_id, score FROM (SELECT business_id, score, ROW_NUMBER() OVER (PARTITION BY business_id ORDER BY created_at DESC) AS rn FROM audits) WHERE rn = 1`)
      .all<{ business_id: string; score: number }>(),
    db.prepare(`SELECT business_id, detail, created_at FROM activity WHERE kind IN ('status','bulk') AND created_at >= ?`).bind(since)
      .all<{ business_id: string; detail: string | null; created_at: string }>(),
    db.prepare(
      `SELECT a.id, a.business_id, b.name, a.kind, a.detail, a.created_at FROM activity a JOIN businesses b ON b.id = a.business_id
       WHERE a.kind NOT IN ('today_done','snoozed') AND b.archived_at IS NULL ORDER BY a.created_at DESC, a.id DESC LIMIT ?`,
    ).bind(RECENT_LIMIT).all<{ id: string; business_id: string; name: string; kind: ActivityKind; detail: string | null; created_at: string }>(),
  ]);
  const suppressed = await suppressedLeadIds(db, leads);
  const score = new Map(scoreRows.results.map((r) => [r.business_id, r.score]));
  // The latest time each lead moved to each status inside the window.
  const movedAt = new Map<string, string>();
  for (const m of moves.results) {
    const to = movedTo(m.detail);
    if (to && m.created_at > (movedAt.get(`${m.business_id}|${to}`) ?? "")) movedAt.set(`${m.business_id}|${to}`, m.created_at);
  }

  const out: TodaySummary = {
    hot: { total: 0, newThisWeek: 0 }, drafts: { ready: 0, waiting: 0 }, replied: { total: 0, thisWeek: 0 },
    won: { thisMonth: 0, valueThisMonth: 0, openValue: 0 },
    pipeline: { new: 0, reviewed: 0, contacted: 0, replied: 0, won: 0, lost: 0, skip: 0 }, totalLeads: leads.length,
    fullScanCostUsd: PER_LEAD_COST,
    recent: recent.results.map((r) => ({ id: r.id, businessId: r.business_id, businessName: r.name, kind: r.kind, detail: r.detail, at: r.created_at })),
  };
  const staleDraft = new Date(t - DRAFT_UNSENT_DAYS * DAY).toISOString();
  for (const b of leads) {
    out.pipeline[b.lead_status]++;
    const open = OPEN.has(b.lead_status), draft = drafts.get(b.id);
    if (open) out.won.openValue += b.deal_value ?? 0;
    if (open && !suppressed.has(b.id) && (score.get(b.id) ?? -1) >= HOT_SCORE) {
      out.hot.total++;
      if (b.created_at >= weekAgo) out.hot.newThisWeek++;
    }
    if (draft && (b.lead_status === "new" || b.lead_status === "reviewed") && !suppressed.has(b.id)) {
      out.drafts.ready++;
      if (draft.created_at <= staleDraft) out.drafts.waiting++;
    }
    if (b.lead_status === "replied") {
      out.replied.total++;
      if ((movedAt.get(`${b.id}|replied`) ?? "") >= weekAgo) out.replied.thisWeek++;
    }
    if (b.lead_status === "won" && (movedAt.get(`${b.id}|won`) ?? "") >= monthStart) {
      out.won.thisMonth++;
      out.won.valueThisMonth += b.deal_value ?? 0;
    }
  }
  return out;
}
