import type { PageSpeedFacts } from "./scoring/scorer";
import type { Fetcher } from "./crawler/crawl";

export class RateLimitedError extends Error {}

const ENDPOINT = "https://www.googleapis.com/pagespeedonline/v5/runPagespeed";

export async function runPageSpeed(url: string, o: { apiKey: string; fetch: Fetcher }) {
  const q = `${ENDPOINT}?url=${encodeURIComponent(url)}&strategy=mobile&category=performance&key=${o.apiKey}`;
  const res = await o.fetch(q);
  if (res.status === 429) throw new RateLimitedError("PageSpeed rate limited");
  if (!res.ok) throw new Error(`PageSpeed HTTP ${res.status}: ${(await res.text()).slice(0, 200)}`);
  const raw = (await res.json()) as any;
  const lh = raw.lighthouseResult;
  const a = lh.audits ?? {};
  const passes = (k: string) => a[k] === undefined || a[k].score === null || a[k].score >= 0.9;
  const facts: PageSpeedFacts = {
    performanceScore: Math.round((lh.categories.performance.score ?? 0) * 100),
    lcpMs: Math.round(a["largest-contentful-paint"]?.numericValue ?? 0),
    cls: Math.round((a["cumulative-layout-shift"]?.numericValue ?? 0) * 100) / 100,
    mobileFriendly: passes("viewport") && passes("font-size") && passes("tap-targets"),
  };
  return { facts, raw };
}
