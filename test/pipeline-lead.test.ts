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
    expect(a.raw_r2_key).toMatch(/^audits\//);
    expect(await env.RAW.get(a.raw_r2_key!)).not.toBeNull();
    expect((await listContacts(env.DB, b.id))[0].value).toBe("info@ace.com");
    expect(r.draftId).not.toBeNull();
    expect((await latestDraft(env.DB, b.id))!.to_contact_id).toBe((await listContacts(env.DB, b.id))[0].id);
    expect((await getSearch(env.DB, s.id))!.processed_count).toBe(1);
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
