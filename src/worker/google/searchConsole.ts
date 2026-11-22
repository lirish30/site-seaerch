import { google } from "./api";
import type { Fetch } from "./oauth";

/** An inclusive run of days, `YYYY-MM-DD` both ends. */
export interface Range { start: string; end: string }

const BASE = "https://www.googleapis.com/webmasters/v3";

/** The Search Console sites the connected account can see. Sites it only knows as an unverified user are left out: they return no data. */
export async function listGscSites(f: Fetch, token: string): Promise<{ siteUrl: string; level: string }[]> {
  const r = await google<{ siteEntry?: { siteUrl: string; permissionLevel: string }[] }>(f, token, `${BASE}/sites`);
  return (r.siteEntry ?? []).filter((s) => s.permissionLevel !== "siteUnverifiedUser").map((s) => ({ siteUrl: s.siteUrl, level: s.permissionLevel }));
}

interface Row { keys?: string[]; clicks: number; impressions: number; position?: number }

const query = async (f: Fetch, token: string, siteUrl: string, r: Range, dimension?: "query" | "page"): Promise<Row[]> =>
  (await google<{ rows?: Row[] }>(f, token, `${BASE}/sites/${encodeURIComponent(siteUrl)}/searchAnalytics/query`, {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ startDate: r.start, endDate: r.end, ...(dimension && { dimensions: [dimension] }), rowLimit: 10 }),
  })).rows ?? [];

export interface GscMonth {
  clicks: number; impressions: number; position: number | null;
  queries: { query: string; clicks: number; impressions: number }[];
  pages: { page: string; clicks: number }[];
}

/** One month for one site: the totals, the top ten queries and the top ten pages. No rows means Google counted nothing: a real zero, with no position. */
export async function gscMonth(f: Fetch, token: string, siteUrl: string, r: Range): Promise<GscMonth> {
  const [total] = await query(f, token, siteUrl, r);
  const queries = await query(f, token, siteUrl, r, "query");
  const pages = await query(f, token, siteUrl, r, "page");
  return {
    clicks: total?.clicks ?? 0, impressions: total?.impressions ?? 0,
    position: total?.position == null ? null : Math.round(total.position * 10) / 10,
    queries: queries.map((q) => ({ query: q.keys?.[0] ?? "", clicks: q.clicks, impressions: q.impressions })),
    pages: pages.map((p) => ({ page: p.keys?.[0] ?? "", clicks: p.clicks })),
  };
}

/** Clicks and impressions only, in the one aggregate call: what the month before needs for the comparison. */
export async function gscTotals(f: Fetch, token: string, siteUrl: string, r: Range): Promise<{ clicks: number; impressions: number }> {
  const [total] = await query(f, token, siteUrl, r);
  return { clicks: total?.clicks ?? 0, impressions: total?.impressions ?? 0 };
}
