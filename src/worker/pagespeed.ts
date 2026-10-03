import type { PageSpeedFacts } from "./scoring/scorer";
import type { Fetcher } from "./crawler/crawl";

export class RateLimitedError extends Error {}

const ENDPOINT = "https://www.googleapis.com/pagespeedonline/v5/runPagespeed";

// Failing audit ids attributed to a category: only audits that count toward it (weight > 0), most important
// first (stable, so ties keep Lighthouse's order). No auditRefs -> no issues. Wording lives in the scorer.
function failingIssueIds(lh: any, category: string): string[] {
  const refs = lh.categories?.[category]?.auditRefs;
  const failing = (Array.isArray(refs) ? refs : []).filter((r) => {
    const sc = r && typeof r.id === "string" ? lh.audits?.[r.id]?.score : null;
    return r?.weight > 0 && typeof sc === "number" && sc < 0.9;
  });
  failing.sort((x, y) => y.weight - x.weight);
  return [...new Set<string>(failing.map((r) => r.id))];
}
const categoryScore = (lh: any, category: string) => {
  const s = lh.categories?.[category]?.score;
  return typeof s === "number" ? Math.round(s * 100) : null;
};

export async function runPageSpeed(url: string, o: { apiKey: string; fetch: Fetcher }) {
  const q = `${ENDPOINT}?url=${encodeURIComponent(url)}&strategy=mobile&category=performance&category=seo&category=accessibility&key=${o.apiKey}`;
  const res = await o.fetch(q);
  if (res.status === 429) throw new RateLimitedError("PageSpeed rate limited");
  if (!res.ok) throw new Error(`PageSpeed HTTP ${res.status}: ${(await res.text()).slice(0, 200)}`);
  const raw = (await res.json()) as any;
  const lh = raw?.lighthouseResult;
  // A failed Lighthouse run must never read as a real 0/100 score; surface it as a (non-rate-limit) failure.
  if (!lh) throw new Error("PageSpeed returned no Lighthouse result");
  if (lh.runtimeError) throw new Error(`Lighthouse runtime error: ${lh.runtimeError.code ?? ""} ${lh.runtimeError.message ?? ""}`.trim());
  const perf = lh.categories?.performance?.score;
  if (typeof perf !== "number") throw new Error("Lighthouse returned no performance score");
  const a = lh.audits ?? {};
  const passes = (k: string) => a[k] === undefined || a[k].score === null || a[k].score >= 0.9;
  const facts: PageSpeedFacts = {
    performanceScore: Math.round(perf * 100),
    lcpMs: Math.round(a["largest-contentful-paint"]?.numericValue ?? 0),
    cls: Math.round((a["cumulative-layout-shift"]?.numericValue ?? 0) * 100) / 100,
    mobileFriendly: passes("viewport") && passes("font-size") && passes("tap-targets"),
    seoScore: categoryScore(lh, "seo"),
    accessibilityScore: categoryScore(lh, "accessibility"),
    seoIssueIds: failingIssueIds(lh, "seo"),
    accessibilityIssueIds: failingIssueIds(lh, "accessibility"),
  };
  return { facts, raw };
}
