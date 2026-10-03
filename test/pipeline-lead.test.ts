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
  const EVIDENCE = "Their business email isn't set up with the sender-verification records that help messages reach inboxes, so some may end up in spam";
  const WARNING = "A site email address is at a domain with no mail records, so emails to it will likely bounce";
  type Answers = { mx?: string | false | "throw" | "servfail"; txt?: string[] | "throw" };
  // A one-page site on `host` listing `emails`; the page may report a different final URL (a redirect), like a real fetch would.
  const siteFetch = (host: string, emails: string[], finalHost = host): LeadDeps["fetch"] => async (u) => {
    if (u.startsWith("https://www.googleapis.com/pagespeedonline")) return Response.json(psiSlow);
    const url = new URL(u);
    if (url.host !== host || url.pathname !== "/") return new Response("nf", { status: 404, headers: { "content-type": "text/html" } });
    const r = page(emails.map((e) => `<a href="mailto:${e}">m</a>`).join(""), `<title>Ace</title><meta name="viewport" content="x">`);
    Object.defineProperty(r, "url", { value: `https://${finalHost}/` });
    return r;
  };
  // Wraps the site fetch with a fake Cloudflare DoH resolver and records every DoH request.
  function withDoh(answers: Answers, over: Partial<LeadDeps> = {}) {
    const base = deps(over); const doh: string[] = [];
    const fetch: LeadDeps["fetch"] = async (u, i) => {
      if (!u.startsWith("https://cloudflare-dns.com/")) return base.fetch(u, i);
      doh.push(u);
      const type = new URL(u).searchParams.get("type");
      const a = type === "MX" ? answers.mx : answers.txt;
      if (a === "throw") throw new Error("doh down");
      if (a === "servfail") return Response.json({ Status: 2 });
      const Answer = type === "MX" ? (a ? [{ type: 15, data: a as string }] : []) : ((a as string[] | undefined) ?? []).map((data) => ({ type: 16, data }));
      return Response.json({ Status: 0, ...(Answer.length ? { Answer } : {}) });
    };
    return { d: { ...base, fetch } as LeadDeps, doh };
  }
  const names = (doh: string[]) => [...new Set(doh.map((u) => new URL(u).searchParams.get("name")))];
  const seed = async (id: string, o: Partial<Listing> = {}) => {
    const s = await createSearch(env.DB, { location: "B", businessType: "p", radiusKm: 1, maxResults: 5 });
    return upsertBusiness(env.DB, listing({ placeId: id, ...o }), s.id);
  };
  const run = async (d: LeadDeps, id: string) => { await runLead(d, step, { businessId: id, searchId: null }); return (await latestAudit(env.DB, id))!; };
  const codesOf = (a: { findings: { code: string }[] }) => a.findings.map((x) => x.code);
  // Runs a site with the given listing URL / emails / DoH answers.
  async function scenario(id: string, o: { listing: string; emails: string[]; finalHost?: string; answers?: Answers }) {
    const host = new URL(o.listing).host;
    const b = await seed(id, { websiteUrl: o.listing });
    const { d, doh } = withDoh(o.answers ?? { mx: "10 mx.example.net.", txt: [] }, { fetch: siteFetch(host, o.emails, o.finalHost) });
    const a = await run(d, b.id);
    return { a, doh, b };
  }
  const MX_NO_SPF: Answers = { mx: "10 mx.example.net.", txt: ["\"google-site-verification=x\""] };

  it("site ace.com listing info@ace.com, MX present and SPF absent → finding with the exact evidence", async () => {
    const { a, doh } = await scenario("M1", { listing: "https://ace.com", emails: ["info@ace.com"], answers: MX_NO_SPF });
    expect(names(doh)).toEqual(["ace.com"]);
    expect(a.findings.find((x) => x.code === NO_AUTH)!.evidence).toBe(EVIDENCE);
    expect(a.mail_warning).toBeNull();
  });

  it("a registrar-forwarder MX with no SPF still yields the finding (the site lists an own-domain address), evidence unchanged", async () => {
    const { a } = await scenario("M1f", { listing: "https://ace.com", emails: ["info@ace.com"], answers: { mx: "0 smtp.secureserver.net.", txt: [] } });
    expect(a.findings.find((x) => x.code === NO_AUTH)!.evidence).toBe(EVIDENCE);
  });

  it("no finding when SPF exists", async () => {
    const { a } = await scenario("M2", { listing: "https://ace.com", emails: ["info@ace.com"], answers: { mx: "10 m.", txt: ["\"v=spf1 include:_spf.google.com ~all\""] } });
    expect(codesOf(a)).not.toContain(NO_AUTH);
    expect(a.mail_warning).toBeNull();
  });

  it("only a free-mail address on the site → no DoH fetch, no finding, no warning", async () => {
    const { a, doh } = await scenario("M3a", { listing: "https://ace.com", emails: ["ace.plumbing@gmail.com"] });
    expect(doh).toEqual([]);
    expect(codesOf(a)).not.toContain(NO_AUTH);
    expect(a.mail_warning).toBeNull();
  });

  it("no email on the site at all → no lookup, no claim", async () => {
    const { a, doh } = await scenario("M3b", { listing: "https://ace.com", emails: [], answers: { mx: false, txt: [] } });
    expect(doh).toEqual([]);
    expect(a.mail_warning).toBeNull();
  });

  it("looks up the host actually reached, not the listing domain", async () => {
    const { a, doh, b } = await scenario("M3c", { listing: "https://ace.com", emails: ["info@ace-plumbing.com"], finalHost: "ace-plumbing.com", answers: MX_NO_SPF });
    expect(b.domain).toBe("ace.com");
    expect(names(doh)).toEqual(["ace-plumbing.com"]);
    expect(codesOf(a)).toContain(NO_AUTH);
  });

  it("an address at the old listing domain is not the site's: no lookup after a redirect elsewhere", async () => {
    const { doh } = await scenario("M3d", { listing: "https://ace.com", emails: ["info@ace.com"], finalHost: "ace-plumbing.com" });
    expect(doh).toEqual([]);
  });

  it("hosted-platform site (ace.wixsite.com, address at wixsite.com) is never looked up", async () => {
    const { a, doh } = await scenario("M3e", { listing: "https://ace.wixsite.com", emails: ["info@wixsite.com"], answers: MX_NO_SPF });
    expect(doh).toEqual([]);
    expect(codesOf(a)).not.toContain(NO_AUTH);
    expect(a.mail_warning).toBeNull();
  });

  it("shop.ace.com listing info@ace.com looks up ace.com; ace.co.uk with info@co.uk is rejected", async () => {
    const sub = await scenario("M3f", { listing: "https://shop.ace.com", emails: ["info@ace.com"], answers: MX_NO_SPF });
    expect(names(sub.doh)).toEqual(["ace.com"]);
    expect(codesOf(sub.a)).toContain(NO_AUTH);
    const uk = await scenario("M3g", { listing: "https://ace.co.uk", emails: ["info@co.uk"], answers: MX_NO_SPF });
    expect(uk.doh).toEqual([]);
    expect(codesOf(uk.a)).not.toContain(NO_AUTH);
  });

  it("the site's own address at a domain with no MX → tightened mail_warning stored, no finding", async () => {
    const { a } = await scenario("M4a", { listing: "https://ace.com", emails: ["info@ace.com"], answers: { mx: false, txt: [] } });
    expect(codesOf(a)).not.toContain(NO_AUTH);
    expect(a.mail_warning).toBe(WARNING);
  });

  it("a null MX (\"0 .\") with no SPF → warning, no finding", async () => {
    const { a } = await scenario("M4b", { listing: "https://ace.com", emails: ["info@ace.com"], answers: { mx: "0 .", txt: [] } });
    expect(codesOf(a)).not.toContain(NO_AUTH);
    expect(a.mail_warning).toBe(WARNING);
  });

  it("the warning never reaches the draft prompt", async () => {
    const b = await seed("M5");
    let user = "";
    const { d } = withDoh({ mx: false, txt: [] }, { fetch: siteFetch("ace.com", ["info@ace.com"]), claude: async (p) => { user = p.user; return { subject: "S", body: "B", to_contact_id: null, recipient_reason: "r" }; } });
    await runLead(d, step, { businessId: b.id, searchId: null, forceDraft: true });
    expect((await latestAudit(env.DB, b.id))!.mail_warning).toBe(WARNING);
    expect(user.length).toBeGreaterThan(0);
    expect(user).not.toMatch(/mail records|bounce|spf|dmarc/i);
  });

  it("DoH throwing or SERVFAIL → normal audit, no finding, no warning, lead does not fail", async () => {
    for (const [i, answers] of ([{ mx: "throw", txt: "throw" }, { mx: "servfail", txt: "servfail" }] as Answers[]).entries()) {
      const { a, doh, b } = await scenario(`M6-${i}`, { listing: "https://ace.com", emails: ["info@ace.com"], answers });
      expect(doh.length).toBeGreaterThan(0);
      expect(codesOf(a)).toContain("slow_mobile");
      expect(codesOf(a)).not.toContain(NO_AUTH);
      expect(a.mail_warning).toBeNull();
      expect((await getBusiness(env.DB, b.id))!.last_error).toBeNull();
    }
  });

  it("the dns step's own catch: a failing contacts read there still gives a normal audit", async () => {
    const b = await seed("M7", { websiteUrl: "https://ace.com" });
    let contactReads = 0;
    // 1st contacts read is inside the crawl step (replaceContacts), the 2nd is the dns step's.
    const db = new Proxy(env.DB, { get: (t, k) => {
      if (k === "prepare") return (sql: string) => { if (/^SELECT \* FROM contacts WHERE business_id = \?/.test(sql) && ++contactReads === 2) throw new Error("db hiccup"); return t.prepare(sql); };
      const v = (t as never)[k]; return typeof v === "function" ? (v as Function).bind(t) : v;
    } }) as unknown as D1Database;
    const { d } = withDoh(MX_NO_SPF, { db, fetch: siteFetch("ace.com", ["info@ace.com"]) });
    const a = await run(d, b.id);
    expect(contactReads).toBeGreaterThanOrEqual(2);
    expect(codesOf(a)).toContain("slow_mobile");
    expect(codesOf(a)).not.toContain(NO_AUTH);
    expect(a.mail_warning).toBeNull();
  });

  it("skipped (no DoH fetch) for no_website, unreachable, parked", async () => {
    const cases: [string, Partial<Listing>, LeadDeps["fetch"] | null][] = [
      ["no_website", { websiteUrl: null }, null],
      ["unreachable", { websiteUrl: "https://down.com" }, async () => { throw new Error("ECONNREFUSED"); }],
      ["parked", { websiteUrl: "https://parked.com" }, async () => page("<h1>Buy this domain</h1><a href=\"mailto:info@parked.com\">m</a>")],
    ];
    for (const [name, o, f] of cases) {
      const b = await seed(`M8-${name}`, o);
      const { d, doh } = withDoh({ mx: "10 m.", txt: [] }, f ? { fetch: f } : {});
      const a = await run(d, b.id);
      expect(a.site_status, name).toBe(name);
      expect(doh, name).toEqual([]);
      expect(a.mail_warning, name).toBeNull();
      expect(codesOf(a), name).not.toContain(NO_AUTH);
    }
  });

  it("bot-blocked sites yield no contacts, so no lookup and no claim", async () => {
    const b = await seed("M9", { websiteUrl: "https://walled.com" });
    const doh: string[] = [];
    const d = deps({ fetch: async (u) => {
      if (u.startsWith("https://cloudflare-dns.com/")) { doh.push(u); return Response.json({ Status: 0 }); }
      if (u.includes("pagespeedonline")) return Response.json(psiSlow);
      return new Response("Just a moment...", { status: 403, headers: { "content-type": "text/html" } });
    } });
    const a = await run(d, b.id);
    expect(a.site_status).toBe("blocked");
    expect(doh).toEqual([]);
    expect(a.mail_warning).toBeNull();
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
