import { google } from "./api";
import type { Fetch } from "./oauth";
import type { Range } from "./searchConsole";

export type { Range };

// Google Business Profile Performance (Plan 16, Task 11): how often people tapped to call, asked for directions and clicked through to the website from a business's Google listing. Read only, and gated: nothing
// calls this unless a site has a `gbp_location` and the owner granted the Business Profile permission. Google must also have approved the account's Business Profile API access, so a 403 is expected until it has.

const BASE = "https://businessprofileperformance.googleapis.com/v1";
const CALLS = "CALL_CLICKS";
const DIRECTIONS = "BUSINESS_DIRECTION_REQUESTS";
const WEBSITE = "WEBSITE_CLICKS";

interface Answer {
  multiDailyMetricTimeSeries?: { dailyMetricTimeSeries?: { dailyMetric?: string; timeSeries?: { datedValues?: { value?: string }[] } }[] }[];
}

export interface GbpMonth { calls: number; directions: number; websiteClicks: number; previousCalls: number | null }

const day = (iso: string, which: "start" | "end"): [string, string][] => {
  const [year, month, d] = iso.split("-").map(Number);
  return [[`dailyRange.${which}_date.year`, String(year)], [`dailyRange.${which}_date.month`, String(month)], [`dailyRange.${which}_date.day`, String(d)]];
};

/** The daily counts of `metrics` over `r`, summed per metric. A metric Google sent no series for is absent from the map; a day without a value is not counted. */
async function totals(f: Fetch, token: string, location: string, metrics: string[], r: Range): Promise<Map<string, number>> {
  const q = new URLSearchParams();
  for (const m of metrics) q.append("dailyMetrics", m);
  for (const [k, v] of [...day(r.start, "start"), ...day(r.end, "end")]) q.append(k, v);
  const answer = await google<Answer>(f, token, `${BASE}/${location}:fetchMultiDailyMetricsTimeSeries?${q}`);
  const out = new Map<string, number>();
  for (const group of answer.multiDailyMetricTimeSeries ?? []) {
    for (const series of group.dailyMetricTimeSeries ?? []) {
      if (!series.dailyMetric) continue;
      const sum = (series.timeSeries?.datedValues ?? []).reduce((a, v) => a + (v.value === undefined ? 0 : Number(v.value) || 0), 0);
      out.set(series.dailyMetric, (out.get(series.dailyMetric) ?? 0) + sum);
    }
  }
  return out;
}

/**
 * One month of a Business Profile location (`locations/<id>`): calls, direction requests and website clicks, each the sum of Google's daily values, and the calls of the month before for the comparison
 * (null when Google sent no call figures for it). A month with no daily values is a real zero.
 */
export async function gbpMonth(f: Fetch, token: string, location: string, cur: Range, prev: Range): Promise<GbpMonth> {
  const now = await totals(f, token, location, [CALLS, DIRECTIONS, WEBSITE], cur);
  const before = await totals(f, token, location, [CALLS], prev);
  return { calls: now.get(CALLS) ?? 0, directions: now.get(DIRECTIONS) ?? 0, websiteClicks: now.get(WEBSITE) ?? 0, previousCalls: before.get(CALLS) ?? null };
}
