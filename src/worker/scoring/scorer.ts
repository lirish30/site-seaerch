import type { Finding, FindingCode, FindingGroup, Offer, SiteStatus } from "../types";
import { SITE_STATUS_SCORE, THRESHOLDS as T, WEIGHTS as W } from "./config";

export interface CrawlFacts {
  https: boolean; hasTitle: boolean; hasMetaDescription: boolean; hasViewport: boolean;
  hasContactForm: boolean; emailCount: number; copyrightYear: number | null;
  latestContentDate: string | null; pastEventDates: string[]; brokenLinkCount: number;
}
export interface PageSpeedFacts { performanceScore: number; lcpMs: number; cls: number; mobileFriendly: boolean; }

const GROUP: Record<keyof typeof W, FindingGroup> = {
  slow_mobile: "speed", meh_mobile: "speed", slow_lcp: "speed", layout_shift: "speed", not_mobile_friendly: "speed",
  old_copyright: "stale", stale_content: "stale", past_events: "stale", broken_links: "stale",
  no_https: "basics", no_title_or_meta: "basics", no_contact_form: "basics",
};

function sev(points: number): Finding["severity"] {
  return points >= 15 ? "high" : points >= 8 ? "medium" : "low";
}
function f(code: keyof typeof W, evidence: string): Finding {
  return { code, group: GROUP[code], severity: sev(W[code]), points: W[code], evidence };
}
function monthsBetween(iso: string, now: Date): number {
  const d = new Date(iso);
  return (now.getUTCFullYear() - d.getUTCFullYear()) * 12 + (now.getUTCMonth() - d.getUTCMonth());
}
const secs = (ms: number) => (ms / 1000).toFixed(1);

export function score(input: { siteStatus: SiteStatus; crawl: CrawlFacts | null; pagespeed: PageSpeedFacts | null; now: Date }) {
  const { siteStatus, crawl, pagespeed: ps, now } = input;

  if (siteStatus !== "ok") {
    const map: Record<Exclude<SiteStatus, "ok">, [FindingCode, string]> = {
      no_website: ["no_website", "No website listed on their Google Business profile"],
      parked: ["site_parked", "Their web address shows a placeholder or for-sale page"],
      unreachable: ["site_unreachable", "Their website didn't load when we tried it"],
    };
    const [code, evidence] = map[siteStatus];
    const pts = SITE_STATUS_SCORE[siteStatus];
    return { score: pts, offer: "new_site" as Offer, lowPriority: false,
      findings: [{ code, group: "site", severity: "high", points: pts, evidence } as Finding] };
  }

  const out: Finding[] = [];
  if (ps) {
    if (ps.performanceScore < T.slowMobileBelow)
      out.push(f("slow_mobile", `Scores ${ps.performanceScore}/100 on Google's mobile speed test`));
    else if (ps.performanceScore < T.mehMobileBelow)
      out.push(f("meh_mobile", `Scores ${ps.performanceScore}/100 on Google's mobile speed test`));
    if (ps.lcpMs > T.slowLcpMs)
      out.push(f("slow_lcp", `Main content takes about ${secs(ps.lcpMs)} seconds to appear on a phone`));
    if (ps.cls > T.layoutShiftCls)
      out.push(f("layout_shift", "The page jumps around while it loads"));
  }
  if (crawl) {
    if (!crawl.hasViewport || (ps && !ps.mobileFriendly))
      out.push(f("not_mobile_friendly", "The site isn't set up for phones, so text and buttons are hard to use"));
    if (crawl.copyrightYear !== null && crawl.copyrightYear <= now.getUTCFullYear() - T.oldCopyrightYearsBack)
      out.push(f("old_copyright", `The footer still says © ${crawl.copyrightYear}`));
    if (crawl.latestContentDate && monthsBetween(crawl.latestContentDate, now) > T.staleContentMonths)
      out.push(f("stale_content", `The newest post or update is from ${crawl.latestContentDate.slice(0, 7)}`));
    if (crawl.pastEventDates.length > 0)
      out.push(f("past_events", `Lists events that already happened (e.g. ${crawl.pastEventDates[0]})`));
    if (crawl.brokenLinkCount >= T.brokenLinksMin)
      out.push(f("broken_links", `${crawl.brokenLinkCount} links on the site lead to missing pages`));
    if (!crawl.https) out.push(f("no_https", "The site isn't secure (no HTTPS), so browsers show a warning"));
    if (!crawl.hasTitle || !crawl.hasMetaDescription)
      out.push(f("no_title_or_meta", "The homepage is missing the title or summary Google shows in search results"));
    if (!crawl.hasContactForm && crawl.emailCount === 0)
      out.push(f("no_contact_form", "There's no contact form or email address on the site"));
  }

  const total = Math.min(100, out.reduce((s, x) => s + x.points, 0));
  const byGroup = (g: FindingGroup) => out.filter((x) => x.group === g).reduce((s, x) => s + x.points, 0);
  const speed = byGroup("speed"), stale = byGroup("stale"), basics = byGroup("basics");

  let offer: Offer;
  if (out.some((x) => x.code === "not_mobile_friendly") && stale > 0) offer = "new_site";
  else if (speed >= stale && speed >= basics && speed > 0) offer = "performance";
  else if (stale >= basics && stale > 0) offer = "care_plan";
  else if (basics > 0) offer = "seo_basics";
  else offer = "care_plan";

  out.sort((a, b) => b.points - a.points);
  return { score: total, findings: out, offer, lowPriority: total < T.lowPriorityBelow };
}
