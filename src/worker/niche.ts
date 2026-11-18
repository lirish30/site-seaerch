import { listCampaigns, type Campaign } from "./db/campaigns";

// Niche test tuning. Logan can retune these two numbers; everything else derives from them.
/** Distinct audited businesses, across all the trades being compared, before the page will say which trade leads. */
export const MIN_TOTAL_AUDITS = 50;
/** Competition: a trade whose businesses average this many Google reviews is twice as crowded as one with none, so its opportunity halves. */
export const REVIEWS_PER_COMPETITION_UNIT = 100;

export interface NicheRow {
  campaignId: string; name: string; niche: string;
  /** Businesses reached through this trade's searches that have at least one audit. */
  audited: number;
  /** Mean Site Health (0-100, higher is a better site) of those businesses' latest audits; null when none has one. */
  avgScore: number | null;
  /** Mean Google review count of those businesses (a missing count is 0): the competition signal. */
  avgReviews: number | null;
  jobValueUsd: number | null;
  /** (100 - avgScore) * jobValueUsd / (1 + avgReviews / 100): a bigger number is a bigger prize against less competition. */
  opportunity: number | null;
}
export interface NicheVerdict { ready: boolean; audited: number; needed: number; leaderId: string | null }

/** Room to improve (a worse site), times what a job is worth, shrunk by how crowded the trade already is. Whole dollars. */
export function opportunity(avgScore: number, avgReviews: number, jobValueUsd: number): number {
  return Math.round(((100 - avgScore) * jobValueUsd) / (1 + avgReviews / REVIEWS_PER_COMPETITION_UNIT));
}

/** One audited business reached through one campaign, with its latest audit's Site Health. */
export interface NicheFact { campaignId: string; businessId: string; reviewCount: number | null; healthScore: number | null }

const mean = (xs: number[]): number | null => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : null);

/** Pure: one row per non-archived campaign, plus how many distinct businesses are audited across all of them. */
export function summarizeNiche(campaigns: Campaign[], facts: NicheFact[]): { rows: NicheRow[]; distinctAudited: number } {
  const live = campaigns.filter((c) => c.status !== "archived");
  const byCampaign = new Map<string, NicheFact[]>();
  for (const f of facts) byCampaign.set(f.campaignId, [...(byCampaign.get(f.campaignId) ?? []), f]);
  const distinct = new Set<string>();
  const rows = live.map((c): NicheRow => {
    const fs = byCampaign.get(c.id) ?? [];
    for (const f of fs) distinct.add(f.businessId);
    const avgScore = mean(fs.flatMap((f) => (f.healthScore === null ? [] : [f.healthScore])));
    const avgReviews = mean(fs.map((f) => f.reviewCount ?? 0));
    const jobValueUsd = c.est_job_value_usd;
    return {
      campaignId: c.id, name: c.name, niche: c.niche, audited: fs.length, avgScore, avgReviews, jobValueUsd,
      opportunity: fs.length >= 1 && avgScore !== null && avgReviews !== null && jobValueUsd !== null ? opportunity(avgScore, avgReviews, jobValueUsd) : null,
    };
  });
  return { rows, distinctAudited: distinct.size };
}

/**
 * Pure. `distinctAudited` is the total to judge readiness on; pass it when a business can sit in two trades (summing the
 * rows would count it twice). The leader is the biggest opportunity; ties go to more audits, then name.
 */
export function nicheVerdict(rows: NicheRow[], distinctAudited?: number): NicheVerdict {
  const audited = distinctAudited ?? rows.reduce((n, r) => n + r.audited, 0);
  const leader = rows.filter((r) => r.opportunity !== null)
    .sort((a, b) => b.opportunity! - a.opportunity! || b.audited - a.audited || a.name.localeCompare(b.name))[0];
  return { ready: audited >= MIN_TOTAL_AUDITS, audited, needed: MIN_TOTAL_AUDITS, leaderId: leader?.campaignId ?? null };
}

/**
 * Every campaign's audited businesses in one statement: a business reached by several of a campaign's searches is one
 * fact (GROUP BY), and its latest audit is the newest `created_at`, as in db/audits.ts latestAudit (id breaks a tie).
 * `health_score` is the Site Health column; `audits.score` is the opportunity score and runs the other way.
 */
async function loadFacts(db: D1Database): Promise<{ campaigns: Campaign[]; facts: NicheFact[] }> {
  const [campaigns, factRows] = await Promise.all([
    listCampaigns(db),
    db.prepare(
      `SELECT s.campaign_id AS campaignId, b.id AS businessId, b.review_count AS reviewCount, a.health_score AS healthScore
       FROM searches s
       JOIN campaigns c ON c.id = s.campaign_id AND c.status != 'archived'
       JOIN search_results sr ON sr.search_id = s.id
       JOIN businesses b ON b.id = sr.business_id
       JOIN audits a ON a.id = (SELECT id FROM audits WHERE business_id = b.id ORDER BY created_at DESC, id DESC LIMIT 1)
       GROUP BY s.campaign_id, b.id`,
    ).all<NicheFact>(),
  ]);
  return { campaigns, facts: factRows.results };
}

export async function nicheStats(db: D1Database): Promise<NicheRow[]> {
  const { campaigns, facts } = await loadFacts(db);
  return summarizeNiche(campaigns, facts).rows;
}

/** What GET /api/niche returns, plus the distinct total the verdict was judged on. */
export async function nicheReport(db: D1Database): Promise<{ rows: NicheRow[]; distinctAudited: number; verdict: NicheVerdict }> {
  const { campaigns, facts } = await loadFacts(db);
  const { rows, distinctAudited } = summarizeNiche(campaigns, facts);
  return { rows, distinctAudited, verdict: nicheVerdict(rows, distinctAudited) };
}
