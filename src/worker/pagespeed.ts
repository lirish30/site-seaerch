import type { PageSpeedFacts } from "./scoring/scorer";
import type { Fetcher } from "./crawler/crawl";

export class RateLimitedError extends Error {}

const ENDPOINT = "https://www.googleapis.com/pagespeedonline/v5/runPagespeed";

// Lighthouse audit id -> label that reads after a colon in outreach. Unlisted ids are ignored on purpose:
// we never surface a raw id or Lighthouse's own jargon-heavy title to a business owner.
const ISSUE_LABELS: Record<string, string> = {
  "meta-description": "no search-results summary",
  "document-title": "no page title",
  "is-crawlable": "blocked from Google",
  canonical: "no preferred page address set",
  "link-text": "links that just say things like 'click here'",
  "crawlable-anchors": "links Google can't follow",
  "image-alt": "images without descriptions",
  "http-status-code": "pages that return errors",
  "robots-txt": "a broken robots file",
  hreflang: "broken language settings",
  "color-contrast": "text that's hard to read against its background",
  label: "form fields without labels",
  "link-name": "links with no readable name",
  "button-name": "buttons with no readable name",
  "html-has-lang": "no page language set",
};

// Only audits that count toward the category (weight > 0) are attributed to it; no auditRefs -> no issues.
function failingIssues(lh: any, category: string): string[] {
  const refs: any[] = lh.categories?.[category]?.auditRefs ?? [];
  const out: string[] = [];
  for (const r of Array.isArray(refs) ? refs : []) {
    const label = ISSUE_LABELS[r?.id];
    const sc = lh.audits?.[r?.id]?.score;
    if (!label || !(r.weight > 0) || typeof sc !== "number" || sc >= 0.9 || out.includes(label)) continue;
    out.push(label);
  }
  return out;
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
    seoIssues: failingIssues(lh, "seo"),
    accessibilityIssues: failingIssues(lh, "accessibility"),
  };
  return { facts, raw };
}
