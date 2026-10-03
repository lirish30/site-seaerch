import { describe, it, expect } from "vitest";
import type { Finding } from "../src/worker/types";
import { AUDIT_LABELS } from "../src/worker/scoring/labels";
import { capGroups, score, type CrawlFacts, type PageSpeedFacts } from "../src/worker/scoring/scorer";

const now = new Date("2026-10-02T00:00:00Z");
// Neutral values for the page and site-level facts: none of them fires a finding.
const neutralFacts = {
  h1Count: 1, wordCount: 500, imageCount: 0, imagesMissingAlt: 0, hasPhone: false, hasTelLink: false, hasLocalBusinessSchema: true,
  mixedContentCount: 0, datedBuildMarkers: [] as string[], isLikelyJsRendered: false,
  hasRobotsTxt: true, hasSitemap: true, httpRedirectsToHttps: true,
};
const goodCrawl: CrawlFacts = {
  https: true, hasTitle: true, hasMetaDescription: true, hasViewport: true, hasContactForm: true, emailCount: 1,
  copyrightYear: 2026, latestContentDate: "2026-08-01", pastEventDates: [], brokenLinkCount: 0, platform: "other", ...neutralFacts,
};
const noLh = { seoScore: null, accessibilityScore: null, seoIssueIds: [], accessibilityIssueIds: [] };
const goodPs: PageSpeedFacts = { performanceScore: 92, lcpMs: 1800, cls: 0.02, mobileFriendly: true, ...noLh };
const codes = (r: ReturnType<typeof score>) => r.findings.map((f) => f.code).sort();

describe("score", () => {
  it("no website → 100, new_site", () => {
    const r = score({ siteStatus: "no_website", crawl: null, pagespeed: null, now });
    expect(r.score).toBe(100);
    expect(r.offer).toBe("new_site");
    expect(codes(r)).toEqual(["no_website"]);
  });

  it("parked and unreachable → 90, new_site", () => {
    expect(score({ siteStatus: "parked", crawl: null, pagespeed: null, now }).score).toBe(90);
    expect(score({ siteStatus: "unreachable", crawl: null, pagespeed: null, now }).offer).toBe("new_site");
  });

  it("blocked without PageSpeed → 0, no site-level 'didn't load' finding, care_plan", () => {
    const r = score({ siteStatus: "blocked", crawl: null, pagespeed: null, now });
    expect(r.score).toBe(0);
    expect(r.findings).toEqual([]);
    expect(r.offer).toBe("care_plan");
  });

  it("blocked with PageSpeed → scored from PageSpeed only", () => {
    const r = score({ siteStatus: "blocked", crawl: null, pagespeed: { performanceScore: 30, lcpMs: 6000, cls: 0.02, mobileFriendly: false, ...noLh }, now });
    expect(codes(r)).toEqual(["not_mobile_friendly", "slow_lcp", "slow_mobile"]);
    expect(r.findings.every((f) => f.group !== "site")).toBe(true);
    expect(r.offer).toBe("performance");
  });

  it("healthy site → 0, low priority", () => {
    const r = score({ siteStatus: "ok", crawl: goodCrawl, pagespeed: goodPs, now });
    expect(r.score).toBe(0);
    expect(r.lowPriority).toBe(true);
  });

  it("slow_mobile and meh_mobile are mutually exclusive", () => {
    const slow = score({ siteStatus: "ok", crawl: goodCrawl, pagespeed: { ...goodPs, performanceScore: 30 }, now });
    expect(codes(slow)).toEqual(["slow_mobile"]);
    const meh = score({ siteStatus: "ok", crawl: goodCrawl, pagespeed: { ...goodPs, performanceScore: 60 }, now });
    expect(codes(meh)).toEqual(["meh_mobile"]);
    expect(score({ siteStatus: "ok", crawl: goodCrawl, pagespeed: { ...goodPs, performanceScore: 70 }, now }).findings).toHaveLength(0);
  });

  it("speed-heavy site → performance offer", () => {
    const r = score({ siteStatus: "ok", crawl: goodCrawl, pagespeed: { performanceScore: 30, lcpMs: 6000, cls: 0.4, mobileFriendly: true, ...noLh }, now });
    expect(r.score).toBe(25 + 10 + 5);
    expect(r.offer).toBe("performance");
  });

  it("stale-heavy site → care_plan", () => {
    const r = score({
      siteStatus: "ok",
      crawl: { ...goodCrawl, copyrightYear: 2023, latestContentDate: "2024-01-01", pastEventDates: ["2025-05-01"], brokenLinkCount: 4 },
      pagespeed: goodPs, now,
    });
    expect(codes(r)).toEqual(["broken_links", "old_copyright", "past_events", "stale_content"]);
    expect(r.score).toBe(33);
    expect(r.offer).toBe("care_plan");
  });

  it("copyright exactly current-2 counts, current-1 does not", () => {
    expect(codes(score({ siteStatus: "ok", crawl: { ...goodCrawl, copyrightYear: 2024 }, pagespeed: goodPs, now }))).toContain("old_copyright");
    expect(codes(score({ siteStatus: "ok", crawl: { ...goodCrawl, copyrightYear: 2025 }, pagespeed: goodPs, now }))).not.toContain("old_copyright");
  });

  it("basics only → seo_basics", () => {
    const r = score({ siteStatus: "ok", crawl: { ...goodCrawl, https: false, hasTitle: false }, pagespeed: goodPs, now });
    expect(codes(r)).toEqual(["no_https", "no_title_or_meta"]);
    expect(r.offer).toBe("seo_basics");
  });

  it("no_contact_form only when no form AND no email", () => {
    expect(codes(score({ siteStatus: "ok", crawl: { ...goodCrawl, hasContactForm: false, emailCount: 1 }, pagespeed: goodPs, now }))).toEqual([]);
    expect(codes(score({ siteStatus: "ok", crawl: { ...goodCrawl, hasContactForm: false, emailCount: 0 }, pagespeed: goodPs, now }))).toEqual(["no_contact_form"]);
  });

  it("not mobile friendly + stale → new_site", () => {
    const r = score({ siteStatus: "ok", crawl: { ...goodCrawl, hasViewport: false, copyrightYear: 2018 }, pagespeed: goodPs, now });
    expect(r.offer).toBe("new_site");
  });

  it("missing viewport counts as not_mobile_friendly even without pagespeed; partial input works", () => {
    const r = score({ siteStatus: "ok", crawl: { ...goodCrawl, hasViewport: false }, pagespeed: null, now });
    expect(codes(r)).toEqual(["not_mobile_friendly"]);
  });

  it("ties break speed > stale > basics", () => {
    // speed 10 (slow_lcp) vs stale 10 (old_copyright)
    const r = score({ siteStatus: "ok", crawl: { ...goodCrawl, copyrightYear: 2020 }, pagespeed: { ...goodPs, lcpMs: 5000 }, now });
    expect(r.offer).toBe("performance");
  });

  it("caps at 100", () => {
    const r = score({
      siteStatus: "ok",
      crawl: { https: false, hasTitle: false, hasMetaDescription: false, hasViewport: false, hasContactForm: false, emailCount: 0,
        copyrightYear: 2010, latestContentDate: "2015-01-01", pastEventDates: ["2020-01-01"], brokenLinkCount: 10, platform: "other", ...neutralFacts },
      pagespeed: { performanceScore: 10, lcpMs: 9000, cls: 0.9, mobileFriendly: false, ...noLh }, now,
    });
    expect(r.score).toBe(100);
  });

  it("evidence is plain English with numbers", () => {
    const r = score({ siteStatus: "ok", crawl: goodCrawl, pagespeed: { ...goodPs, performanceScore: 30, lcpMs: 8400 }, now });
    expect(r.findings.find((f) => f.code === "slow_lcp")!.evidence).toBe("Main content takes about 8.4 seconds to appear on a phone");
  });
  describe("lighthouse seo + accessibility", () => {
    const run = (ps: Partial<PageSpeedFacts> | null, crawl: CrawlFacts | null = goodCrawl) =>
      score({ siteStatus: "ok", crawl, pagespeed: ps ? { ...goodPs, ...ps } : null, now });
    const find = (r: ReturnType<typeof score>, code: string) => r.findings.find((f) => f.code === code);

    it("low_seo_score fires below 70, not at 70", () => {
      expect(codes(run({ seoScore: 69 }))).toEqual(["low_seo_score"]);
      expect(codes(run({ seoScore: 70 }))).toEqual([]);
      expect(find(run({ seoScore: 69 }), "low_seo_score")).toMatchObject({ group: "seo", points: 12, severity: "medium" });
    });

    it("low_accessibility fires below 70, not at 70", () => {
      expect(codes(run({ accessibilityScore: 69 }))).toEqual(["low_accessibility"]);
      expect(codes(run({ accessibilityScore: 70 }))).toEqual([]);
      expect(find(run({ accessibilityScore: 0 }), "low_accessibility")).toMatchObject({ group: "basics", points: 6, severity: "low" });
    });

    it("no findings when pagespeed is missing or the scores are null", () => {
      expect(run(null).findings).toEqual([]);
      expect(run({ seoScore: null, accessibilityScore: null, seoIssueIds: ["document-title"], accessibilityIssueIds: ["html-has-lang"] }).findings).toEqual([]);
    });

    it("seo evidence: first three labelled issues, or the score when there are none", () => {
      const ev = (ps: Partial<PageSpeedFacts>) => find(run({ seoScore: 40, ...ps }), "low_seo_score")!.evidence;
      expect(ev({ seoIssueIds: ["link-text", "crawlable-anchors", "hreflang", "is-crawlable"] }))
        .toBe("Google's own check flagged things that can hold the site back in search: links that just say things like 'click here', links Google can't follow, broken language settings");
      expect(ev({ seoIssueIds: ["link-text"] })).toBe("Google's own check flagged things that can hold the site back in search: links that just say things like 'click here'");
      expect(ev({})).toBe("Google's own check scored the homepage's search-friendliness at 40/100");
      // unmapped ids are ignored, never shown, and don't use up a truncation slot
      expect(ev({ seoIssueIds: ["tap-targets", "robots-txt", "canonical"] }))
        .toBe("Google's own check flagged things that can hold the site back in search: a page-address setting that points to the wrong place");
      expect(ev({ seoIssueIds: ["tap-targets", "robots-txt"] })).toBe("Google's own check scored the homepage's search-friendliness at 40/100");
    });

    it("accessibility evidence: first two labelled issues, or generic when there are none", () => {
      const ev = (ids: string[]) => find(run({ accessibilityScore: 50, accessibilityIssueIds: ids }), "low_accessibility")!.evidence;
      expect(ev(["color-contrast", "label", "html-has-lang"])).toBe("Parts of the site are hard to read or use for some visitors (text that's hard to read against its background, form fields without labels)");
      expect(ev(["label"])).toBe("Parts of the site are hard to read or use for some visitors (form fields without labels)");
      expect(ev(["aria-allowed-attr"])).toBe("Parts of the site are hard to read or use for some visitors");
      expect(ev([])).toBe("Parts of the site are hard to read or use for some visitors");
    });

    it("every label in the table is plain English", () => {
      const labels = Object.values(AUDIT_LABELS);
      expect(labels.length).toBeGreaterThan(5);
      for (const l of labels) expect(l).not.toMatch(/robots|canonical|\balt\b|meta|hreflang|aria|lang attr|lighthouse|ADA|compliant/i);
      const r = run({ seoScore: 10, accessibilityScore: 10 });
      for (const f of r.findings) expect(f.evidence).not.toMatch(/ADA\b|complian|lighthouse|lawsuit|legal/i);
    });

    it("image-alt is claimed under accessibility only, never under seo", () => {
      const r = run({ seoScore: 40, accessibilityScore: 40, seoIssueIds: ["image-alt", "link-text"], accessibilityIssueIds: ["image-alt"] });
      expect(find(r, "low_seo_score")!.evidence).not.toContain("images");
      expect(find(r, "low_seo_score")!.evidence).toContain("links that just say");
      expect(find(r, "low_accessibility")!.evidence).toContain("images without text descriptions");
      // seo with only image-alt falls back to the score sentence
      expect(find(run({ seoScore: 40, seoIssueIds: ["image-alt"] }), "low_seo_score")!.evidence).toContain("40/100");
    });

    it("drops title/summary ids from seo evidence when the crawler already reported them", () => {
      const ids = ["document-title", "meta-description", "link-text"];
      const crawled = run({ seoScore: 40, seoIssueIds: ids }, { ...goodCrawl, hasTitle: false });
      expect(codes(crawled)).toEqual(["low_seo_score", "no_title_or_meta"]);
      expect(find(crawled, "low_seo_score")!.evidence).toBe("Google's own check flagged things that can hold the site back in search: links that just say things like 'click here'");
      const only = run({ seoScore: 40, seoIssueIds: ["meta-description"] }, { ...goodCrawl, hasMetaDescription: false });
      expect(find(only, "low_seo_score")!.evidence).toBe("Google's own check scored the homepage's search-friendliness at 40/100");
      // crawler saw both, so PageSpeed's version is kept; likewise with no crawl at all
      expect(find(run({ seoScore: 40, seoIssueIds: ids }), "low_seo_score")!.evidence).toContain("no page title, no search-results summary");
      expect(find(run({ seoScore: 40, seoIssueIds: ids }, null), "low_seo_score")!.evidence).toContain("no page title");
    });

    it("blocked site: scored from PageSpeed only, and is-crawlable is not claimed", () => {
      const r = score({ siteStatus: "blocked", crawl: null, pagespeed: { ...goodPs, seoScore: 40, seoIssueIds: ["is-crawlable", "link-text"] }, now });
      expect(codes(r)).toEqual(["low_seo_score"]);
      expect(r.score).toBe(12);
      expect(r.offer).toBe("seo_basics");
      expect(r.findings[0].evidence).not.toContain("blocked from Google");
      expect(r.findings[0].evidence).toContain("links that just say");
      const only = score({ siteStatus: "blocked", crawl: null, pagespeed: { ...goodPs, seoScore: 40, seoIssueIds: ["is-crawlable"] }, now });
      expect(only.findings[0].evidence).toBe("Google's own check scored the homepage's search-friendliness at 40/100");
      // a normally crawled site keeps it
      expect(find(run({ seoScore: 40, seoIssueIds: ["is-crawlable"] }), "low_seo_score")!.evidence).toContain("blocked from Google");
    });

    it("seo points push the offer to seo_basics", () => {
      // speed 10 (slow_lcp) beats basics 6 (no_contact_form)...
      const base = { ...goodCrawl, hasContactForm: false, emailCount: 0 };
      expect(run({ lcpMs: 5000 }, base).offer).toBe("performance");
      // ...until seo (12) is added to the basics bucket: 18 > 10.
      expect(run({ lcpMs: 5000, seoScore: 30 }, base).offer).toBe("seo_basics");
      // seo alone also yields seo_basics
      expect(run({ seoScore: 30 }).offer).toBe("seo_basics");
    });

    it("new_site rule is unchanged by seo findings", () => {
      expect(run({ seoScore: 30 }, { ...goodCrawl, hasViewport: false }).offer).toBe("performance"); // speed 20 > seo 12, no stale
      expect(run({ seoScore: 30 }, { ...goodCrawl, hasViewport: false, copyrightYear: 2018 }).offer).toBe("new_site");
    });
  });

  describe("crawl-based findings", () => {
    const run = (c: Partial<CrawlFacts>, ps: Partial<PageSpeedFacts> = {}) =>
      score({ siteStatus: "ok", crawl: { ...goodCrawl, ...c }, pagespeed: { ...goodPs, ...ps }, now });
    const find = (r: ReturnType<typeof score>, code: string) => r.findings.find((f) => f.code === code);
    const BANNED = /lighthouse|schema|json|sitemap\.xml|robots|\bH1\b|alt text|viewport|meta description|jquery/i;

    it("no_click_to_call: phone shown but no tel link", () => {
      const r = run({ hasPhone: true });
      expect(find(r, "no_click_to_call")).toMatchObject({ group: "local", points: 8, severity: "medium",
        evidence: "Their phone number isn't set up as a tap-to-call link, so on many phones visitors have to copy and paste it" });
      expect(codes(run({ hasPhone: true, hasTelLink: true }))).toEqual([]);
      expect(codes(run({ hasPhone: false }))).toEqual([]);
    });

    it("no_local_schema: business details not machine-readable", () => {
      const r = run({ hasLocalBusinessSchema: false });
      expect(find(r, "no_local_schema")).toMatchObject({ group: "local", points: 5, severity: "low",
        evidence: "The site doesn't include business details (name, address, hours) in a form Google can read" });
    });

    it("thin_content: boundary at 150 words", () => {
      expect(codes(run({ wordCount: 149 }))).toEqual(["thin_content"]);
      expect(codes(run({ wordCount: 150 }))).toEqual([]);
      expect(find(run({ wordCount: 42 }), "thin_content")).toMatchObject({ group: "seo", points: 5,
        evidence: "The homepage has very little text (about 42 words), which gives Google little to show" });
    });

    it("no_h1", () => {
      expect(find(run({ h1Count: 0 }), "no_h1")).toMatchObject({ group: "seo", points: 3, evidence: "The homepage's headline isn't marked as the main heading, which Google uses to understand the page" });
      expect(codes(run({ h1Count: 2 }))).toEqual([]);
    });

    it("missing_alt: needs 4+ images and at least half missing", () => {
      expect(codes(run({ imageCount: 3, imagesMissingAlt: 3 }))).toEqual([]);
      expect(codes(run({ imageCount: 4, imagesMissingAlt: 2 }))).toEqual(["missing_alt"]);
      expect(codes(run({ imageCount: 4, imagesMissingAlt: 1 }))).toEqual([]);
      expect(codes(run({ imageCount: 100, imagesMissingAlt: 49 }))).toEqual([]);
      expect(codes(run({ imageCount: 100, imagesMissingAlt: 50 }))).toEqual(["missing_alt"]);
      expect(find(run({ imageCount: 10, imagesMissingAlt: 7 }), "missing_alt")).toMatchObject({ group: "seo", points: 4,
        evidence: "7 of 10 images have no description, so Google and screen readers can't tell what they show" });
    });

    it("no_sitemap only when definitely absent (null = unknown)", () => {
      expect(find(run({ hasSitemap: false }), "no_sitemap")).toMatchObject({ group: "seo", points: 3,
        evidence: "The site has no sitemap file, which helps Google find all of a site's pages" });
      expect(codes(run({ hasSitemap: null }))).toEqual([]);
      expect(codes(run({ hasRobotsTxt: false }))).toEqual([]); // no finding for robots.txt
    });

    it("mixed_content", () => {
      expect(find(run({ mixedContentCount: 1 }), "mixed_content")).toMatchObject({ group: "basics", points: 6, severity: "low",
        evidence: "The page loads some content over an insecure connection, which browsers may block or flag" });
      expect(codes(run({ mixedContentCount: 0 }))).toEqual([]);
    });

    it("no_https_redirect only when definitely false", () => {
      expect(find(run({ httpRedirectsToHttps: false }), "no_https_redirect")).toMatchObject({ group: "basics", points: 4,
        evidence: "Visiting the site without the secure 'https' version doesn't send people to the secure page" });
      expect(codes(run({ httpRedirectsToHttps: null }))).toEqual([]);
      expect(codes(run({ httpRedirectsToHttps: true }))).toEqual([]);
    });

    it("dated_build lists the first two markers", () => {
      expect(find(run({ datedBuildMarkers: ["frames"] }), "dated_build")).toMatchObject({ group: "stale", points: 10, severity: "medium",
        evidence: "The site is built with outdated techniques (frames)" });
      expect(find(run({ datedBuildMarkers: ["Flash", "frames", "x"] }), "dated_build")!.evidence)
        .toBe("The site is built with outdated techniques (Flash, frames)");
      expect(codes(run({ datedBuildMarkers: [] }))).toEqual([]);
    });

    it("isLikelyJsRendered suppresses absence-based findings only", () => {
      const absent = { hasPhone: true, hasLocalBusinessSchema: false, wordCount: 10, h1Count: 0 };
      expect(codes(run(absent)).sort()).toEqual(["no_click_to_call", "no_h1", "no_local_schema", "thin_content"]);
      expect(codes(run({ ...absent, isLikelyJsRendered: true }))).toEqual([]);
      const present = { imageCount: 5, imagesMissingAlt: 5, hasSitemap: false, mixedContentCount: 2, httpRedirectsToHttps: false, datedBuildMarkers: ["frames"] };
      expect(codes(run({ ...present, isLikelyJsRendered: true }))).toEqual(["dated_build", "missing_alt", "mixed_content", "no_https_redirect", "no_sitemap"]);
    });

    it("seo group cap now binds: five seo findings (27 raw) add 20", () => {
      const r = run({ wordCount: 10, h1Count: 0, imageCount: 4, imagesMissingAlt: 4, hasSitemap: false }, { seoScore: 30 });
      expect(codes(r)).toEqual(["low_seo_score", "missing_alt", "no_h1", "no_sitemap", "thin_content"]);
      expect(r.findings.reduce((n, x) => n + x.points, 0)).toBe(27);
      expect(r.score).toBe(20);
      // below the cap nothing is trimmed
      expect(run({ wordCount: 10, h1Count: 0 }).score).toBe(8);
    });

    it("local group cap: both local findings (13) fit under 15", () => {
      expect(run({ hasPhone: true, hasLocalBusinessSchema: false }).score).toBe(13);
    });

    it("offer: seo and local points feed seo_basics; dated_build + not mobile friendly → new_site", () => {
      expect(run({ hasPhone: true }).offer).toBe("seo_basics");
      expect(run({ h1Count: 0 }).offer).toBe("seo_basics");
      // stale 10 (dated_build) beats basics 8 (local) -> care_plan
      expect(run({ datedBuildMarkers: ["frames"], hasPhone: true }).offer).toBe("care_plan");
      // ...and not_mobile_friendly + any stale -> new_site
      expect(run({ datedBuildMarkers: ["frames"], hasViewport: false }).offer).toBe("new_site");
      expect(run({ hasViewport: false }).offer).toBe("performance");
    });

    it("missing_alt removes image-alt from the accessibility evidence (no double claim)", () => {
      const a11y = { accessibilityScore: 40, accessibilityIssueIds: ["image-alt", "color-contrast", "label"] };
      expect(find(run({}, a11y), "low_accessibility")!.evidence)
        .toBe("Parts of the site are hard to read or use for some visitors (images without text descriptions, text that's hard to read against its background)");
      const both = run({ imageCount: 4, imagesMissingAlt: 4 }, a11y);
      expect(find(both, "low_accessibility")!.evidence)
        .toBe("Parts of the site are hard to read or use for some visitors (text that's hard to read against its background, form fields without labels)");
      const only = run({ imageCount: 4, imagesMissingAlt: 4 }, { accessibilityScore: 40, accessibilityIssueIds: ["image-alt"] });
      expect(find(only, "low_accessibility")!.evidence).toBe("Parts of the site are hard to read or use for some visitors");
    });

    it("no new crawl findings when the crawl is null (blocked)", () => {
      const r = score({ siteStatus: "blocked", crawl: null, pagespeed: goodPs, now });
      expect(r.findings).toEqual([]);
    });

    it("evidence of every new finding is free of jargon", () => {
      const r = run({ hasPhone: true, hasLocalBusinessSchema: false, wordCount: 10, h1Count: 0, imageCount: 8, imagesMissingAlt: 8, hasSitemap: false,
        mixedContentCount: 3, httpRedirectsToHttps: false,
        datedBuildMarkers: ["old-style font tags", "scrolling or blinking text", "frames", "Flash", "old-style centering tags", "an old, no-longer-updated code library", "table-based page layout"] });
      const newCodes = ["no_click_to_call", "no_local_schema", "thin_content", "no_h1", "missing_alt", "no_sitemap", "mixed_content", "no_https_redirect", "dated_build"];
      expect(codes(r)).toEqual([...newCodes].sort());
      for (const c of newCodes) expect(find(r, c)!.evidence, c).not.toMatch(BANNED);
      expect(find(run({ datedBuildMarkers: ["an old, no-longer-updated code library"] }), "dated_build")!.evidence)
        .toBe("The site is built with outdated techniques (an old, no-longer-updated code library)");
      for (const m of ["old-style font tags", "scrolling or blinking text", "frames", "Flash", "old-style centering tags", "an old, no-longer-updated code library", "table-based page layout"])
      {
        const ev = run({ datedBuildMarkers: [m] }).findings[0].evidence;
        expect(ev).not.toMatch(BANNED);
        expect(ev.match(/outdated/g)).toHaveLength(1);
      }
    });
  });

  describe("no_email_auth (mail DNS)", () => {
    const EV = "Their business email isn't set up with the sender-verification records that help messages reach inboxes, so some may end up in spam";
    const run = (mailDns: { hasMx: boolean | null; hasSpf: boolean | null } | null | undefined, siteStatus: "ok" | "blocked" | "unreachable" | "parked" | "no_website" = "ok") =>
      score({ siteStatus, crawl: siteStatus === "ok" ? goodCrawl : null, pagespeed: goodPs, now, ...(mailDns === undefined ? {} : { mailDns }) });
    const hit = (r: ReturnType<typeof score>) => r.findings.find((x) => x.code === "no_email_auth");

    it("fires only for MX present and SPF absent, with exact evidence, weight 4, basics group", () => {
      const x = hit(run({ hasMx: true, hasSpf: false }))!;
      expect(x).toMatchObject({ code: "no_email_auth", group: "basics", points: 4, severity: "low", evidence: EV });
    });
    it("counts toward the seo_basics offer through the basics group", () => {
      const r = run({ hasMx: true, hasSpf: false });
      expect(r.offer).toBe("seo_basics");
      expect(r.score).toBe(4);
    });
    it("does not fire when MX is false/null, SPF is true/null, or mailDns is missing", () => {
      for (const m of [{ hasMx: false, hasSpf: false }, { hasMx: null, hasSpf: false }, { hasMx: true, hasSpf: true }, { hasMx: true, hasSpf: null },
        { hasMx: null, hasSpf: null }, { hasMx: false, hasSpf: null }, null, undefined])
        expect(hit(run(m)), JSON.stringify(m)).toBeUndefined();
    });
    it("fires for a blocked site but not for unreachable, parked or no_website", () => {
      expect(hit(run({ hasMx: true, hasSpf: false }, "blocked"))).toBeDefined();
      for (const st of ["unreachable", "parked", "no_website"] as const) {
        const r = run({ hasMx: true, hasSpf: false }, st);
        expect(codes(r)).not.toContain("no_email_auth");
        expect(r.findings).toHaveLength(1);
      }
    });
    it("evidence is plain English: no SPF/DMARC/MX/DNS/record jargon beyond the exact phrase", () => {
      expect(EV.replace("sender-verification records", "")).not.toMatch(/spf|dmarc|\bmx\b|dns|record/i);
      expect(hit(run({ hasMx: true, hasSpf: false }))!.evidence).not.toMatch(/spf|dmarc|\bmx\b|dns|record(?!s that)/i);
    });
  });

  describe("capGroups", () => {
    const fi = (group: Finding["group"], points: number): Finding => ({ code: "low_seo_score", group, severity: "low", points, evidence: "" });
    it("caps seo and local group sums, leaves other groups uncapped", () => {
      expect(capGroups([fi("seo", 12), fi("seo", 12), fi("speed", 25), fi("speed", 25), fi("speed", 25)])).toBe(20 + 75);
      expect(capGroups([fi("local", 10), fi("local", 10)])).toBe(15);
      expect(capGroups([fi("seo", 12), fi("local", 10)])).toBe(22);
      expect(capGroups([fi("seo", 8), fi("seo", 8)])).toBe(16);
    });
  });
});
