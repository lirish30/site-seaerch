import { google } from "./api";
import type { Fetch } from "./oauth";
import type { Range } from "./searchConsole";

export type { Range };

const ADMIN = "https://analyticsadmin.googleapis.com/v1beta";
const DATA = "https://analyticsdata.googleapis.com/v1beta";
/** Pages of account summaries read before giving up (200 accounts a page: far more than one agency sees). */
const SUMMARY_PAGES = 5;

/** Every GA4 property the connected account can see, as its numeric id and its name. */
export async function listGa4Properties(f: Fetch, token: string): Promise<{ id: string; name: string }[]> {
  const out: { id: string; name: string }[] = [];
  let pageToken: string | undefined;
  for (let page = 0; page < SUMMARY_PAGES; page++) {
    const q = new URLSearchParams({ pageSize: "200", ...(pageToken && { pageToken }) });
    const r = await google<{ accountSummaries?: { propertySummaries?: { property: string; displayName?: string }[] }[]; nextPageToken?: string }>(f, token, `${ADMIN}/accountSummaries?${q}`);
    for (const a of r.accountSummaries ?? []) for (const p of a.propertySummaries ?? []) out.push({ id: p.property.replace(/^properties\//, ""), name: p.displayName ?? p.property });
    pageToken = r.nextPageToken;
    if (!pageToken) break;
  }
  return out;
}

/** The lower-case hosts of a property's web streams (what the property measures), for matching it to a site. */
export async function ga4Hosts(f: Fetch, token: string, id: string): Promise<string[]> {
  const r = await google<{ dataStreams?: { type?: string; webStreamData?: { defaultUri?: string } }[] }>(f, token, `${ADMIN}/properties/${id}/dataStreams`);
  const hosts: string[] = [];
  for (const s of r.dataStreams ?? []) {
    if (s.type !== "WEB_DATA_STREAM" || !s.webStreamData?.defaultUri) continue;
    try { hosts.push(new URL(s.webStreamData.defaultUri).hostname.toLowerCase()); } catch { /* not a URL: no host to match */ }
  }
  return hosts;
}

interface Report {
  dimensionHeaders?: { name: string }[]; metricHeaders?: { name: string }[];
  rows?: { dimensionValues?: { value: string }[]; metricValues?: { value: string }[] }[];
}

const ORGANIC = "Organic Search";

/** One runReport on `properties/<id>` over both ranges; Google adds a trailing dateRange dimension ("date_range_0" is `cur`, "date_range_1" is `prev`). */
const report = (f: Fetch, token: string, id: string, cur: Range, prev: Range, body: object) =>
  google<Report>(f, token, `${DATA}/properties/${id}:runReport`, {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ dateRanges: [{ startDate: cur.start, endDate: cur.end }, { startDate: prev.start, endDate: prev.end }], ...body }),
  });

export interface Ga4Month {
  sessions: number; users: number; keyEvents: number | null; organic: number;
  channels: { channel: string; sessions: number }[];
  /** The month before; null when Google returned no row for that range (a property that was not measuring then, never a measured zero). */
  previous: { sessions: number | null; organic: number | null };
}

/** One month of a GA4 property next to the month before. `keyEvents` is null when Google's answer carries no such metric (never 0). A property with no rows is a real zero this month; no row for the month before is `null`, not 0. */
export async function ga4Month(f: Fetch, token: string, id: string, cur: Range, prev: Range): Promise<Ga4Month> {
  const totals = await report(f, token, id, cur, prev, { metrics: [{ name: "sessions" }, { name: "totalUsers" }, { name: "keyEvents" }] });
  const byChannel = await report(f, token, id, cur, prev, {
    dimensions: [{ name: "sessionDefaultChannelGroup" }], metrics: [{ name: "sessions" }],
    orderBys: [{ metric: { metricName: "sessions" }, desc: true }], limit: 100,
  });

  const col = (name: string) => totals.metricHeaders?.findIndex((h) => h.name === name) ?? -1;
  const at = (range: 0 | 1, name: string): number | null => {
    const i = col(name);
    if (i < 0) return null;
    const row = totals.rows?.find((r) => r.dimensionValues?.at(-1)?.value === `date_range_${range}`);
    return row ? Number(row.metricValues?.[i]?.value ?? 0) : 0;
  };

  const channels = (range: 0 | 1) => (byChannel.rows ?? [])
    .filter((r) => r.dimensionValues?.at(-1)?.value === `date_range_${range}`)
    .map((r) => ({ channel: r.dimensionValues?.[0]?.value ?? "", sessions: Number(r.metricValues?.[0]?.value ?? 0) }))
    .sort((a, b) => b.sessions - a.sessions);
  const organic = (range: 0 | 1) => channels(range).find((c) => c.channel === ORGANIC)?.sessions ?? 0;
  const hadPrevious = !!totals.rows?.some((r) => r.dimensionValues?.at(-1)?.value === "date_range_1");

  return {
    sessions: at(0, "sessions") ?? 0, users: at(0, "totalUsers") ?? 0, keyEvents: at(0, "keyEvents"), organic: organic(0),
    channels: channels(0),
    previous: hadPrevious ? { sessions: at(1, "sessions") ?? 0, organic: organic(1) } : { sessions: null, organic: null },
  };
}
