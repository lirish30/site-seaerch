import { describe, it, expect } from "vitest";
import { extractPage, pickCrawlTargets, isSocialOnlyUrl, detectPlatform, type Platform } from "../src/worker/crawler/extract";
import oldHtml from "./fixtures/html/old-plumber.html?raw";
import modernHtml from "./fixtures/html/modern.html?raw";
import parkedHtml from "./fixtures/html/parked.html?raw";
import teamHtml from "./fixtures/html/team.html?raw";

describe("extractPage", () => {
  const old = extractPage(oldHtml, "http://aceplumbing.com/");

  it("finds title, missing meta and viewport", () => {
    expect(old.title).toBe("Ace Plumbing");
    expect(old.metaDescription).toBeNull();
    expect(old.hasViewport).toBe(false);
  });

  it("decodes obfuscated and mailto emails, lowercased, drops junk", () => {
    const v = old.emails.map((e) => e.value).sort();
    expect(v).toEqual(["bob@aceplumbing.com", "info@aceplumbing.com"]);
  });

  it("takes the latest year in a copyright range", () => {
    expect(old.copyrightYear).toBe(2019);
  });

  it("collects dates and event dates as ISO", () => {
    expect(old.dates).toContain("2019-06-03");
    expect(old.eventDates).toContain("2023-03-14");
    expect(old.eventDates).not.toContain("2019-06-03");
  });

  it("collects phones and socials", () => {
    expect(old.phones).toContain("(208) 555-0134");
    expect(old.socials).toContain("https://facebook.com/aceplumbing");
  });

  it("internal links are absolute, same host, no non-HTML files", () => {
    expect(old.internalLinks).toContain("http://aceplumbing.com/contact.html");
    expect(old.internalLinks.some((l) => l.endsWith(".pdf"))).toBe(false);
    expect(old.internalLinks.some((l) => l.includes("other.com"))).toBe(false);
  });

  it("modern page: meta, viewport, form, footer email, <time> date", () => {
    const m = extractPage(modernHtml, "https://brightdental.com/");
    expect(m.metaDescription).toBe("Family dentistry in Boise.");
    expect(m.hasViewport).toBe(true);
    expect(m.hasForm).toBe(true);
    expect(m.emails.map((e) => e.value)).toEqual(["hello@brightdental.com"]);
    expect(m.copyrightYear).toBe(2026);
    expect(m.dates).toContain("2026-09-12");
  });

  it("detects parked domains", () => {
    expect(extractPage(parkedHtml, "http://aceplumbing.com/").isParked).toBe(true);
    expect(old.isParked).toBe(false);
  });

  it("associates names and roles with team emails", () => {
    const t = extractPage(teamHtml, "https://aceplumbing.com/team");
    const jane = t.emails.find((e) => e.value === "jane@aceplumbing.com")!;
    expect(jane.personName).toBe("Jane Doe");
    expect(jane.role).toBe("Owner");
    expect(t.emails.find((e) => e.value === "tom@aceplumbing.com")!.role).toBe("Office Manager");
    expect(t.emails.find((e) => e.value === "tom@aceplumbing.com")!.personName).toBe("Tom Lee");
  });

  it("does not attribute a section heading as a person name", () => {
    expect(old.emails.find((e) => e.value === "bob@aceplumbing.com")!.personName).toBeNull();
  });

  it("does not flag jordan.com as a parked page", () => {
    expect(extractPage("<h1>Jordan Plumbing</h1><p>Visit www.jordan.com</p>", "http://jordan.com/").isParked).toBe(false);
  });

  it("keeps real domains that merely contain junk words, drops placeholders", () => {
    const h = "<p>info@sentryalarm.com x@mydomain.com example@example.com name@domain.com</p>";
    expect(extractPage(h, "http://x.com/").emails.map((e) => e.value)).toEqual(["info@sentryalarm.com", "x@mydomain.com"]);
  });
});

describe("pickCrawlTargets", () => {
  it("prioritises contact, about/team, blog/news/events; caps count; dedupes", () => {
    const links = [
      "https://a.com/services", "https://a.com/contact", "https://a.com/contact#form", "https://a.com/about",
      "https://a.com/our-team", "https://a.com/blog", "https://a.com/events", "https://a.com/news",
    ];
    expect(pickCrawlTargets(links, "https://a.com/", 5)).toEqual([
      "https://a.com/contact", "https://a.com/about", "https://a.com/our-team", "https://a.com/blog", "https://a.com/news",
    ]);
  });
});

describe("pickCrawlTargets robustness", () => {
  it("same host only, resolves relative links, skips garbage", () => {
    expect(pickCrawlTargets(["https://evil.com/contact", "/contact", "http://[bad", "https://www.a.com/about"], "https://a.com/", 3))
      .toEqual(["https://a.com/contact", "https://www.a.com/about"]);
  });
});

describe("isSocialOnlyUrl", () => {
  it("flags social/aggregator profiles as not a real website", () => {
    for (const u of ["https://www.facebook.com/ace", "https://instagram.com/ace", "https://www.yelp.com/biz/ace", "https://linktr.ee/ace", "https://ace.business.site"])
      expect(isSocialOnlyUrl(u)).toBe(true);
    expect(isSocialOnlyUrl("https://aceplumbing.com")).toBe(false);
  });
});

describe("detectPlatform", () => {
  const h = (head: string, body = "") => `<html><head>${head}</head><body>${body}</body></html>`;
  const cases: [Platform, string][] = [
    ["wix", h(`<meta name="generator" content="Wix.com Website Builder">`)],
    ["wix", h("", `<img src="https://static.wixstatic.com/media/a.jpg">`)],
    ["squarespace", h(`<meta name="generator" content="Squarespace">`)],
    ["squarespace", h("", `<script src="https://static1.squarespace.com/static/x.js"></script>`)],
    ["squarespace", h(`<link href="https://assets.sqsp.net/a.css" rel="stylesheet">`)],
    ["godaddy", h(`<meta name="generator" content="Starfield Technologies; Go Daddy Website Builder 8.0.0000">`)],
    ["godaddy", h("", `<img src="https://img1.wsimg.com/isteam/ip/a.png">`)],
    ["wordpress", h(`<meta name="generator" content="WordPress 6.4.2">`)],
    ["wordpress", h(`<link rel="stylesheet" href="/wp-content/themes/x/style.css">`)],
    ["weebly", h(`<meta name="generator" content="Weebly">`)],
    ["weebly", h("", `<script src="//cdn2.editmysite.com/js/a.js"></script><a href="https://www.weebly.com">w</a>`)],
    ["shopify", h(`<meta name="generator" content="Shopify">`)],
    ["shopify", h(`<link rel="stylesheet" href="https://cdn.shopify.com/s/files/1/a.css">`)],
    ["webflow", h(`<meta name="generator" content="Webflow">`)],
    ["webflow", h("", `<img src="https://assets.website-files.com/abc/a.png">`)],
    ["webflow", `<html data-wf-page="123" data-wf-site="456"><head></head><body></body></html>`],
    ["other", h(`<title>Hand rolled</title>`, "<p>hi</p>")],
    ["other", h(`<meta name="generator" content="Hugo 0.120">`)],
  ];
  it.each(cases)("%s", (want, html) => expect(detectPlatform(html)).toBe(want));

  it("generator meta wins over asset markers, whatever the attribute order", () => {
    expect(detectPlatform(h(`<meta content="Squarespace" name="generator">`, `<img src="https://static.wixstatic.com/a.jpg">`))).toBe("squarespace");
    expect(detectPlatform(h(`<meta name="generator" content="WordPress 6.4">`, `<script src="https://cdn.shopify.com/a.js"></script>`))).toBe("wordpress");
  });

  it("extractPage populates platform", () => {
    expect(extractPage(h("", `<img src="https://static.wixstatic.com/a.jpg">`), "https://a.com/").platform).toBe("wix");
  });
});
