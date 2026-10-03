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

describe("extra page facts", () => {
  const page = (body: string, head = "") => `<html><head>${head}</head><body>${body}</body></html>`;
  const facts = (body: string, url = "https://a.com/", head = "") => extractPage(page(body, head), url);
  const ld = (json: string, attrs = `type="application/ld+json"`) => `<script ${attrs}>${json}</script>`;
  const lorem = "lorem ipsum dolor sit amet consectetur adipiscing elit sed do eiusmod tempor incididunt ut labore et dolore magna aliqua ".repeat(3);

  it("counts h1 elements, not h1 text, comments or scripts", () => {
    expect(facts(`<h1>a</h1><H1>b</H1><p>h1</p><!-- <h1>c</h1> --><script>document.write("<h1>d</h1>")</script>`).h1Count).toBe(2);
    expect(facts("<h2>a</h2>").h1Count).toBe(0);
  });

  it("wordCount counts visible words only: no title, scripts, styles or noscript", () => {
    const hugeScript = `<script>var x = "${"word ".repeat(50_000)}"; document.write("<p>a b c</p>")</script>`;
    const f = facts(`<p>one two  three</p>${hugeScript}<style>${"a { color: red } ".repeat(5000)}</style><noscript><p>enable javascript please</p></noscript>`, "https://a.com/", "<title>Big Title Words</title>");
    expect(f.wordCount).toBe(3);
    expect(facts("").wordCount).toBe(0);
  });

  it("wordCount without a <body> still excludes the head and title", () => {
    expect(extractPage("<html><head><title>T T T</title></head><p>one two three</p></html>", "https://a.com/").wordCount).toBe(3);
    expect(extractPage("<title>T T T</title><p>one two three</p>", "https://a.com/").wordCount).toBe(3);
  });

  it("descends into declarative shadow DOM templates but still skips plain ones", () => {
    for (const attr of [`shadowrootmode="open"`, `shadowroot="open"`, `SHADOWROOTMODE="closed"`]) {
      const f = facts(`<my-hero><template ${attr}><h1>Bob's Plumbing</h1><img src="x.png"><a href="tel:1">Call</a></template></my-hero>`);
      expect([attr, f.h1Count, f.imageCount, f.imagesMissingAlt, f.hasTelLink]).toEqual([attr, 1, 1, 1, true]);
    }
    const plain = facts(`<template><h1>x</h1><img src="x.png"><a href="tel:1">Call</a></template>`);
    expect([plain.h1Count, plain.imageCount, plain.hasTelLink]).toEqual([0, 0, false]);
  });

  it("the doctype is not page text", () => {
    expect(extractPage("<!doctype html>\n<html><head><title>T</title></head><p>one two</p></html>", "https://a.com/").wordCount).toBe(2);
    expect(extractPage("<!DOCTYPE html PUBLIC \"-//W3C//DTD HTML 4.01//EN\"><p>one</p>", "https://a.com/").wordCount).toBe(1);
  });

  it("counts images and missing alt: alt='' is decorative, presentational and hidden images are skipped", () => {
    const f = facts([
      `<img src="a.png">`, `<img src="b.png" alt="Logo">`, `<img src="c.png" alt="">`, `<IMG SRC="d.png">`, `<IMG SRC="e.png" ALT="">`,
      `<img src="f.png" role="presentation">`, `<img src="g.png" role="NONE">`, `<img src="h.png" aria-hidden="true">`,
      `<img src="i.png" aria-hidden="false">`,
    ].join(""));
    expect(f.imageCount).toBe(6);
    expect(f.imagesMissingAlt).toBe(3);
  });

  it("skips tracking pixels, hidden images and images inside templates", () => {
    const hidden = [
      `<img src="p.gif" width="1" height="1">`, `<img src="p.gif" width="0" height="0">`, `<img src="p.gif" style="width:1px; height: 1px">`,
      `<IMG SRC="p.gif" WIDTH="1px" HEIGHT="1">`, `<img src="a.png" hidden>`, `<img src="a.png" style="color: red; DISPLAY : none">`,
      `<template><img src="a.png"></template>`,
    ];
    for (const h of hidden) { const f = facts(h); expect([h, f.imageCount, f.imagesMissingAlt]).toEqual([h, 0, 0]); }
    const real = facts(`<img src="a.png" width="1" height="50"><img src="b.png" width="1%" height="1%"><img src="c.png" style="width:1px">`);
    expect([real.imageCount, real.imagesMissingAlt]).toEqual([3, 3]);
  });

  it("ignores images in comments, scripts and noscript", () => {
    const f = facts(`<!-- <img src="a.png"> --><script>document.write('<img src="b.png">')</script><noscript><img src="c.png"></noscript>`);
    expect([f.imageCount, f.imagesMissingAlt]).toEqual([0, 0]);
  });

  it("detects tel: links only on anchors", () => {
    expect(facts(`<a href="tel:+12085550134">Call</a>`).hasTelLink).toBe(true);
    expect(facts(`<A HREF="  TEL:2085550134">Call</A>`).hasTelLink).toBe(true);
    for (const b of [`<a href="mailto:a@b.com">m</a>`, `<p>tel:2085550134</p>`, `<a href="https://a.com/tel:1">x</a>`, `<a>tel:1</a>`, `<link href="tel:1">`])
      expect(facts(b).hasTelLink).toBe(false);
  });

  describe("LocalBusiness schema", () => {
    const yes: [string, string][] = [
      ["plain LocalBusiness", ld(`{"@context":"https://schema.org","@type":"LocalBusiness","name":"Ace"}`)],
      ["specific subtype", ld(`{"@type":"Plumber"}`)],
      ["@graph", ld(`{"@context":"https://schema.org","@graph":[{"@type":"WebSite"},{"@type":"Organization"},{"@type":"Dentist","name":"B"}]}`)],
      ["top-level array", ld(`[{"@type":"WebSite"},{"@type":"Electrician"}]`)],
      ["@type array", ld(`{"@type":["Organization","HVACBusiness"]}`)],
      ["nested object", ld(`{"@type":"WebSite","about":{"@type":"Restaurant"}}`)],
      ["full IRI", ld(`{"@type":"https://schema.org/LocalBusiness"}`)],
      ["prefixed type", ld(`{"@type":"schema:AutoRepair"}`)],
      ["ends with LocalBusiness", ld(`{"@type":"MyLocalBusiness"}`)],
      ["uppercase script and type value", `<SCRIPT TYPE="Application/LD+JSON">{"@type":"Locksmith"}</SCRIPT>`],
      ["valid block after an invalid one", ld(`{"@type":`) + ld(`{"@type":"Bakery"}`)],
      ["entities, markup and escapes in strings", ld(`{"@type":"Plumber","name":"Bob &amp; Sons &quot;Best&quot; <b>x</b> \\u00e9 \\"q\\"","description":"a </scr b < c"}`)],
    ];
    it.each(yes)("%s -> true", (_l, body) => expect(facts(body).hasLocalBusinessSchema).toBe(true));

    const no: [string, string][] = [
      ["Organization", ld(`{"@type":"Organization"}`)],
      ["WebSite and Person", ld(`[{"@type":"WebSite"},{"@type":"Person"}]`)],
      ["business name only in a string value", ld(`{"@type":"Organization","name":"LocalBusiness Plumber"}`)],
      ["invalid JSON", ld(`{"@type":"Plumber",`)],
      ["trailing comma", ld(`{"@type":"Plumber",}`)],
      ["empty script", ld("")],
      ["JSON null and scalar", ld("null") + ld(`"Plumber"`)],
      ["wrong script type", ld(`{"@type":"Plumber"}`, `type="application/json"`)],
      ["plain script", `<script>var s = {"@type":"Plumber"}</script>`],
      ["commented out", `<!-- ${ld(`{"@type":"Plumber"}`)} -->`],
      ["escaped in text", `<p>&lt;script type="application/ld+json"&gt;{"@type":"Plumber"}&lt;/script&gt;</p>`],
    ];
    it.each(no)("%s -> false", (_l, body) => expect(facts(body).hasLocalBusinessSchema).toBe(false));

    it("tolerates real-world JSON-LD wrappers and IRIs", () => {
      const j = `{"@type":"Plumber"}`;
      for (const body of [
        ld(j, `type="application/ld+json; charset=utf-8"`), ld(j, `type=" Application/LD+JSON ;charset=utf-8"`), ld(`\uFEFF  \n${j}\n `), ld(`<!-- ${j} -->`),
        ld(`//<![CDATA[\n${j}\n//]]>`), ld(`/*<![CDATA[*/${j}/*]]>*/`), ld(`/* generated */ ${j}`), ld(`// generated\n${j}`), ld(`{"@type":"http://schema.org/Plumber/"}`), ld(`{"@type":"https://schema.org/Plumber//"}`),
      ]) expect([body, facts(body).hasLocalBusinessSchema]).toEqual([body, true]);
      expect(facts(ld(`<!-- {"@type":"Organization"} -->`)).hasLocalBusinessSchema).toBe(false);
    });

    it("recognises microdata itemtype and RDFa typeof, ignoring non-business types", () => {
      for (const b of [`<div itemscope itemtype="https://schema.org/Plumber"></div>`, `<div itemscope itemtype="http://schema.org/Dentist/"></div>`,
        `<div ITEMSCOPE ITEMTYPE="https://schema.org/LocalBusiness"></div>`, `<div itemtype="https://schema.org/Thing https://schema.org/Restaurant"></div>`,
        `<div vocab="https://schema.org/" typeof="LocalBusiness"></div>`, `<div typeof="schema:Dentist"></div>`, `<div typeof="Person schema:Restaurant"></div>`])
        expect([b, facts(b).hasLocalBusinessSchema]).toEqual([b, true]);
      for (const b of [`<div itemscope itemtype="https://schema.org/Product"></div>`, `<div typeof="Product"></div>`, `<div typeof="schema:Organization"></div>`,
        `<p itemprop="Plumber">x</p>`, `<template><div itemtype="https://schema.org/Plumber"></div></template>`, `<!-- <div itemtype="https://schema.org/Plumber"></div> -->`,
        `<p>itemtype="https://schema.org/Plumber"</p>`])
        expect([b, facts(b).hasLocalBusinessSchema]).toEqual([b, false]);
    });

    it("never throws on huge or deeply nested JSON-LD", () => {
      const big = ld(`[${"0,".repeat(200_000)}0]`);
      expect(facts(big).hasLocalBusinessSchema).toBe(false);
      const wide = ld(`{${Array.from({ length: 300_000 }, (_, i) => `"k${i}":${i}`).join(",")}}`);
      expect(facts(wide).hasLocalBusinessSchema).toBe(false);
      const deepArr = ld("[".repeat(5000) + "]".repeat(5000));
      expect(facts(deepArr).hasLocalBusinessSchema).toBe(false);
      const deepObj = ld(`{"a":`.repeat(5000) + `{"@type":"Plumber"}` + "}".repeat(5000));
      expect(facts(deepObj).hasLocalBusinessSchema).toBe(true);
      expect(facts(ld(`[${"[],".repeat(200_000)}[]]`)).hasLocalBusinessSchema).toBe(false);
    });

    it("reads JSON-LD placed in the head", () => {
      expect(facts("<p>x</p>", "https://a.com/", ld(`{"@type":"Store"}`)).hasLocalBusinessSchema).toBe(true);
    });
  });

  describe("mixed content", () => {
    const body = [
      `<img src="http://a.com/a.png">`, `<IMG SRC="HTTP://a.com/b.png">`, `<script src="http://cdn.com/x.js"></script>`, `<iframe src="http://a.com/f"></iframe>`,
      `<video src="http://a.com/v.mp4"><source src="http://a.com/v.webm"></video>`, `<audio src="http://a.com/a.mp3"></audio>`,
      `<link rel="stylesheet" href="http://a.com/s.css">`, `<LINK REL="Stylesheet preload" HREF="http://a.com/t.css">`,
    ].join("");
    it("counts insecure subresources on an https page", () => expect(facts(body, "https://a.com/").mixedContentCount).toBe(9));
    it("is 0 on an http page", () => expect(facts(body, "http://a.com/").mixedContentCount).toBe(0));
    it("does not count plain links, secure or relative urls, or non-stylesheet links", () => {
      const f = facts(`<a href="http://other.com/">x</a><img src="https://a.com/a.png"><img src="//a.com/b.png"><img src="/c.png"><link rel="canonical" href="http://a.com/"><link rel="icon" href="http://a.com/f.ico"><form action="http://a.com/post"></form>`);
      expect(f.mixedContentCount).toBe(0);
    });
    it("does not count loopback hosts (dev leftovers are not mixed content a visitor can fix)", () => {
      const f = facts(`<img src="http://localhost/a.png"><img src="http://localhost:3000/a.png"><img src="http://127.0.0.1/a.png"><img src="http://[::1]:8080/a.png"><img src="HTTP://LOCALHOST/a.png">`);
      expect(f.mixedContentCount).toBe(0);
      expect(facts(`<img src="http://localhost.evil.com/a.png"><img src="http://localhost@evil.com/a.png">`).mixedContentCount).toBe(2);
    });
    it("ignores insecure urls inside comments, scripts and text", () => {
      expect(facts(`<!-- <img src="http://a.com/a.png"> --><script>document.write('<img src="http://a.com/b.png">')</script><p>&lt;img src="http://a.com/c.png"&gt;</p>`).mixedContentCount).toBe(0);
    });
  });

  describe("datedBuildMarkers", () => {
    const m = (body: string, head = "") => facts(body, "https://a.com/", head).datedBuildMarkers;
    const jq = (src: string) => `<script src="${src}"></script>`;

    it("is empty for a modern page", () => {
      const modern = extractPage(modernHtml, "https://brightdental.com/");
      expect(modern.datedBuildMarkers).toEqual([]);
      expect(m(`<div><h1>Hi</h1><p>text</p></div>`, jq("https://code.jquery.com/jquery-3.7.1.min.js"))).toEqual([]);
    });

    it("flags each legacy tag once, in lowercase or uppercase", () => {
      expect(m(`<font size=2>a</font><FONT>b</FONT><font>c</font>`)).toEqual(["old-style font tags"]);
      expect(m(`<marquee>a</marquee>`)).toEqual(["scrolling or blinking text"]);
      expect(m(`<BLINK>a</BLINK><marquee>b</marquee>`)).toEqual(["scrolling or blinking text"]);
      expect(m(`<center>a</center><CENTER>b</CENTER>`)).toEqual(["old-style centering tags"]);
      expect(extractPage(`<html><head><title>x</title></head><frameset cols="20%,80%"><frame src="a.html"><frame src="b.html"></frameset></html>`, "http://a.com/").datedBuildMarkers).toEqual(["frames"]);
      expect(extractPage(`<FRAMESET><FRAME SRC="a.html"></FRAMESET>`, "http://a.com/").datedBuildMarkers).toEqual(["frames"]);
    });

    it("a single <font> or <center> is not enough; two are; markup in templates does not count", () => {
      expect(m(`<center><img src="b.png" alt="BBB"></center>`)).toEqual([]);
      expect(m(`<font>a</font>`)).toEqual([]);
      expect(m(`<font>a</font><font>b</font><font>c</font>`)).toEqual(["old-style font tags"]);
      expect(m(`<center>a</center><center>b</center>`)).toEqual(["old-style centering tags"]);
      expect(m(`<template><center>a</center><center>b</center><marquee>x</marquee></template>`)).toEqual([]);
      expect(m(`<textarea><font>a</font><font>b</font><font>c</font><center>c</center></textarea>`)).toEqual([]);
      expect(m(`<center>a</center><template><center>b</center></template>`)).toEqual([]);
    });

    it("counts font tags per paste, not per nesting; needs three; ignores svg and nested centers", () => {
      const filler = `<p>${lorem}</p>`;
      expect(m(filler + `<p><font face="Arial"><font size="2">Call today</font></font></p>`)).toEqual([]);
      expect(m(filler + `<font>a</font><font>b</font>`)).toEqual([]);
      expect(m(filler + `<font>a</font><font>b</font><FONT>c</FONT>`)).toEqual(["old-style font tags"]);
      expect(m(filler + `<font><font>a</font></font><font>b</font><font><font><font>c</font></font></font>`)).toEqual(["old-style font tags"]);
      expect(m(filler + `<svg><font></font><font></font><font></font><font></font></svg>`)).toEqual([]);
      expect(m(filler + `<center><center>a</center></center>`)).toEqual([]);
      expect(m(filler + `<center><center>a</center></center><center>b</center>`)).toEqual(["old-style centering tags"]);
    });

    it("does not flag iframes, 'font' in text or css, or tags in comments and scripts", () => {
      expect(m(`<iframe src="/x"></iframe><p>font center marquee</p><span style="font-family: serif; text-align: center">x</span><!-- <font>x</font> --><script>document.write("<center><font>")</script>`)).toEqual([]);
    });

    it("detects Flash by src, data, type, classid and movie param", () => {
      for (const b of [`<embed src="a.SWF">`, `<embed src="a.swf?x=1">`, `<object data="a.swf"></object>`, `<EMBED TYPE="application/x-shockwave-flash">`,
        `<object classid="clsid:D27CDB6E-AE6D-11cf-96B8-444553540000"></object>`, `<object><param name="movie" value="a.swf"></object>`])
        expect(m(b)).toEqual(["Flash"]);
      expect(m(`<embed src="video.mp4"><object data="a.pdf" type="application/pdf"></object><a href="a.swf">x</a>`)).toEqual([]);
    });

    it("flags jQuery older than 1.12 only", () => {
      for (const s of ["/js/jquery-1.7.2.min.js", "https://ajax.googleapis.com/ajax/libs/jquery/1.8.3/jquery.min.js", "/js/jquery.1.9.1.js", "/jquery-1.11.3.js?v=2", "/js/jquery-1.4.min.js", "/JS/JQuery-1.7.2.MIN.js", "/jquery-0.9.js"])
        expect(m("", jq(s))).toEqual(["an outdated jQuery version"]);
      for (const s of ["/js/jquery-1.12.4.min.js", "/js/jquery-2.2.4.js", "/js/jquery-3.6.0.min.js", "https://cdnjs.cloudflare.com/ajax/libs/jquery/3.7.1/jquery.min.js",
        "/js/jquery.min.js", "/js/jquery-migrate-1.2.1.min.js", "/js/jquery-ui-1.8.24.min.js", "/js/jquery.cookie-1.4.1.js", "/assets/1.2/jquery.min.js", "/js/app-1.7.2.js", "/x.js?jquery-1.7.2.js"])
        expect(m("", jq(s))).toEqual([]);
    });

    const cell = (inner: string) => `<td>${inner}</td>`;
    it("flags a layout table: legacy attributes, 3+ cells with block content", () => {
      expect(m(`<table cellspacing="0" cellpadding="0"><tr>${cell(`<div><a href="/a">a</a></div>`)}${cell(`<p><a href="/b">b</a></p>`)}${cell(`<a href="/c"><img src=c.png alt=c></a>`)}</tr></table>`)).toEqual(["table-based page layout"]);
      expect(m(`<TABLE BGCOLOR="#fff"><TR>${cell("<H1>a</H1>")}${cell("b")}${cell("c")}</TR></TABLE>`)).toEqual(["table-based page layout"]);
    });

    it("does not flag data tables or tables lacking the layout signals", () => {
      const row = (c: string) => `<tr>${cell(c)}${cell(c)}${cell(c)}</tr>`;
      expect(m(`<table cellspacing="0"><tr><th>A</th><th>B</th><th>C</th></tr>${row("<p>x</p>")}</table>`)).toEqual([]);
      expect(m(`<table cellpadding="2"><caption>Prices</caption>${row("<div>x</div>")}</table>`)).toEqual([]);
      expect(m(`<table cellpadding="2"><thead><tr><td>A</td></tr></thead>${row("<div>x</div>")}</table>`)).toEqual([]);
      expect(m(`<div role="table"><table cellspacing="0">${row("<div>x</div>")}</table></div>`)).toEqual([]);
      expect(m(`<table role="grid" cellspacing="0">${row("<div>x</div>")}</table>`)).toEqual([]);
      expect(m(`<table>${row("<div>x</div>")}</table>`)).toEqual([]);
      expect(m(`<table cellspacing="0">${row("plain text")}</table>`)).toEqual([]);
      expect(m(`<table cellspacing="0"><tr>${cell("<div>a</div>")}${cell("<div>b</div>")}</tr></table>`)).toEqual([]);
      expect(m(`<table cellspacing="0"><tr><td>a</td></tr></table><div><p>x</p></div><div><p>y</p></div><div><p>z</p></div>`)).toEqual([]);
    });

    describe("layout tables must be structural", () => {
      const prose = `<h1>Ace Plumbing</h1><p>${lorem}</p><p>${lorem}</p>`;
      const tr = (...c: string[]) => `<tr>${c.map(cell).join("")}</tr>`;
      const hours = `<table cellpadding="4">${tr("<p>Mon</p>", "<p>9-5</p>", "<p>Tue</p>", "<p>9-5</p>")}${tr("<p>Wed</p>", "<p>9-5</p>", "<p>Thu</p>", "<p>9-5</p>")}</table>`;
      it("business hours, pricing, badge and newsletter tables inside a normal page do not flag", () => {
        expect(m(prose + hours)).toEqual([]);
        expect(m(prose + `<table cellspacing="0" cellpadding="6">${tr("<div>Basic</div>", "<div>Pro</div>", "<div>Team</div>")}${tr("<p>$10</p>", "<p>$20</p>", "<p>$30</p>")}</table>`)).toEqual([]);
        expect(m(prose + `<table cellpadding="4">${tr(`<img src="bbb.png" alt="BBB">`, `<img src="a.png" alt="A+">`, `<img src="y.png" alt="Yelp">`)}</table>`)).toEqual([]);
        expect(m(`<table cellpadding="4">${tr(`<img src="bbb.png" alt="BBB">`, `<img src="a.png" alt="A+">`, `<img src="y.png" alt="Yelp">`)}</table>`)).toEqual([]);
        expect(m(prose + `<table bgcolor="#eee" cellpadding="8"><tr><td><div>Join our newsletter</div></td><td><div><input name="email"></div></td><td><div><input type="submit"></div></td></tr></table>`)).toEqual([]);
      });
      // Thin pages: no long prose to dilute the table, so only "wraps the navigation or the main heading" separates layout from content tables.
      const doc = (body: string) => extractPage(`<!doctype html>\n<html><head><title>Acme</title></head><body>${body}</body></html>`, "https://a.com/").datedBuildMarkers;
      const nav = `<nav><a href="/">Home</a> <a href="/menu">Menu</a> <a href="/contact">Contact</a></nav>`;
      it("thin pages whose only legacy-attribute table is a menu, hours, pricing or pasted table do not flag", () => {
        const row = (...c: string[]) => `<tr>${c.map((x) => `<td><p>${x}</p></td>`).join("")}</tr>`;
        expect(doc(`<header>${nav}</header><h1>Our Menu</h1><p>Fresh and local.</p><table cellpadding="6">${row("Margherita", "Tomato, basil", "$14")}${row("Pepperoni", "Tomato, pepperoni", "$16")}${row("Tiramisu", "Mascarpone", "$8")}</table>`)).toEqual([]);
        expect(doc(`<h1>Contact</h1><p>Call 208-555-0134.</p><table cellpadding="0" cellspacing="0"><tbody>${row("Monday", "8-5")}${row("Tuesday", "8-5")}${row("Wednesday", "8-5")}</tbody></table>`)).toEqual([]);
        expect(doc(`<nav><a>Home</a><a>Pricing</a></nav><h1>Pricing</h1><p>Simple plans.</p><table cellpadding="10"><tr><td><h3>Basic</h3><p>$29</p></td><td><h3>Pro</h3><p>$79</p></td><td><h3>Business</h3><p>$199</p></td></tr></table>`)).toEqual([]);
        expect(doc(`<h1>Blog</h1><table cellspacing="0"><tr><td><p>${"Long pasted paragraph. ".repeat(30)}</p></td><td><p>x</p></td><td><p>y</p></td></tr></table>`)).toEqual([]);
        expect(doc(`<table cellpadding="8"><tr><td><p>Basic plan</p></td><td><p>Pro plan</p></td><td><p>Enterprise</p></td></tr></table>`)).toEqual([]);
        expect(doc(`<table cellpadding="8"><tbody><tr><td><p>Basic plan</p></td><td><p>Pro plan</p></td><td><p>Enterprise</p></td></tr></tbody></table>`)).toEqual([]);
      });
      it("a 1990s page built from nested layout tables flags, in lower and upper case", () => {
        const nineties = `<html><head><title>Bob's Plumbing</title></head><body bgcolor="#ffffff"><table width="760" border="0" cellspacing="0" cellpadding="0" align="center"><tr><td colspan="2"><img src="header.gif" width="760" height="120"></td></tr>`
          + `<tr><td width="160" valign="top" bgcolor="#003366"><p><a href="index.html">Home</a><br><a href="services.html">Services</a><br><a href="contact.html">Contact</a></p></td><td width="600" valign="top"><h1>Welcome to Bob's Plumbing</h1>`
          + `<p>Serving the valley since 1978. We do residential and commercial plumbing, drain cleaning and water heaters. Call us today for a free estimate.</p><table width="100%" cellpadding="4"><tr><td><p>Licensed</p></td><td><p>Bonded</p></td><td><p>Insured</p></td></tr></table></td></tr>`
          + `<tr><td colspan="2"><p>Copyright 2003 Bob's Plumbing</p></td></tr></table></body></html>`;
        for (const h of [nineties, `<!DOCTYPE HTML PUBLIC "-//W3C//DTD HTML 4.01//EN">` + nineties, nineties.toUpperCase()])
          expect(extractPage(h, "http://a.com/").datedBuildMarkers).toEqual(["table-based page layout"]);
      });
      it("a classic page whose content lives in one nested layout table still flags", () => {
        const body = `<table width="100%" cellspacing="0" cellpadding="0"><tr><td colspan="3"><h1>Ace Plumbing</h1></td></tr><tr><td><p>${lorem}</p></td><td>`
          + `<table cellpadding="5"><tr>${cell(`<p>${lorem}</p>`)}${cell(`<p>${lorem}</p>`)}${cell(`<div>${lorem}</div>`)}</tr></table></td><td><p>Links</p></td></tr></table><p>Copyright</p>`;
        expect(m(body)).toEqual(["table-based page layout"]);
      });
    });

    it("de-duplicates and reports several markers", () => {
      expect(m(`<center><font>a</font></center><center>b</center><font>d</font><font>e</font><marquee>c</marquee>`, jq("/jquery-1.7.2.js"))).toEqual([
        "old-style font tags", "scrolling or blinking text", "old-style centering tags", "an outdated jQuery version",
      ]);
    });
  });

  describe("isLikelyJsRendered", () => {
    const spa = (body: string, head = "") => facts(body, "https://a.com/", head).isLikelyJsRendered;
    const gen = (c: string) => `<meta name="generator" content="${c}">`;

    it("true for an SPA shell: short text with a mount node", () => {
      expect(spa(`<div id="root"></div><script src="/bundle.js"></script>`)).toBe(true);
      for (const mount of [`<div id="app"></div>`, `<div id="__next"></div>`, `<div id="___gatsby"></div>`, `<app-root></app-root>`, `<APP-ROOT>Loading</APP-ROOT>`, `<body ng-app="x"></body>`, `<div ng-app></div>`])
        expect(spa(mount + `<script src="/b.js"></script>`)).toBe(true);
    });
    it("recognises Nuxt, Ember, Svelte and Quasar shells and a script-only shell", () => {
      for (const b of [`<div id="__nuxt"></div>`, `<div id="ember-app"></div>`, `<div id="svelte"></div>`, `<div id="q-app"></div>`])
        expect(spa(b)).toBe(true);
      expect(spa(`<div style="display: contents"></div><script type="module" src="/_app/start.js"></script>`)).toBe(true);
      expect(spa(`<div style="display: contents"><script type="module">import("/_app/start.js")</script></div>`)).toBe(true);
      expect(spa(`<p></p>`, `<script type="module" crossorigin src="/assets/index.js"></script>`)).toBe(true);
    });
    it("a script alone is not a shell when the page has real text or a heading", () => {
      expect(spa(`<p>${lorem}</p><script src="/b.js"></script>`)).toBe(false);
      expect(spa(`<h1>Closed for the season</h1><script src="/b.js"></script>`)).toBe(false);
      expect(spa(`<p>Hi</p><script>var a = 1</script>`)).toBe(false);
    });
    it("a mount node with plenty of server-rendered text is not JS-rendered", () => {
      expect(spa(`<div id="root"><p>${lorem}</p></div>`)).toBe(false);
      expect(spa(`<div id="app"><p>${lorem}</p></div><script src="/b.js"></script>`)).toBe(false);
    });
    it("short text without a mount node is not flagged", () => {
      expect(spa(`<p>Hello</p>`)).toBe(false);
      expect(spa(`<div id="main"></div><div class="root app"></div>`)).toBe(false);
    });
    it("script contents do not count as visible text", () => {
      expect(spa(`<div id="root"></div><script>var s = "${lorem}";</script><style>.a{content:"${lorem}"}</style>`)).toBe(true);
    });
    it("true for wix, squarespace and webflow regardless of text", () => {
      for (const g of ["Wix.com Website Builder", "Squarespace", "Webflow"]) expect(spa(`<p>${lorem}</p>`, gen(g))).toBe(true);
      expect(spa(`<p>${lorem}</p>`, `<script src="https://static.parastorage.com/x.js"></script>`)).toBe(true);
    });
    it("false for a normal static page and for shopify / wordpress", () => {
      expect(extractPage(modernHtml, "https://brightdental.com/").isLikelyJsRendered).toBe(false);
      expect(spa(`<p>${lorem}</p>`)).toBe(false);
      expect(spa(`<p>Hi</p>`, gen("Shopify"))).toBe(false);
      expect(spa(`<p>Hi</p>`, gen("WordPress 6.4"))).toBe(false);
    });
  });

  it("does not take long on hostile pages of unclosed tags", () => {
    for (const frag of ["<img", `<script type="application/ld+json"`, "<table cellspacing=1><td>", "<font ", `<a href="tel:`, `<link rel="stylesheet" href="http://`, "<section><h1><b>", "<table cellpadding=1><td><center>"]) {
      const t = Date.now();
      extractPage("<html><body>" + frag.repeat(10_000), "https://a.com/");
      expect(Date.now() - t).toBeLessThan(1000);
    }
  });

  it("stays fast on a large JSON-LD page", () => {
    const html = page(`<p>${"word ".repeat(100_000)}</p>${ld(`{"@graph":[${'{"@type":"WebSite","name":"x"},'.repeat(5000)}{"@type":"Plumber"}]}`)}`);
    const t = Date.now();
    expect(extractPage(html, "https://a.com/").hasLocalBusinessSchema).toBe(true);
    expect(Date.now() - t).toBeLessThan(1000);
  });
});
