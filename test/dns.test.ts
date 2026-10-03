import { describe, it, expect, vi } from "vitest";
import { DNS_TIMEOUT_MS, HOSTED_SUFFIXES, UNKNOWN_MAIL_DNS, lookupMailDns, siteMailDomain } from "../src/worker/dns";
import type { Fetcher } from "../src/worker/crawler/crawl";

type Ans = { type: number; data: string };
type Reply = { Status: number; Answer?: Ans[] } | Response | "throw" | "hang";
const MX = (data = "10 mx.example.com.") => ({ type: 15, data });
const TXT = (data: string) => ({ type: 16, data });

// Fake DoH: replies are keyed by "<name>/<TYPE>"; unlisted queries answer Status 0 with no Answer.
function doh(replies: Record<string, Reply>) {
  const calls: { url: string; init?: RequestInit }[] = [];
  const fetch: Fetcher = async (url, init) => {
    calls.push({ url, init });
    const u = new URL(url);
    const r = replies[`${u.searchParams.get("name")}/${u.searchParams.get("type")}`] ?? { Status: 0 };
    if (r === "throw") throw new Error("network down");
    if (r === "hang") return new Promise<Response>(() => {});
    return r instanceof Response ? r : Response.json(r);
  };
  return { fetch, calls };
}
const look = (d: string, replies: Record<string, Reply>) => lookupMailDns(d, doh(replies).fetch, 50);

describe("lookupMailDns MX", () => {
  it("true when an MX answer exists", async () => {
    expect((await look("example.com", { "example.com/MX": { Status: 0, Answer: [MX()] } })).hasMx).toBe(true);
  });
  it("false for Status 0 with no Answer, and for NXDOMAIN", async () => {
    expect((await look("example.com", {})).hasMx).toBe(false);
    expect((await look("example.com", { "example.com/MX": { Status: 3 } })).hasMx).toBe(false);
  });
  it("false when the answers hold no MX type (e.g. only a CNAME)", async () => {
    expect((await look("example.com", { "example.com/MX": { Status: 0, Answer: [{ type: 5, data: "x.example.net." }] } })).hasMx).toBe(false);
  });
  it("null for SERVFAIL, throw, timeout, non-200, malformed JSON", async () => {
    for (const r of [{ Status: 2 }, "throw", "hang", new Response("nope", { status: 500 }), new Response("{\"Status\":0,\"Ans"),
      new Response("[]"), new Response("null"), Response.json({ Status: 0, Answer: "x" })] as Reply[])
      expect((await look("example.com", { "example.com/MX": r })).hasMx).toBeNull();
  });
  it("a failed MX lookup does not affect SPF and vice versa", async () => {
    const r = await look("example.com", { "example.com/MX": "throw", "example.com/TXT": { Status: 0, Answer: [TXT("\"v=spf1 -all\"")] } });
    expect(r).toEqual({ hasMx: null, hasSpf: true });
  });
});

describe("lookupMailDns SPF", () => {
  const spf = (...a: string[]) => look("example.com", { "example.com/TXT": { Status: 0, Answer: a.map(TXT) } });
  it("true for plain, quoted, split-chunk and uppercase records", async () => {
    for (const d of ["v=spf1 include:_spf.google.com ~all", "\"v=spf1 include:_spf.google.com ~all\"", "\"v=spf1 include:_spf.goo\" \"gle.com ~all\"",
      "\"V=SPF1 -all\"", "  \"v=spf1\"  ", "\"v=spf1\" \" -all\""])
      expect((await spf(d)).hasSpf, d).toBe(true);
  });
  it("false for TXT answers that are not SPF, or none at all", async () => {
    expect((await spf("\"google-site-verification=abc\"", "\"v=DKIM1; k=rsa\"", "\"v=spf10 x\"")).hasSpf).toBe(false);
    expect((await spf()).hasSpf).toBe(false);
    expect((await look("example.com", { "example.com/TXT": { Status: 3 } })).hasSpf).toBe(false);
  });
  it("ignores a non-TXT answer that looks like SPF", async () => {
    expect((await look("example.com", { "example.com/TXT": { Status: 0, Answer: [{ type: 5, data: "v=spf1 -all" }] } })).hasSpf).toBe(false);
  });
  it("null when the TXT lookup fails", async () => {
    expect((await look("example.com", { "example.com/TXT": { Status: 2 } })).hasSpf).toBeNull();
  });
});

describe("lookupMailDns queries only the given name", () => {
  it("a subdomain is not widened to its parent: parent MX/SPF do not count", async () => {
    const r = await look("shop.example.com", { "example.com/MX": { Status: 0, Answer: [MX()] }, "example.com/TXT": { Status: 0, Answer: [TXT("\"v=spf1 -all\"")] } });
    expect(r).toEqual({ hasMx: false, hasSpf: false });
  });
  it("a subdomain's own MX and SPF count", async () => {
    const r = await look("shop.example.com", { "shop.example.com/MX": { Status: 0, Answer: [MX()] }, "shop.example.com/TXT": { Status: 0, Answer: [TXT("\"v=spf1 -all\"")] } });
    expect(r).toEqual({ hasMx: true, hasSpf: true });
  });
  it("sends exactly one MX and one TXT query, for the name given", async () => {
    for (const name of ["example.com", "a.b.example.com"]) {
      const d = doh({}); await lookupMailDns(name, d.fetch);
      expect(d.calls.map((c) => new URL(c.url).searchParams.get("name"))).toEqual([name, name]);
    }
  });
});

describe("lookupMailDns edge responses", () => {
  it("a null MX (RFC 7505, \"0 .\") means the domain takes no mail: hasMx false", async () => {
    expect((await look("example.com", { "example.com/MX": { Status: 0, Answer: [MX("0 .")] } })).hasMx).toBe(false);
    expect((await look("example.com", { "example.com/MX": { Status: 0, Answer: [MX(" 0   . ")] } })).hasMx).toBe(false);
  });
  it("a real MX next to a null MX still counts, and a root-looking host is not a null MX", async () => {
    expect((await look("example.com", { "example.com/MX": { Status: 0, Answer: [MX("0 ."), MX("10 mx.example.com.")] } })).hasMx).toBe(true);
    expect((await look("example.com", { "example.com/MX": { Status: 0, Answer: [MX("0 mx.example.com.")] } })).hasMx).toBe(true);
  });
  it("a truncated reply (TC) is unknown, not a clean \"none\"", async () => {
    const tc = { Status: 0, TC: true } as unknown as Reply;
    expect(await look("example.com", { "example.com/MX": tc, "example.com/TXT": tc })).toEqual({ hasMx: null, hasSpf: null });
  });
});

describe("lookupMailDns timeout default", () => {
  it("is 5 seconds and applied when no timeout is passed", async () => {
    expect(DNS_TIMEOUT_MS).toBe(5000);
    vi.useFakeTimers();
    try {
      const p = lookupMailDns("example.com", () => new Promise<Response>(() => {}));
      let done = false; void p.then(() => { done = true; });
      await vi.advanceTimersByTimeAsync(DNS_TIMEOUT_MS - 1);
      expect(done).toBe(false);
      await vi.advanceTimersByTimeAsync(1);
      expect(await p).toEqual(UNKNOWN_MAIL_DNS);
    } finally { vi.useRealTimers(); }
  });
});

describe("siteMailDomain", () => {
  const em = (value: string, o: { person?: string; confidence?: number } = {}) => ({ type: "email" as const, value, person_name: o.person ?? null, confidence: o.confidence ?? 0.7 });
  it("accepts an address at the site's own host (www stripped)", () => {
    expect(siteMailDomain("https://www.ace.com/", [em("info@ace.com")])).toBe("ace.com");
    expect(siteMailDomain("https://ace.com/", [em("Info@ACE.com")])).toBe("ace.com");
  });
  it("accepts an address at a parent of the site's host (shop.ace.com -> ace.com)", () => {
    expect(siteMailDomain("https://shop.ace.com/", [em("info@ace.com")])).toBe("ace.com");
  });
  it("uses the host actually reached, not the listing domain", () => {
    expect(siteMailDomain("https://ace-plumbing.com/", [em("info@ace-plumbing.com"), em("x@ace.com")])).toBe("ace-plumbing.com");
  });
  it("never accepts free-mail or other unrelated domains", () => {
    for (const d of ["gmail.com", "yahoo.com", "outlook.com", "hotmail.com", "aol.com", "icloud.com"])
      expect(siteMailDomain("https://ace.com/", [em(`ace@${d}`)]), d).toBeNull();
    expect(siteMailDomain("https://ace.com/", [em("a@notace.com"), em("a@ace.com.evil.net")])).toBeNull();
  });
  it("rejects public suffixes and hosted-site suffixes", () => {
    expect(siteMailDomain("https://ace.co.uk/", [em("info@co.uk")])).toBeNull();
    expect(siteMailDomain("https://ace.co.uk/", [em("info@ace.co.uk")])).toBe("ace.co.uk");
    expect(siteMailDomain("https://ace.wixsite.com/site", [em("info@wixsite.com")])).toBeNull();
    for (const h of HOSTED_SUFFIXES) expect(siteMailDomain(`https://ace.${h}/`, [em(`info@${h}`)]), h).toBeNull();
    expect(HOSTED_SUFFIXES).toEqual(expect.arrayContaining(["co.uk", "com.au", "wixsite.com", "myshopify.com", "business.site", "github.io"]));
  });
  it("needs two labels: a bare TLD never qualifies", () => {
    expect(siteMailDomain("https://ace.com/", [em("info@com")])).toBeNull();
  });
  it("ignores non-email contacts and malformed values", () => {
    expect(siteMailDomain("https://ace.com/", [{ type: "form", value: "https://ace.com/contact", person_name: null, confidence: 0.6 }, em("nonsense"), em("a@")])).toBeNull();
  });
  it("prefers a named contact, then higher confidence, then the first", () => {
    expect(siteMailDomain("https://shop.ace.com/", [em("a@shop.ace.com", { confidence: 0.7 }), em("b@ace.com", { person: "Bo", confidence: 0.9 })])).toBe("ace.com");
    expect(siteMailDomain("https://shop.ace.com/", [em("a@shop.ace.com", { confidence: 0.5 }), em("b@ace.com", { confidence: 0.7 })])).toBe("ace.com");
    expect(siteMailDomain("https://shop.ace.com/", [em("a@shop.ace.com"), em("b@ace.com")])).toBe("shop.ace.com");
  });
  it("falls back to a bare host when there is no URL, and is null with no site at all", () => {
    expect(siteMailDomain("ace.com", [em("info@ace.com")])).toBe("ace.com");
    expect(siteMailDomain(null, [em("info@ace.com")])).toBeNull();
  });
});

describe("lookupMailDns input and request shape", () => {
  it("normalises case, whitespace and a trailing dot", async () => {
    const d = doh({}); await lookupMailDns("  Example.COM. ", d.fetch);
    expect(new URL(d.calls[0].url).searchParams.get("name")).toBe("example.com");
  });
  it("invalid domains return nulls without fetching", async () => {
    for (const bad of ["", "localhost", "has space.com", "a/b.com", "https://example.com", "example.com/path", "-bad.com", "bad-.com", "a..com",
      "1.2.3.4", "x@example.com", `${"a".repeat(64)}.com`, `${"a.".repeat(130)}com`, "exa mple.com", "example.com:80"]) {
      const d = doh({});
      expect(await lookupMailDns(bad, d.fetch), bad).toEqual({ hasMx: null, hasSpf: null });
      expect(d.calls, bad).toHaveLength(0);
    }
  });
  it("queries cloudflare-dns.com for MX and TXT with the dns-json accept header", async () => {
    const d = doh({}); await lookupMailDns("example.com", d.fetch);
    const urls = d.calls.map((c) => c.url).sort();
    expect(urls).toEqual([
      "https://cloudflare-dns.com/dns-query?name=example.com&type=MX",
      "https://cloudflare-dns.com/dns-query?name=example.com&type=TXT",
    ]);
    for (const c of d.calls) expect((c.init?.headers as Record<string, string>).accept).toBe("application/dns-json");
  });
});
