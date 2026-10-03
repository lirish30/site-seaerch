import { describe, it, expect } from "vitest";
import { crawlSite, type Fetcher } from "../src/worker/crawler/crawl";

const now = new Date("2026-10-02T00:00:00Z");
const html = (body: string, head = "") => `<html><head>${head}</head><body>${body}</body></html>`;

function fakeFetch(routes: Record<string, { status?: number; body?: string; type?: string; throws?: boolean; redirect?: string }>): Fetcher {
  return async (url) => {
    const r = routes[url];
    if (!r) return new Response("nf", { status: 404, headers: { "content-type": "text/html" } });
    if (r.throws) throw new Error("connect timeout");
    const res = new Response(r.body ?? "", { status: r.status ?? 200, headers: { "content-type": r.type ?? "text/html" } });
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

  it("403 bot block → unreachable", async () => {
    const r = await crawlSite("https://blocked.com", opts(fakeFetch({ "https://blocked.com/": { status: 403, body: "Just a moment..." } })));
    expect(r.siteStatus).toBe("unreachable");
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
});
