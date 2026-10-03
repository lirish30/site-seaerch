import { env } from "cloudflare:test";
import { describe, it, expect } from "vitest";
import { runLeadWithErrorHandling } from "../src/worker/workflows";
import { getBusiness } from "../src/worker/db/businesses";
import { runLead, regenerateDraft, type LeadDeps, type StepLike } from "../src/worker/pipeline/lead";
import { createSearch, getSearch } from "../src/worker/db/searches";
import { upsertBusiness } from "../src/worker/db/businesses";
import { latestAudit } from "../src/worker/db/audits";
import { latestDraft } from "../src/worker/db/drafts";
import { listContacts } from "../src/worker/db/contacts";
import type { Listing } from "../src/worker/types";

const step: StepLike = { do: (_n, fn) => fn(), sleep: async () => {} };
const page = (b: string, h = "") => new Response(`<html><head>${h}</head><body>${b}</body></html>`, { headers: { "content-type": "text/html" } });
const psiSlow = { lighthouseResult: { categories: { performance: { score: 0.3 } }, audits: {
  "largest-contentful-paint": { numericValue: 7000 }, "cumulative-layout-shift": { numericValue: 0 }, viewport: { score: 1 } } } };

function deps(over: Partial<LeadDeps> = {}): LeadDeps & { claudeCalls: number } {
  const d: any = {
    db: env.DB, raw: env.RAW, pagespeedKey: "K", now: () => new Date("2026-10-02T00:00:00Z"), claudeCalls: 0,
    fetch: async (u: string) => {
      if (u.startsWith("https://www.googleapis.com/pagespeedonline")) return Response.json(psiSlow);
      if (u === "https://ace.com/") return page(`<a href="mailto:info@ace.com">m</a><p>© 2019</p>`, `<title>Ace</title><meta name="viewport" content="x"><meta name="generator" content="WordPress 6.4">`);
      return new Response("nf", { status: 404, headers: { "content-type": "text/html" } });
    },
    ...over,
  };
  d.claude = over.claude ?? (async () => { d.claudeCalls++; return { subject: "Hi", body: "Body", to_contact_id: null, recipient_reason: "r" }; });
  return d;
}
const listing = (o: Partial<Listing>): Listing => ({ placeId: null, name: "Ace", category: "Plumber", address: "Boise", phone: null,
  websiteUrl: "https://ace.com", mapsUrl: null, rating: null, reviewCount: null, ...o });

describe("runLead", () => {
  it("crawls, scores, drafts, stores contacts and raw, increments progress", async () => {
    const s = await createSearch(env.DB, { location: "Boise", businessType: "plumber", radiusKm: 10, maxResults: 5 });
    const b = await upsertBusiness(env.DB, listing({ placeId: "L1" }), s.id);
    const d = deps();
    const r = await runLead(d, step, { businessId: b.id, searchId: s.id });
    const a = (await latestAudit(env.DB, b.id))!;
    expect(a.site_status).toBe("ok");
    expect(a.findings.map((f) => f.code)).toContain("slow_mobile");
    expect(a.offer).toBe("performance");
    expect(a.platform).toBe("wordpress");
    expect([a.seo_score, a.accessibility_score]).toEqual([null, null]); // psiSlow has no seo/a11y categories
    expect(a.raw_r2_key).toMatch(/^audits\//);
    expect(await env.RAW.get(a.raw_r2_key!)).not.toBeNull();
    expect((await listContacts(env.DB, b.id))[0].value).toBe("info@ace.com");
    expect(r.draftId).not.toBeNull();
    expect((await latestDraft(env.DB, b.id))!.to_contact_id).toBe((await listContacts(env.DB, b.id))[0].id);
    expect((await getSearch(env.DB, s.id))!.processed_count).toBe(1);
  });

  it("persists lighthouse seo and accessibility scores and scores them", async () => {
    const s = await createSearch(env.DB, { location: "Boise", businessType: "plumber", radiusKm: 10, maxResults: 5 });
    const b = await upsertBusiness(env.DB, listing({ placeId: "L-lh" }), s.id);
    const psi = { lighthouseResult: { categories: {
      performance: { score: 0.95 },
      seo: { score: 0.5, auditRefs: [{ id: "link-text", weight: 1 }] },
      accessibility: { score: 0.62, auditRefs: [{ id: "image-alt", weight: 10 }] } },
      audits: { "link-text": { score: 0, scoreDisplayMode: "binary" }, "image-alt": { score: 0, scoreDisplayMode: "binary" }, viewport: { score: 1 } } } };
    const base = deps();
    await runLead(deps({ fetch: async (u, i) => u.includes("pagespeedonline") ? Response.json(psi) : base.fetch(u, i) }), step, { businessId: b.id, searchId: null });
    const a = (await latestAudit(env.DB, b.id))!;
    expect([a.seo_score, a.accessibility_score]).toEqual([50, 62]);
    expect(a.findings.map((f) => f.code)).toEqual(expect.arrayContaining(["low_seo_score", "low_accessibility"]));
    expect(a.findings.find((f) => f.code === "low_seo_score")!.evidence).toContain("links that just say things like 'click here'");
  });

  it("pagespeed failure → partial audit, still drafts", async () => {
    const s = await createSearch(env.DB, { location: "B", businessType: "p", radiusKm: 1, maxResults: 5 });
    const b = await upsertBusiness(env.DB, listing({ placeId: "L2" }), s.id);
    const base = deps();
    const d = deps({ fetch: async (u, i) => u.includes("pagespeedonline") ? new Response("x", { status: 500 }) : base.fetch(u, i) });
    await runLead(d, step, { businessId: b.id, searchId: s.id });
    expect((await latestAudit(env.DB, b.id))!.partial).toBe(true);
  });

  it("Lighthouse runtimeError → partial audit with no speed findings (never a fake 0/100)", async () => {
    const s = await createSearch(env.DB, { location: "B", businessType: "p", radiusKm: 1, maxResults: 5 });
    const b = await upsertBusiness(env.DB, listing({ placeId: "L2b" }), s.id);
    const base = deps();
    const d = deps({ fetch: async (u, i) => u.includes("pagespeedonline")
      ? Response.json({ lighthouseResult: { runtimeError: { code: "NO_FCP" }, categories: { performance: { score: null } }, audits: {} } })
      : base.fetch(u, i) });
    await runLead(d, step, { businessId: b.id, searchId: s.id });
    const a = (await latestAudit(env.DB, b.id))!;
    expect(a.partial).toBe(true);
    expect(a.pagespeed_mobile).toBeNull();
    expect(a.findings.map((f) => f.group)).not.toContain("speed");
  });

  it("bot-blocked site → blocked audit scored from PageSpeed on the original URL, no 'didn't load' claim", async () => {
    const s = await createSearch(env.DB, { location: "B", businessType: "p", radiusKm: 1, maxResults: 5 });
    const b = await upsertBusiness(env.DB, listing({ placeId: "L2c", websiteUrl: "https://walled.com" }), s.id);
    let psiUrl = "";
    const d = deps({ fetch: async (u) => {
      if (u.includes("pagespeedonline")) { psiUrl = u; return Response.json(psiSlow); }
      return new Response("Just a moment...", { status: 403, headers: { "content-type": "text/html" } });
    } });
    await runLead(d, step, { businessId: b.id, searchId: s.id });
    const a = (await latestAudit(env.DB, b.id))!;
    expect(a.site_status).toBe("blocked");
    expect(psiUrl).toContain(encodeURIComponent("https://walled.com/"));
    expect(a.partial).toBe(false);
    expect(a.findings.map((f) => f.code)).toContain("slow_mobile");
    expect(a.findings.map((f) => f.code)).not.toContain("site_unreachable");
  });

  it("bot-blocked site with PageSpeed failing → score 0, partial, no findings", async () => {
    const s = await createSearch(env.DB, { location: "B", businessType: "p", radiusKm: 1, maxResults: 5 });
    const b = await upsertBusiness(env.DB, listing({ placeId: "L2d", websiteUrl: "https://walled2.com" }), s.id);
    const d = deps({ fetch: async (u) => u.includes("pagespeedonline")
      ? new Response("x", { status: 500 })
      : new Response("", { status: 503, headers: { "content-type": "text/html" } }) });
    await runLead(d, step, { businessId: b.id, searchId: s.id });
    const a = (await latestAudit(env.DB, b.id))!;
    expect(a.site_status).toBe("blocked");
    expect(a.score).toBe(0);
    expect(a.partial).toBe(true);
    expect(a.findings).toEqual([]);
  });

  it("low-priority lead is not drafted unless forced", async () => {
    const s = await createSearch(env.DB, { location: "B", businessType: "p", radiusKm: 1, maxResults: 5 });
    const b = await upsertBusiness(env.DB, listing({ placeId: "L3", websiteUrl: "https://good.com" }), s.id);
    const good = async (u: string) => u.includes("pagespeedonline")
      ? Response.json({ lighthouseResult: { categories: { performance: { score: 0.95 } }, audits: { "largest-contentful-paint": { numericValue: 1000 }, "cumulative-layout-shift": { numericValue: 0 } } } })
      : u === "https://good.com/" ? page(`<form><input name="email"><textarea></textarea></form><p>© 2026</p>`, `<title>G</title><meta name="description" content="d"><meta name="viewport" content="x">`)
      : new Response("", { status: 404, headers: { "content-type": "text/html" } });
    const d = deps({ fetch: good });
    const r = await runLead(d, step, { businessId: b.id, searchId: s.id });
    expect(r.draftId).toBeNull();
    expect(d.claudeCalls).toBe(0);
    const forced = await runLead(d, step, { businessId: b.id, searchId: null, forceDraft: true });
    expect(forced.draftId).not.toBeNull();
  });

  it("no website → score 100, new_site, no pagespeed call", async () => {
    const s = await createSearch(env.DB, { location: "B", businessType: "p", radiusKm: 1, maxResults: 5 });
    const b = await upsertBusiness(env.DB, listing({ placeId: "L4", websiteUrl: null }), s.id);
    let psiCalled = false;
    const d = deps({ fetch: async (u) => { if (u.includes("pagespeed")) psiCalled = true; return new Response(""); } });
    await runLead(d, step, { businessId: b.id, searchId: s.id });
    const a = (await latestAudit(env.DB, b.id))!;
    expect(a.score).toBe(100);
    expect(a.offer).toBe("new_site");
    expect(a.platform).toBeNull();
    expect(psiCalled).toBe(false);
  });

  it("regenerateDraft passes steering note and keeps history", async () => {
    const s = await createSearch(env.DB, { location: "B", businessType: "p", radiusKm: 1, maxResults: 5 });
    const b = await upsertBusiness(env.DB, listing({ placeId: "L5" }), s.id);
    let lastUser = "";
    const d = deps({ claude: async (p) => { lastUser = p.user; return { subject: "S2", body: "B2", to_contact_id: null, recipient_reason: "r" }; } });
    await runLead(d, step, { businessId: b.id, searchId: s.id });
    const dr = await regenerateDraft(d, b.id, "shorter");
    expect(lastUser).toContain("shorter");
    expect(dr.steering_note).toBe("shorter");
  });

  it("pagespeed step failing after retries → partial audit, draft still runs", async () => {
    const s = await createSearch(env.DB, { location: "B", businessType: "p", radiusKm: 1, maxResults: 5 });
    const b = await upsertBusiness(env.DB, listing({ placeId: "L6" }), s.id);
    const d = deps();
    const failing: StepLike = { do: (n, fn) => (n === "pagespeed" ? Promise.reject(new Error("rate limited")) : fn()), sleep: async () => {} };
    const r = await runLead(d, failing, { businessId: b.id, searchId: s.id, forceDraft: true });
    expect((await latestAudit(env.DB, b.id))!.partial).toBe(true);
    expect(r.draftId).not.toBeNull();
  });
});

describe("runLead mail DNS", () => {
  const NO_AUTH = "no_email_auth";
  // Wraps the fake site fetch with a fake Cloudflare DoH resolver and records every DoH request.
  function withDoh(answers: { mx?: boolean | "throw" | "servfail"; txt?: string[] | "throw" }, over: Partial<LeadDeps> = {}) {
    const base = deps(over); const doh: string[] = [];
    const fetch: LeadDeps["fetch"] = async (u, i) => {
      if (!u.startsWith("https://cloudflare-dns.com/")) return base.fetch(u, i);
      doh.push(u);
      const type = new URL(u).searchParams.get("type");
      const a = type === "MX" ? answers.mx : answers.txt;
      if (a === "throw") throw new Error("doh down");
      if (a === "servfail") return Response.json({ Status: 2 });
      const Answer = type === "MX" ? (a ? [{ type: 15, data: "10 mx.ace.com." }] : []) : ((a as string[] | undefined) ?? []).map((data) => ({ type: 16, data }));
      return Response.json({ Status: 0, ...(Answer.length ? { Answer } : {}) });
    };
    return { d: { ...base, fetch } as LeadDeps, doh };
  }
  const seed = async (id: string, o: Partial<Listing> = {}) => {
    const s = await createSearch(env.DB, { location: "B", businessType: "p", radiusKm: 1, maxResults: 5 });
    return upsertBusiness(env.DB, listing({ placeId: id, ...o }), s.id);
  };
  const run = async (d: LeadDeps, id: string) => { await runLead(d, step, { businessId: id, searchId: null }); return (await latestAudit(env.DB, id))!; };

  it("runs for an ok site with a domain and feeds scoring (MX but no SPF → finding)", async () => {
    const b = await seed("M1");
    const { d, doh } = withDoh({ mx: true, txt: ["\"google-site-verification=x\""] });
    const a = await run(d, b.id);
    expect(doh.length).toBeGreaterThan(0);
    expect(doh.every((u) => u.includes("name=ace.com"))).toBe(true);
    const f = a.findings.find((x) => x.code === NO_AUTH)!;
    expect(f.evidence).toBe("Their business email isn't set up with the sender-verification records that help messages reach inboxes, so some may end up in spam");
    expect(a.mail_warning).toBeNull();
  });

  it("no finding when SPF exists", async () => {
    const b = await seed("M2");
    const a = await run(withDoh({ mx: true, txt: ["\"v=spf1 include:_spf.google.com ~all\""] }).d, b.id);
    expect(a.findings.map((x) => x.code)).not.toContain(NO_AUTH);
    expect(a.mail_warning).toBeNull();
  });

  it("no MX → mail_warning stored, no finding", async () => {
    const b = await seed("M3");
    const a = await run(withDoh({ mx: false, txt: [] }).d, b.id);
    expect(a.findings.map((x) => x.code)).not.toContain(NO_AUTH);
    expect(a.mail_warning).toBe("This domain has no mail records, so emails to addresses at this domain will likely bounce");
  });

  it("a mail_warning never reaches the draft prompt", async () => {
    const b = await seed("M3b");
    let user = "";
    const { d } = withDoh({ mx: false, txt: [] }, { claude: async (p) => { user = p.user; return { subject: "S", body: "B", to_contact_id: null, recipient_reason: "r" }; } });
    await runLead(d, step, { businessId: b.id, searchId: null, forceDraft: true });
    expect(user.length).toBeGreaterThan(0);
    expect(user).not.toMatch(/mail records|bounce|spf|dmarc/i);
  });

  it("DoH throwing or SERVFAIL → normal audit, no finding, no warning, lead does not fail", async () => {
    for (const [i, answers] of [{ mx: "throw", txt: "throw" }, { mx: "servfail", txt: "servfail" }].entries()) {
      const b = await seed(`M4-${i}`);
      const { d, doh } = withDoh(answers as never);
      const a = await run(d, b.id);
      expect(doh.length).toBeGreaterThan(0);
      expect(a.findings.map((x) => x.code)).toContain("slow_mobile");
      expect(a.findings.map((x) => x.code)).not.toContain(NO_AUTH);
      expect(a.mail_warning).toBeNull();
      expect((await getBusiness(env.DB, b.id))!.last_error).toBeNull();
    }
  });

  it("an unexpected throw inside the dns step is swallowed (step never throws)", async () => {
    const b = await seed("M5");
    const base = deps();
    const d = { ...base, fetch: async (u: string, i?: RequestInit) => { if (u.includes("cloudflare-dns")) throw new TypeError("boom"); return base.fetch(u, i); } } as LeadDeps;
    const a = await run(d, b.id);
    expect(a.mail_warning).toBeNull();
    expect(a.findings.map((x) => x.code)).not.toContain(NO_AUTH);
  });

  it("blocked sites are still checked", async () => {
    const b = await seed("M6", { websiteUrl: "https://walled.com" });
    const doh: string[] = [];
    const d = deps({ fetch: async (u) => {
      if (u.startsWith("https://cloudflare-dns.com/")) { doh.push(u); return Response.json(new URL(u).searchParams.get("type") === "MX" ? { Status: 0, Answer: [{ type: 15, data: "10 m." }] } : { Status: 0 }); }
      if (u.includes("pagespeedonline")) return Response.json(psiSlow);
      return new Response("Just a moment...", { status: 403, headers: { "content-type": "text/html" } });
    } });
    const a = await run(d, b.id);
    expect(a.site_status).toBe("blocked");
    expect(doh.length).toBeGreaterThan(0);
    expect(a.findings.map((x) => x.code)).toContain(NO_AUTH);
  });

  it("skipped (no DoH fetch) for no_website, unreachable, parked and for a missing domain", async () => {
    const cases: [string, Partial<Listing>, LeadDeps["fetch"] | null][] = [
      ["no_website", { websiteUrl: null }, null],
      ["unreachable", { websiteUrl: "https://down.com" }, async () => { throw new Error("ECONNREFUSED"); }],
      ["parked", { websiteUrl: "https://parked.com" }, async () => page("<h1>Buy this domain</h1>")],
    ];
    for (const [name, o, f] of cases) {
      const b = await seed(`M7-${name}`, o);
      const { d, doh } = withDoh({ mx: true, txt: [] }, f ? { fetch: f } : {});
      // withDoh wraps base.fetch, so the override fetch is the site; DoH calls would still be recorded by the wrapper.
      const a = await run(d, b.id);
      expect(a.site_status, name).toBe(name);
      expect(doh, name).toEqual([]);
      expect(a.mail_warning, name).toBeNull();
      expect(a.findings.map((x) => x.code), name).not.toContain(NO_AUTH);
    }
    // Social-only sites are stored without a domain, and the site itself is still crawled.
    const social = await seed("M7-social", { websiteUrl: "https://facebook.com/ace" });
    expect(social.domain).toBeNull();
    const { d, doh } = withDoh({ mx: true, txt: [] });
    await run(d, social.id);
    expect(doh).toEqual([]);
  });
});

describe("runLeadWithErrorHandling", () => {
  it("records a non-Error throw and increments progress exactly once", async () => {
    const s = await createSearch(env.DB, { location: "B", businessType: "p", radiusKm: 1, maxResults: 5 });
    const b = await upsertBusiness(env.DB, listing({ placeId: "L7" }), s.id);
    const fake: any = { do: (n: string, c: any, f?: () => Promise<unknown>) => (n === "score" ? Promise.reject("boom-string") : (f ?? c)()), sleep: async () => {} };
    const r = await runLeadWithErrorHandling(deps(), fake, { businessId: b.id, searchId: s.id });
    expect(r).toEqual({ auditId: null, draftId: null });
    expect((await getBusiness(env.DB, b.id))!.last_error).toBe("boom-string");
    expect((await getSearch(env.DB, s.id))!.processed_count).toBe(1);
  });
});
