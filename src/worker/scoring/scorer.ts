import type { Finding, FindingCode, FindingGroup, Offer, Platform, SiteStatus } from "../types";
import { labelsFor } from "./labels";
import { GROUP_CAPS, SITE_STATUS_SCORE, THRESHOLDS as T, WEIGHTS as W } from "./config";

export interface CrawlFacts {
  https: boolean; hasTitle: boolean; hasMetaDescription: boolean; hasViewport: boolean;
  hasContactForm: boolean; emailCount: number; copyrightYear: number | null;
  latestContentDate: string | null; pastEventDates: string[]; brokenLinkCount: number;
  platform: Platform;
  h1Count: number; wordCount: number; imageCount: number; imagesMissingAlt: number;
  hasPhone: boolean; hasTelLink: boolean; hasLocalBusinessSchema: boolean; mixedContentCount: number;
  datedBuildMarkers: string[];
  // Static HTML only: when true, "X is absent" findings are suppressed because the page may fill X in with JavaScript.
  isLikelyJsRendered: boolean;
  // null = could not determine, which never produces a finding.
  hasRobotsTxt: boolean | null; hasSitemap: boolean | null; httpRedirectsToHttps: boolean | null;
}
export interface PageSpeedFacts {
  performanceScore: number; lcpMs: number; cls: number; mobileFriendly: boolean;
  // null = Lighthouse didn't return that category (never a real 0).
  seoScore: number | null; accessibilityScore: number | null; seoIssueIds: string[]; accessibilityIssueIds: string[];
}

const GROUP: Record<keyof typeof W, FindingGroup> = {
  slow_mobile: "speed", meh_mobile: "speed", slow_lcp: "speed", layout_shift: "speed", not_mobile_friendly: "speed",
  old_copyright: "stale", stale_content: "stale", past_events: "stale", broken_links: "stale",
  no_https: "basics", no_title_or_meta: "basics", no_contact_form: "basics",
  low_seo_score: "seo", low_accessibility: "basics",
  no_click_to_call: "local", no_local_schema: "local",
  thin_content: "seo", no_h1: "seo", missing_alt: "seo", no_sitemap: "seo",
  mixed_content: "basics", no_https_redirect: "basics", dated_build: "stale",
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

/** Points the findings add to the total: groups listed in GROUP_CAPS contribute at most their cap, the rest in full. */
export function capGroups(findings: Finding[]): number {
  const sums = new Map<string, number>();
  for (const x of findings) sums.set(x.group, (sums.get(x.group) ?? 0) + x.points);
  let total = 0;
  for (const [g, pts] of sums) total += Object.hasOwn(GROUP_CAPS, g) ? Math.min(pts, GROUP_CAPS[g as keyof typeof GROUP_CAPS]) : pts;
  return total;
}

export function score(input: { siteStatus: SiteStatus; crawl: CrawlFacts | null; pagespeed: PageSpeedFacts | null; now: Date }) {
  const { siteStatus, crawl, pagespeed: ps, now } = input;

  // "blocked" (bot protection) is scored like a site we could not crawl: PageSpeed findings only, and
  // never a site-level claim that it didn't load.
  if (siteStatus !== "ok" && siteStatus !== "blocked") {
    const map: Record<Exclude<SiteStatus, "ok" | "blocked">, [FindingCode, string]> = {
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
  // Presence-based: the images really are in the HTML, so JS rendering doesn't undo it.
  const missingAlt = !!crawl && crawl.imageCount >= T.missingAltMinImages && crawl.imagesMissingAlt / crawl.imageCount >= T.missingAltShare;
  if (ps) {
    if (ps.performanceScore < T.slowMobileBelow)
      out.push(f("slow_mobile", `Scores ${ps.performanceScore}/100 on Google's mobile speed test`));
    else if (ps.performanceScore < T.mehMobileBelow)
      out.push(f("meh_mobile", `Scores ${ps.performanceScore}/100 on Google's mobile speed test`));
    if (ps.lcpMs > T.slowLcpMs)
      out.push(f("slow_lcp", `Main content takes about ${secs(ps.lcpMs)} seconds to appear on a phone`));
    if (ps.cls > T.layoutShiftCls)
      out.push(f("layout_shift", "The page jumps around while it loads"));
    if (ps.seoScore !== null && ps.seoScore < T.seoLowBelow) {
      // Drop ids that would repeat another claim or describe something that isn't the business's site:
      // image-alt (accessibility's), title/summary (the crawler's no_title_or_meta), is-crawlable on a bot-challenge page.
      const drop = new Set(["image-alt"]);
      if (siteStatus === "blocked") drop.add("is-crawlable");
      if (crawl && (!crawl.hasTitle || !crawl.hasMetaDescription)) { drop.add("document-title"); drop.add("meta-description"); }
      const issues = labelsFor(ps.seoIssueIds.filter((id) => !drop.has(id)), 3);
      out.push(f("low_seo_score", issues.length
        ? `Google's own check flagged things that can hold the site back in search: ${issues.join(", ")}`
        : `Google's own check scored the homepage's search-friendliness at ${ps.seoScore}/100`));
    }
    if (ps.accessibilityScore !== null && ps.accessibilityScore < T.a11yLowBelow) {
      // The crawler's missing_alt already says it, so image-alt is not repeated.
      const issues = labelsFor(ps.accessibilityIssueIds.filter((id) => !(missingAlt && id === "image-alt")), 2);
      out.push(f("low_accessibility", issues.length
        ? `Parts of the site are hard to read or use for some visitors (${issues.join(", ")})`
        : "Parts of the site are hard to read or use for some visitors"));
    }
  }
  if (!crawl && ps && !ps.mobileFriendly)
    out.push(f("not_mobile_friendly", "The site isn't set up for phones, so text and buttons are hard to use"));
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
    // We only read static HTML, so a JS-built page can hide anything: absence claims are suppressed for it.
    const js = crawl.isLikelyJsRendered;
    if (crawl.hasPhone && !crawl.hasTelLink && !js)
      out.push(f("no_click_to_call", "Their phone number isn't tappable on a phone, so visitors have to copy and paste it"));
    if (!crawl.hasLocalBusinessSchema && !js)
      out.push(f("no_local_schema", "The site doesn't include business details (name, address, hours) in a form Google can read"));
    if (crawl.wordCount < T.thinContentWords && !js)
      out.push(f("thin_content", `The homepage has very little text (about ${crawl.wordCount} words), which gives Google little to show`));
    if (crawl.h1Count === 0 && !js) out.push(f("no_h1", "The homepage has no main heading"));
    if (missingAlt)
      out.push(f("missing_alt", `${crawl.imagesMissingAlt} of ${crawl.imageCount} images have no description, so Google and screen readers can't tell what they show`));
    if (crawl.hasSitemap === false)
      out.push(f("no_sitemap", "The site has no sitemap file, which helps Google find all of a site's pages"));
    if (crawl.mixedContentCount >= 1)
      out.push(f("mixed_content", "The page loads some content over an insecure connection, which browsers may block or flag"));
    if (crawl.httpRedirectsToHttps === false)
      out.push(f("no_https_redirect", "Visiting the site without the secure 'https' version doesn't send people to the secure page"));
    if (crawl.datedBuildMarkers.length >= 1)
      out.push(f("dated_build", `The site is built with outdated techniques (${crawl.datedBuildMarkers.slice(0, 2).join(", ")})`));
  }

  const total = Math.min(100, capGroups(out));
  // Offer selection deliberately uses raw (uncapped) sums, with seo/local points counted as "basics".
  const byGroup = (g: FindingGroup) => out.filter((x) => x.group === g).reduce((s, x) => s + x.points, 0);
  const speed = byGroup("speed"), stale = byGroup("stale"), basics = byGroup("basics") + byGroup("seo") + byGroup("local");

  let offer: Offer;
  if (out.some((x) => x.code === "not_mobile_friendly") && stale > 0) offer = "new_site";
  else if (speed >= stale && speed >= basics && speed > 0) offer = "performance";
  else if (stale >= basics && stale > 0) offer = "care_plan";
  else if (basics > 0) offer = "seo_basics";
  else offer = "care_plan";

  out.sort((a, b) => b.points - a.points);
  return { score: total, findings: out, offer, lowPriority: total < T.lowPriorityBelow };
}
