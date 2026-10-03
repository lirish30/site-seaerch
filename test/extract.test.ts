import { describe, it, expect } from "vitest";
import { extractPage, pickCrawlTargets, isSocialOnlyUrl } from "../src/worker/crawler/extract";
import type { Platform } from "../src/worker/types";
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

describe("platform detection", () => {
  const h = (head: string, body = "") => `<html><head>${head}</head><body>${body}</body></html>`;
  const detect = (html: string) => extractPage(html, "https://a.com/").platform;
  const gen = (c: string) => `<meta name="generator" content="${c}">`;
  const wp = `<link rel="stylesheet" href="/wp-content/themes/x/style.css">`;

  const positives: [string, Platform, string][] = [
    ["wix generator", "wix", h(gen("Wix.com Website Builder"))],
    ["wix wixstatic image", "wix", h("", `<img src="https://static.wixstatic.com/media/a.jpg">`)],
    ["wix parastorage script", "wix", h("", `<script src="https://static.parastorage.com/services/x.js"></script>`)],
    ["wix srcset", "wix", h("", `<img srcset="/a.jpg 1x, https://static.wixstatic.com/media/b.jpg 2x">`)],
    ["wix inline style url", "wix", h("", `<div style="background:url('https://static.wixstatic.com/media/c.jpg')"></div>`)],
    ["squarespace generator", "squarespace", h(gen("Squarespace"))],
    ["squarespace static1 script", "squarespace", h("", `<script src="https://static1.squarespace.com/static/x.js"></script>`)],
    ["squarespace cdn image", "squarespace", h("", `<img data-src="https://images.squarespace-cdn.com/content/a.jpg">`)],
    ["godaddy generator", "godaddy", h(gen("Starfield Technologies; Go Daddy Website Builder 8.0.0000"))],
    ["godaddy wsimg image", "godaddy", h("", `<img src="https://img1.wsimg.com/isteam/ip/a.png">`)],
    ["wordpress generator", "wordpress", h(gen("WordPress 6.4.2"))],
    ["wordpress wp-content", "wordpress", h(wp)],
    ["wordpress wp-includes", "wordpress", h("", `<script src="https://a.com/wp-includes/js/jquery.js"></script>`)],
    ["weebly generator", "weebly", h(gen("Weebly"))],
    ["weebly editmysite script", "weebly", h("", `<script src="//cdn2.editmysite.com/js/a.js"></script>`)],
    ["shopify generator", "shopify", h(gen("Shopify"))],
    ["shopify cdn stylesheet", "shopify", h(`<link rel="stylesheet" href="https://cdn.shopify.com/s/files/1/a.css">`)],
    ["webflow generator", "webflow", h(gen("Webflow"))],
    ["webflow website-files image", "webflow", h("", `<img src="https://assets.website-files.com/abc/a.png">`)],
    ["webflow data-wf html attribute", "webflow", `<html data-wf-page="123" data-wf-site="456"><head></head><body></body></html>`],
    ["same-host absolute wp-content", "wordpress", h("", `<img src="https://a.com/wp-content/uploads/a.jpg">`)],
    ["www same-host absolute wp-content", "wordpress", h("", `<img src="https://www.a.com/wp-content/uploads/a.jpg">`)],
    ["subdomain cdn wp-content", "wordpress", h("", `<img src="https://cdn.a.com/wp-content/uploads/a.jpg">`)],
    ["protocol-relative same-host wp-content", "wordpress", h("", `<script src="//a.com/wp-includes/js/a.js"></script>`)],
    ["relative wp-content without leading slash", "wordpress", h("", `<img src="wp-content/uploads/a.jpg">`)],
    ["jetpack photon image", "wordpress", h("", `<img src="https://i0.wp.com/a.com/uploads/a.jpg">`)],
    ["uppercase tags and attributes", "wix", h("", `<IMG SRC="https://static.wixstatic.com/a.jpg">`)],
    ["uppercase wp-content attribute", "wordpress", h(`<LINK REL="stylesheet" HREF="/wp-content/themes/x/style.css">`)],
    ["unquoted generator attribute", "wordpress", h(`<meta name=generator content=WordPress>`)],
    ["uppercase generator tag", "wix", h(`<META NAME="GENERATOR" CONTENT="Wix.com Website Builder">`)],
    ["generator content before name", "squarespace", h(`<meta content="Squarespace" name="generator">`)],
    ["unrecognised generator", "other", h(gen("Hugo 0.120"))],
    ["no signals", "other", h(`<title>Hand rolled</title>`, "<p>hi</p>")],
  ];
  it.each(positives)("%s -> %s", (_label, want, html) => expect(detect(html)).toBe(want));

  // Platform later gates "X is missing" findings, so mislabelling a real WordPress/static site is costly.
  const falsePositiveGuards: [string, Platform, string][] = [
    ["wordpress with footer link to wix.com", "wordpress", h(wp, `<a href="https://www.wix.com">Wix</a>`)],
    ["wordpress hotlinking one wixstatic image", "wordpress", h(wp, `<img src="https://static.wixstatic.com/media/a.jpg">`)],
    ["wordpress with a Shopify Buy Button script", "wordpress", h(wp, `<script src="https://cdn.shopify.com/s/buy-button.js"></script>`)],
    ["wordpress with a foreign builder asset and no generator", "wordpress", h(wp, `<img src="https://assets.website-files.com/a.png">`)],
    ["text: moved off squarespace.com", "other", h("", `<p>we moved off squarespace.com last year</p>`)],
    ["text: weebly.com vs wordpress", "other", h("", `<p>weebly.com vs wordpress</p>`)],
    ["mailto support@wix.com", "other", h("", `<a href="mailto:support@wix.com">mail</a>`)],
    ["link to a path containing wix.com", "other", h("", `<a href="https://example.com/wix.com-review">r</a>`)],
    ["text: avoid the GoDaddy Website Builder", "other", h("", `<p>Avoid the GoDaddy Website Builder</p>`)],
    ["data-wf-page as text", "other", h("", `<code>data-wf-page</code>`)],
    ["the word sqspx", "other", h("", `<p>sqspx</p>`)],
    ["www.squarespace.com link", "other", h("", `<a href="https://www.squarespace.com/pricing">p</a>`)],
    ["www.weebly.com link", "other", h("", `<a href="https://www.weebly.com">w</a>`)],
    ["data-wf attribute on a non-html element", "other", h("", `<div data-wf-page="1"></div>`)],
    ["squarespace page hotlinking a foreign wp-content image", "squarespace", h(`<link rel="stylesheet" href="https://static1.squarespace.com/a.css">`, `<img src="https://someblog.com/wp-content/uploads/a.jpg">`)],
    ["wix page linking a foreign wp-content pdf", "wix", h("", `<script src="https://static.parastorage.com/x.js"></script><a href="https://someblog.com/wp-content/uploads/menu.pdf">m</a>`)],
    ["foreign wp-content link alone on a plain page", "other", h("", `<img src="https://someblog.com/wp-content/uploads/a.jpg">`)],
    ["foreign wp-includes script alone on a plain page", "other", h("", `<script src="//other.org/wp-includes/js/a.js"></script>`)],
    ["commented-out generator", "other", h(`<!-- <meta name="generator" content="Wix.com Website Builder"> -->`)],
    ["generator tag inside an inline script", "other", h(`<script>document.write('<meta name="generator" content="Wix.com">')</script>`)],
    ["meta description mentioning wixstatic.com", "other", h(`<meta name="description" content="images from wixstatic.com">`)],
  ];
  it.each(falsePositiveGuards)("%s -> %s", (_label, want, html) => expect(detect(html)).toBe(want));

  it("reads every generator tag, not just the first", () => {
    expect(detect(h(gen("Elementor 3.18.0") + gen("WordPress 6.4")))).toBe("wordpress");
  });

  it("a recognised generator wins over asset markers", () => {
    expect(detect(h(gen("Squarespace"), `<img src="https://static.wixstatic.com/a.jpg">`))).toBe("squarespace");
    expect(detect(h(gen("WordPress 6.4"), `<script src="https://cdn.shopify.com/a.js"></script>`))).toBe("wordpress");
  });

  it("does not take long on a hostile page of unclosed meta tags", () => {
    const t = Date.now();
    detect("<html><head>" + `<meta name="x"`.repeat(10_000));
    expect(Date.now() - t).toBeLessThan(1000);
  });
});
