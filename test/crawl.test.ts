import { describe, it, expect } from "vitest";
import { crawlSite, type Fetcher } from "../src/worker/crawler/crawl";

const now = new Date("2026-10-02T00:00:00Z");
const html = (body: string, head = "") => `<html><head>${head}</head><body>${body}</body></html>`;

function fakeFetch(routes: Record<string, { status?: number; body?: string; type?: string; throws?: boolean; redirect?: string; location?: string }>): Fetcher {
  return async (url) => {
    const r = routes[url];
    if (!r) return new Response("nf", { status: 404, headers: { "content-type": "text/html" } });
    if (r.throws) throw new Error("connect timeout");
    const res = new Response(r.body ?? "", { status: r.status ?? 200, headers: { "content-type": r.type ?? "text/html", ...(r.location ? { location: r.location } : {}) } });
    if (r.redirect) Object.defineProperty(res, "url", { value: r.redirect });
    return res;
  };
}
const opts = (f: Fetcher) => ({ fetch: f, userAgent: "test", now, timeoutMs: 1000, maxPages: 6 });

describe("crawlSite", () => {
  it("null website → no_website", async () => {
    const r = await crawlSite(null, opts(fakeFetch({})));
    expect(r.siteStatus).toBe("no_website");
  });

  it("facebook/yelp listing URL → no_website without fetching", async () => {
    let called = false;
    const r = await crawlSite("https://www.facebook.com/aceplumbing", opts(async () => { called = true; return new Response(""); }));
    expect(r.siteStatus).toBe("no_website");
    expect(called).toBe(false);
  });

  it("network error → unreachable with error message", async () => {
    const r = await crawlSite("https://dead.com", opts(fakeFetch({ "https://dead.com/": { throws: true } })));
    expect(r.siteStatus).toBe("unreachable");
    expect(r.error).toMatch(/timeout/);
  });

  // Ruling H: bot protection is "blocked", not "your site didn't load".
  it.each([401, 403, 429, 503])("homepage %i → blocked, keeps the URL for PageSpeed", async (status) => {
    const r = await crawlSite("https://blocked.com", opts(fakeFetch({ "https://blocked.com/": { status, body: "Just a moment..." } })));
    expect(r.siteStatus).toBe("blocked");
    expect(r.finalUrl).toBe("https://blocked.com/");
    expect(r.facts).toBeNull();
  });

  it("200 JS-challenge page → blocked", async () => {
    const r = await crawlSite("https://chal.com", opts(fakeFetch({ "https://chal.com/": {
      body: html("<div id='cf-browser-verification'>Checking your browser</div>", "<title>Just a moment...</title>") } })));
    expect(r.siteStatus).toBe("blocked");
    expect(r.finalUrl).toBe("https://chal.com/");
  });

  it("200 'Attention Required' page → blocked", async () => {
    const r = await crawlSite("https://att.com", opts(fakeFetch({ "https://att.com/": {
      body: html("<p>Sorry, you have been blocked</p>", "<title>Attention Required! | Cloudflare</title>") } })));
    expect(r.siteStatus).toBe("blocked");
  });

  it("a normal page that merely embeds reCAPTCHA on its form stays ok", async () => {
    const r = await crawlSite("https://rc.com", opts(fakeFetch({ "https://rc.com/": {
      body: html("<form><input name='email'><textarea></textarea><div class='g-recaptcha'></div></form>", "<title>RC Plumbing</title>") } })));
    expect(r.siteStatus).toBe("ok");
  });

  it("missing content-type → blocked", async () => {
    const r = await crawlSite("https://noct.com", opts(async () => new Response(new TextEncoder().encode("<html></html>"), { status: 200 })));
    expect(r.siteStatus).toBe("blocked");
  });

  it("404, 410 and 500 → unreachable", async () => {
    for (const status of [404, 410, 500]) {
      const r = await crawlSite("https://gone.com", opts(fakeFetch({ "https://gone.com/": { status } })));
      expect(r.siteStatus).toBe("unreachable");
    }
  });

  it("non-HTML homepage → unreachable", async () => {
    const r = await crawlSite("https://pdf.com", opts(fakeFetch({ "https://pdf.com/": { type: "application/pdf", body: "%PDF" } })));
    expect(r.siteStatus).toBe("unreachable");
  });

  it("parked page → parked", async () => {
    const r = await crawlSite("https://p.com", opts(fakeFetch({ "https://p.com/": { body: html("<h1>Buy this domain</h1>") } })));
    expect(r.siteStatus).toBe("parked");
  });

  it("bare domain gets https:// and crawls linked contact page; merges facts and contacts", async () => {
    const r = await crawlSite("ace.com", opts(fakeFetch({
      "https://ace.com/": { body: html(`<a href="/contact">Contact</a><a href="/gone">x</a><a href="/gone2">x</a><a href="/gone3">x</a><p>© 2020 Ace</p><p>Call (208) 555-0134</p>`, "<title>Ace</title>") },
      "https://ace.com/contact": { body: html(`<form><input name="email"><textarea></textarea></form><a href="mailto:info@ace.com">mail</a>`) },
    })));
    expect(r.siteStatus).toBe("ok");
    expect(r.facts!.https).toBe(true);
    expect(r.facts!.copyrightYear).toBe(2020);
    expect(r.facts!.hasContactForm).toBe(true);
    expect(r.facts!.emailCount).toBe(1);
    expect(r.facts!.hasViewport).toBe(false);
    expect(r.contacts.find((c) => c.type === "email")!.value).toBe("info@ace.com");
    expect(r.contacts.find((c) => c.type === "form")!.value).toBe("https://ace.com/contact");
    expect(r.contacts.some((c) => c.type === "phone")).toBe(true);
  });

  it("counts broken internal links from homepage via HEAD/GET status", async () => {
    const r = await crawlSite("https://ace.com", opts(fakeFetch({
      "https://ace.com/": { body: html(`<a href="/a">a</a><a href="/b">b</a><a href="/c">c</a>`) },
    })));
    expect(r.facts!.brokenLinkCount).toBe(3);
  });

  it("reports the homepage platform in facts", async () => {
    const r = await crawlSite("https://ace.com", opts(fakeFetch({
      "https://ace.com/": { body: html("", `<meta name="generator" content="Squarespace">`) },
    })));
    expect(r.facts!.platform).toBe("squarespace");
    const o = await crawlSite("https://plain.com", opts(fakeFetch({ "https://plain.com/": { body: html("hi") } })));
    expect(o.facts!.platform).toBe("other");
  });

  it("http-only site → https false", async () => {
    const r = await crawlSite("http://old.com", opts(fakeFetch({
      "https://old.com/": { throws: true },
      "http://old.com/": { body: html("<p>hi</p>") },
    })));
    expect(r.siteStatus).toBe("ok");
    expect(r.facts!.https).toBe(false);
  });

  it("latestContentDate ignores future dates; pastEventDates only past", async () => {
    const r = await crawlSite("https://ev.com", opts(fakeFetch({
      "https://ev.com/": { body: html(`<p>Posted January 5, 2024</p><p>Posted December 1, 2030</p><h3>Events</h3><p>May 1, 2025</p><p>Dec 1, 2026</p>`) },
    })));
    expect(r.facts!.latestContentDate).toBe("2025-05-01");
    expect(r.facts!.pastEventDates).toEqual(["2025-05-01"]);
  });

  it("redirect landing on a social page → no_website", async () => {
    const r = await crawlSite("https://short.com", opts(fakeFetch({
      "https://short.com/": { body: html("<p>x</p>"), redirect: "https://www.facebook.com/x" },
    })));
    expect(r.siteStatus).toBe("no_website");
  });

  const stalled = () => new Response(new ReadableStream({ start() { /* never closes */ } }), { status: 200, headers: { "content-type": "text/html" } });

  it("homepage body that stalls after headers → unreachable with timeout error", async () => {
    const r = await crawlSite("https://tarpit.com", { ...opts(async () => stalled()), timeoutMs: 50 });
    expect(r.siteStatus).toBe("unreachable");
    expect(r.error).toMatch(/timeout/);
  });

  it("sub-page body that stalls is skipped", async () => {
    const f: Fetcher = async (url) => url.endsWith("/contact") ? stalled()
      : new Response(html(`<a href="/contact">Contact</a>`), { status: 200, headers: { "content-type": "text/html" } });
    const r = await crawlSite("https://ok.com", { ...opts(f), timeoutMs: 50 });
    expect(r.siteStatus).toBe("ok");
    expect(r.pages).toHaveLength(1);
  });

  describe("site-level checks", () => {
    const home = { "https://s.com/": { body: html("<p>hi</p>", "<title>S</title>") } };
    const crawl = (extra: Parameters<typeof fakeFetch>[0]) => crawlSite("https://s.com", opts(fakeFetch({ ...home, ...extra })));

    it("robots.txt present (text/plain) → true; absent (404) → false", async () => {
      expect((await crawl({ "https://s.com/robots.txt": { type: "text/plain", body: "User-agent: *\nDisallow:" } })).facts!.hasRobotsTxt).toBe(true);
      expect((await crawl({ "https://s.com/robots.txt": { status: 404 } })).facts!.hasRobotsTxt).toBe(false);
      expect((await crawl({ "https://s.com/robots.txt": { status: 410 } })).facts!.hasRobotsTxt).toBe(false);
    });

    it("robots.txt soft-404 serving HTML → false; error or other status → null", async () => {
      expect((await crawl({ "https://s.com/robots.txt": { body: html("<p>home</p>") } })).facts!.hasRobotsTxt).toBe(false);
      expect((await crawl({ "https://s.com/robots.txt": { throws: true } })).facts!.hasRobotsTxt).toBeNull();
      expect((await crawl({ "https://s.com/robots.txt": { status: 500 } })).facts!.hasRobotsTxt).toBeNull();
      expect((await crawl({ "https://s.com/robots.txt": { status: 403 } })).facts!.hasRobotsTxt).toBeNull();
    });

    it("sitemap.xml present (xml or text/plain) → true; absent or HTML soft-404 → false; error → null", async () => {
      expect((await crawl({ "https://s.com/sitemap.xml": { type: "application/xml", body: "<urlset/>" } })).facts!.hasSitemap).toBe(true);
      expect((await crawl({ "https://s.com/sitemap.xml": { type: "text/xml", body: "<urlset/>" } })).facts!.hasSitemap).toBe(true);
      expect((await crawl({ "https://s.com/sitemap.xml": { type: "text/plain", body: "x" } })).facts!.hasSitemap).toBe(true);
      expect((await crawl({ "https://s.com/sitemap.xml": { status: 404 } })).facts!.hasSitemap).toBe(false);
      expect((await crawl({ "https://s.com/sitemap.xml": { body: html("<p>home</p>") } })).facts!.hasSitemap).toBe(false);
      expect((await crawl({ "https://s.com/sitemap.xml": { throws: true } })).facts!.hasSitemap).toBeNull();
      expect((await crawl({ "https://s.com/sitemap.xml": { status: 500 } })).facts!.hasSitemap).toBeNull();
    });

    it("sitemap declared only in robots.txt (any case) → true, even when /sitemap.xml is missing or errors", async () => {
      const robots = { type: "text/plain", body: "User-agent: *\nsitemap: https://s.com/wp-sitemap.xml" };
      expect((await crawl({ "https://s.com/robots.txt": robots, "https://s.com/sitemap.xml": { status: 404 } })).facts!.hasSitemap).toBe(true);
      expect((await crawl({ "https://s.com/robots.txt": robots, "https://s.com/sitemap.xml": { throws: true } })).facts!.hasSitemap).toBe(true);
      expect((await crawl({ "https://s.com/robots.txt": { type: "text/plain", body: "User-agent: *" }, "https://s.com/sitemap.xml": { status: 404 } })).facts!.hasSitemap).toBe(false);
    });

    it("http:// version: 301 to https → true; 200 HTML → false; error or odd status → null", async () => {
      expect((await crawl({ "http://s.com/": { status: 301, location: "https://s.com/" } })).facts!.httpRedirectsToHttps).toBe(true);
      expect((await crawl({ "http://s.com/": { status: 308, location: "https://www.s.com/" } })).facts!.httpRedirectsToHttps).toBe(true);
      expect((await crawl({ "http://s.com/": { status: 302, location: "//s.com/" } })).facts!.httpRedirectsToHttps).toBeNull(); // protocol-relative inherits http
      expect((await crawl({ "http://s.com/": { status: 301, location: "/home" } })).facts!.httpRedirectsToHttps).toBeNull();
      expect((await crawl({ "http://s.com/": { body: html("<p>insecure copy</p>") } })).facts!.httpRedirectsToHttps).toBe(false);
      expect((await crawl({ "http://s.com/": { throws: true } })).facts!.httpRedirectsToHttps).toBeNull();
      expect((await crawl({ "http://s.com/": { status: 301, location: "http://www.s.com/" } })).facts!.httpRedirectsToHttps).toBeNull();
      expect((await crawl({ "http://s.com/": { status: 500 } })).facts!.httpRedirectsToHttps).toBeNull();
      expect((await crawl({ "http://s.com/": { body: html("", `<meta http-equiv="refresh" content="0;url=https://s.com/">`) } })).facts!.httpRedirectsToHttps).toBeNull();
    });

    it("the http:// probe uses redirect: manual; other requests still follow", async () => {
      const seen: Record<string, string | undefined> = {};
      const f: Fetcher = async (url, init) => { seen[url] = init?.redirect; return new Response(url === "https://s.com/" ? html("hi") : "", { status: url.startsWith("http://") ? 301 : 200, headers: { "content-type": "text/html", location: "https://s.com/" } }); };
      await crawlSite("https://s.com", opts(f));
      expect(seen["http://s.com/"]).toBe("manual");
      expect(seen["https://s.com/"]).toBe("follow");
      expect(seen["https://s.com/robots.txt"]).toBe("follow");
    });

    it("http-only homepage: no redirect probe (null), robots/sitemap still checked", async () => {
      const r = await crawlSite("http://old.com", opts(fakeFetch({
        "https://old.com/": { throws: true }, "http://old.com/": { body: html("<p>hi</p>") },
        "http://old.com/robots.txt": { type: "text/plain", body: "User-agent: *" },
      })));
      expect(r.facts!.httpRedirectsToHttps).toBeNull();
      expect(r.facts!.hasRobotsTxt).toBe(true);
    });

    it("a throwing or stalled site-level fetch never fails the crawl", async () => {
      const f: Fetcher = async (url) => {
        if (/robots\.txt|sitemap\.xml|^http:/.test(url)) throw new Error("boom");
        return new Response(html("<p>hi</p>"), { status: 200, headers: { "content-type": "text/html" } });
      };
      const r = await crawlSite("https://s.com", opts(f));
      expect(r.siteStatus).toBe("ok");
      expect(r.facts).toMatchObject({ hasRobotsTxt: null, hasSitemap: null, httpRedirectsToHttps: null });
      const stall: Fetcher = async (url) => /robots\.txt/.test(url) ? new Promise<Response>(() => {}) : new Response(html("<p>hi</p>"), { status: 200, headers: { "content-type": "text/html" } });
      const r2 = await crawlSite("https://s.com", { ...opts(stall), timeoutMs: 50 });
      expect(r2.siteStatus).toBe("ok");
      expect(r2.facts!.hasRobotsTxt).toBeNull();
    });

    // Unreachable sites legitimately get one http:// request: the crawler's own homepage fallback.
    it.each([
      ["blocked", { "https://s.com/": { status: 403, body: "no" } }, 0],
      ["parked", { "https://s.com/": { body: html("<h1>Buy this domain</h1>") } }, 0],
      ["unreachable", { "https://s.com/": { throws: true } }, 1],
    ])("skips all site-level fetches for %s sites", async (_n, routes, httpCalls) => {
      const urls: string[] = [];
      const inner = fakeFetch(routes as Parameters<typeof fakeFetch>[0]);
      const r = await crawlSite("https://s.com", opts(async (u, i) => { urls.push(u); return inner(u, i); }));
      expect(r.facts).toBeNull();
      expect(urls.filter((u) => /robots|sitemap/.test(u))).toEqual([]);
      expect(urls.filter((u) => u.startsWith("http://"))).toHaveLength(httpCalls);
    });

    it("no_website makes no requests", async () => {
      let n = 0;
      await crawlSite(null, opts(async () => { n++; return new Response(""); }));
      await crawlSite("https://www.facebook.com/x", opts(async () => { n++; return new Response(""); }));
      expect(n).toBe(0);
    });
  });

  describe("page facts in CrawlFacts", () => {
    it("hasPhone / hasTelLink / hasLocalBusinessSchema aggregate across crawled pages; homepage facts come from the homepage", async () => {
      const r = await crawlSite("https://a.com", opts(fakeFetch({
        "https://a.com/": { body: html(`<a href="/contact">Contact</a><h1>Ace</h1><p>Hello</p>`) },
        "https://a.com/contact": { body: html(`<p>Call (208) 555-0134</p><a href="tel:+12085550134">call</a>
          <script type="application/ld+json">{"@context":"https://schema.org","@type":"Plumber","name":"Ace"}</script>`) },
      })));
      expect(r.facts).toMatchObject({ hasPhone: true, hasTelLink: true, hasLocalBusinessSchema: true, h1Count: 1 });
      const none = await crawlSite("https://b.com", opts(fakeFetch({ "https://b.com/": { body: html(`<p>Hello</p>`) } })));
      expect(none.facts).toMatchObject({ hasPhone: false, hasTelLink: false, hasLocalBusinessSchema: false, h1Count: 0, imageCount: 0, mixedContentCount: 0, datedBuildMarkers: [] });
    });

    it("image, mixed-content and dated-build facts come from the homepage", async () => {
      const r = await crawlSite("https://a.com", opts(fakeFetch({
        "https://a.com/": { body: html(`<img src="a.jpg"><img src="b.jpg" alt="b"><img src="http://a.com/c.jpg" alt="c"><marquee>hi</marquee><marquee>x</marquee>`) },
      })));
      expect(r.facts).toMatchObject({ imageCount: 3, imagesMissingAlt: 1, mixedContentCount: 1 });
      expect(r.facts!.datedBuildMarkers.length).toBeGreaterThan(0);
      expect(new Set(r.facts!.datedBuildMarkers).size).toBe(r.facts!.datedBuildMarkers.length);
    });

    it("a JS-rendered shell yields isLikelyJsRendered; a normal page does not", async () => {
      const spa = await crawlSite("https://spa.com", opts(fakeFetch({ "https://spa.com/": { body: html(`<div id="root"></div><script src="/app.js"></script>`) } })));
      expect(spa.facts!.isLikelyJsRendered).toBe(true);
      const text = "word ".repeat(300);
      const ok = await crawlSite("https://ok.com", opts(fakeFetch({ "https://ok.com/": { body: html(`<h1>Hi</h1><p>${text}</p>`) } })));
      expect(ok.facts!.isLikelyJsRendered).toBe(false);
    });
  });
});
