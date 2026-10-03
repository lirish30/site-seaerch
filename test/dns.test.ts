import { describe, it, expect } from "vitest";
import { lookupMailDns } from "../src/worker/dns";
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

describe("lookupMailDns apex fallback", () => {
  it("a 3-label domain with no MX of its own but a parent MX is true", async () => {
    expect((await look("shop.example.com", { "example.com/MX": { Status: 0, Answer: [MX()] } })).hasMx).toBe(true);
  });
  it("false when neither has MX; null when the subdomain fails and the parent has none", async () => {
    expect((await look("shop.example.com", {})).hasMx).toBe(false);
    expect((await look("shop.example.com", { "shop.example.com/MX": "throw" })).hasMx).toBeNull();
  });
  it("true when the subdomain has MX even though the parent lookup fails", async () => {
    expect((await look("shop.example.com", { "shop.example.com/MX": { Status: 0, Answer: [MX()] }, "example.com/MX": "throw" })).hasMx).toBe(true);
  });
  it("SPF follows the same logic over both names", async () => {
    expect((await look("shop.example.com", { "example.com/TXT": { Status: 0, Answer: [TXT("\"v=spf1 -all\"")] } })).hasSpf).toBe(true);
    expect((await look("shop.example.com", {})).hasSpf).toBe(false);
    expect((await look("shop.example.com", { "shop.example.com/TXT": "throw" })).hasSpf).toBeNull();
  });
  it("a 2-label domain only queries itself", async () => {
    const d = doh({}); await lookupMailDns("example.com", d.fetch);
    expect(d.calls.map((c) => new URL(c.url).searchParams.get("name"))).toEqual(["example.com", "example.com"]);
  });
  it("a 3-label domain queries itself and its parent only", async () => {
    const d = doh({}); await lookupMailDns("a.b.example.com", d.fetch);
    expect(new Set(d.calls.map((c) => new URL(c.url).searchParams.get("name")))).toEqual(new Set(["a.b.example.com", "b.example.com"]));
    expect(d.calls).toHaveLength(4);
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
