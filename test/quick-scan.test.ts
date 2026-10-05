import { env, SELF } from "cloudflare:test";
import { describe, it, expect, beforeAll, afterEach } from "vitest";
import { runLead, type LeadDeps, type StepLike } from "../src/worker/pipeline/lead";
import { runSearch } from "../src/worker/pipeline/search";
import { startLeadIdempotent } from "../src/worker/workflows";
import { startSearchRun } from "../src/worker/search-start";
import { createSearch, getSearch } from "../src/worker/db/searches";
import { upsertBusiness, getBusiness } from "../src/worker/db/businesses";
import { insertAudit, latestAudit } from "../src/worker/db/audits";
import { latestDraft } from "../src/worker/db/drafts";
import { createFitProfile } from "../src/worker/db/fit";
import { addSuppression, isSuppressed, suppressedLeadIds } from "../src/worker/db/suppression";
import { saveSettings } from "../src/worker/db/settings";
import { rankPromising } from "../src/worker/scoring/promising";
import { FakeListingSource } from "../src/worker/listings/fake";
import type { Listing } from "../src/worker/types";

let cookie = "";
const api = (path: string, init: RequestInit = {}) =>
  SELF.fetch(`https://x${path}`, { ...init, headers: { cookie, "content-type": "application/json", ...(init.headers ?? {}) } });

beforeAll(async () => {
  await saveSettings(env.DB, { physical_address: "1 Main St, Boise, ID", opt_out_line: "Reply 'no thanks' and I won't email again." });
  const r = await SELF.fetch("https://x/api/login", { method: "POST", body: JSON.stringify({ password: "test-pass" }), headers: { "content-type": "application/json" } });
  cookie = r.headers.get("set-cookie")!.split(";")[0];
});

const L = (placeId: string, o: Partial<Listing> = {}): Listing => ({ placeId, name: `B-${placeId}`, category: null, address: null, phone: null,
  websiteUrl: null, mapsUrl: null, rating: null, reviewCount: null, ...o });

// ---------------------------------------------------------------------------------------------------------------------
describe("migration 0017", () => {
  it("existing rows stay 'full' / 0: businesses.scan_stage and searches.quick_scan default without being written", async () => {
    // Inserted the way a pre-0017 row was: neither new column is named.
    await env.DB.prepare(`INSERT INTO businesses (id, name, domain, lead_status, created_at) VALUES ('old-b', 'Old', 'old.com', 'new', '2026-01-01')`).run();
    await env.DB.prepare(`INSERT INTO searches (id, location, business_type, radius_km, max_results, status, created_at)
      VALUES ('old-s', 'X', 'y', 5, 5, 'done', '2026-01-01')`).run();
    expect((await getBusiness(env.DB, "old-b"))!.scan_stage).toBe("full");
    expect((await getSearch(env.DB, "old-s"))!.quick_scan).toBe(0);
  });
  it("createSearch stores quickScan and defaults to 0", async () => {
    const i = { location: "B", businessType: "p", radiusKm: 1, maxResults: 5 };
    expect((await createSearch(env.DB, i)).quick_scan).toBe(0);
    expect((await createSearch(env.DB, i, { quickScan: false })).quick_scan).toBe(0);
    const s = await createSearch(env.DB, i, { quickScan: true });
    expect(s.quick_scan).toBe(1);
    expect((await getSearch(env.DB, s.id))!.quick_scan).toBe(1);
  });
});

// ---------------------------------------------------------------------------------------------------------------------
describe("runLead stage", () => {
  const jpeg = new Uint8Array([0xff, 0xd8, 0xff, 0xd9]);
  const page = (b: string, h = "") => new Response(`<html><head>${h}</head><body>${b}</body></html>`, { headers: { "content-type": "text/html" } });
  const psi = { lighthouseResult: { categories: { performance: { score: 0.3 } }, audits: { "largest-contentful-paint": { numericValue: 7000 }, "cumulative-layout-shift": { numericValue: 0 }, viewport: { score: 1 } } } };
  const aiReview = { niche: "trades", value_proposition: "Boise plumbing", scores: { design: 82, content: 70, cro: 65, mobile: 80 },
    summaries: { design: "Clean", content: "OK", cro: "Weak CTA", mobile: "Fine" }, strengths: ["Clear phone number"], niche_checklist: [], findings: [] };

  function setup() {
    const calls = { render: 0, pagespeed: 0, review: 0, claude: 0, steps: [] as string[] };
    const step: StepLike = { do: (n, fn) => { calls.steps.push(n); return fn(); }, sleep: async () => {} };
    const deps: LeadDeps = {
      db: env.DB, raw: env.RAW, pagespeedKey: "K", now: () => new Date("2026-10-02T00:00:00Z"),
      fetch: async (u: string) => {
        if (u.startsWith("https://www.googleapis.com/pagespeedonline")) { calls.pagespeed++; return Response.json(psi); }
        if (u === "https://ace.com/") return page(`<a href="mailto:info@ace.com">m</a><p>© 2019</p>`, `<title>Ace</title><meta name="viewport" content="x">`);
        return new Response("nf", { status: 404, headers: { "content-type": "text/html" } });
      },
      claude: async () => { calls.claude++; return { subject: "Hi", body: "Body", to_contact_id: null, recipient_reason: "r" }; },
      render: async (url) => { calls.render++; return { finalUrl: url.endsWith("/") ? url : `${url}/`, desktopJpeg: jpeg, mobileJpeg: jpeg, mobile: { overflowX: false, smallTextPct: 0 },
        html: `<html><head><title>Ace</title></head><body>${"<p>Plumbing services for Boise homes and businesses.</p>".repeat(10)}</body></html>` }; },
      reviewer: async () => { calls.review++; return aiReview; },
    };
    return { deps, step, calls };
  }
  const usage = async () => (await env.DB.prepare(`SELECT service, SUM(units) AS units FROM usage GROUP BY service`).all<{ service: string; units: number }>()).results;
  async function lead(placeId: string) {
    const s = await createSearch(env.DB, { location: "Boise", businessType: "plumber", radiusKm: 10, maxResults: 5 });
    const b = await upsertBusiness(env.DB, L(placeId, { name: "Ace", category: "Plumber", websiteUrl: "https://ace.com" }), s.id);
    return { s, b };
  }
  afterEach(async () => { await env.DB.prepare(`DELETE FROM usage`).run(); });

  it("a quick run audits (crawl + dns + score), marks the stage, and spends nothing on render, PageSpeed, AI review or drafting", async () => {
    const { s, b } = await lead("Q1");
    const { deps, step, calls } = setup();
    const r = await runLead(deps, step, { businessId: b.id, searchId: s.id, stage: "quick" });
    const a = (await latestAudit(env.DB, b.id))!;
    expect(r.auditId).toBe(a.id);
    expect(r.draftId).toBeNull();
    expect(a.site_status).toBe("ok");
    expect(a.partial).toBe(true);
    expect(a.score).toBeGreaterThan(0);
    expect(a.screenshots).toEqual({ desktop: null, mobile: null });
    expect(a.ai_review).toBeNull();
    expect(a.pagespeed_mobile).toBeNull();
    expect((await getBusiness(env.DB, b.id))!.scan_stage).toBe("quick");
    expect(await latestDraft(env.DB, b.id)).toBeNull();
    expect(calls).toMatchObject({ render: 0, pagespeed: 0, review: 0, claude: 0 });
    expect(calls.steps).toEqual(["crawl", "dns", "score", "progress"]); // the paid steps are not even opened
    const spent = await usage();
    expect(spent.filter((u) => ["browser", "pagespeed", "claude"].includes(u.service))).toEqual([]);
    expect((await getSearch(env.DB, s.id))!.processed_count).toBe(1); // a quick lead still counts toward progress
  });

  it("the default stage still runs every step and marks the lead 'full'", async () => {
    const { s, b } = await lead("F1");
    const { deps, step, calls } = setup();
    const r = await runLead(deps, step, { businessId: b.id, searchId: s.id });
    expect(r.draftId).not.toBeNull();
    expect(calls).toMatchObject({ render: 1, pagespeed: 1, review: 1, claude: 1 });
    expect(calls.steps).toEqual(["render", "crawl", "pagespeed", "dns", "review", "score", "draft", "progress"]);
    expect((await getBusiness(env.DB, b.id))!.scan_stage).toBe("full");
    expect(new Set((await usage()).map((u) => u.service))).toEqual(new Set(["browser", "pagespeed", "claude"]));
  });

  it("a full run after a quick run promotes the lead to 'full' with screenshots, review and a draft", async () => {
    const { s, b } = await lead("P1");
    const q = setup();
    await runLead(q.deps, q.step, { businessId: b.id, searchId: s.id, stage: "quick" });
    expect((await getBusiness(env.DB, b.id))!.scan_stage).toBe("quick");
    const f = setup();
    const r = await runLead(f.deps, f.step, { businessId: b.id, searchId: null, stage: "full" });
    expect((await getBusiness(env.DB, b.id))!.scan_stage).toBe("full");
    expect(r.draftId).not.toBeNull();
    const a = (await latestAudit(env.DB, b.id))!;
    expect(a.screenshots.desktop).toMatch(/^shots\//);
    expect(a.ai_review?.niche).toBe("trades");
  });
});

// ---------------------------------------------------------------------------------------------------------------------
describe("stage threading", () => {
  const step: StepLike = { do: (_n, fn) => fn(), sleep: async () => {} };
  async function run(quickScan: boolean) {
    const s = await createSearch(env.DB, { location: "B", businessType: "p", radiusKm: 1, maxResults: 50 }, { quickScan });
    const started: { businessId: string; searchId: string; stage?: string }[] = [];
    await runSearch({ db: env.DB, source: new FakeListingSource([L(`T-${s.id}-1`), L(`T-${s.id}-2`)]), startLead: async (p) => { started.push(p); } }, step, s.id);
    return started;
  }

  it("a quick_scan search starts its leads with stage 'quick'; a normal one with 'full'", async () => {
    const quick = await run(true);
    expect(quick).toHaveLength(2);
    expect(quick.every((p) => p.stage === "quick")).toBe(true);
    const full = await run(false);
    expect(full).toHaveLength(2);
    expect(full.every((p) => p.stage === "full")).toBe(true);
  });

  it("startLeadIdempotent puts the stage in the lead workflow params (default 'full')", async () => {
    const seen: any[] = [];
    const binding = { create: async (o: any) => { seen.push(o.params); return {} as any; }, get: async () => { throw new Error("no"); } } as any;
    await startLeadIdempotent(binding, { businessId: "b1", searchId: "s1", stage: "quick" });
    await startLeadIdempotent(binding, { businessId: "b2", searchId: "s1" });
    expect(seen).toEqual([{ businessId: "b1", searchId: "s1", stage: "quick" }, { businessId: "b2", searchId: "s1", stage: "full" }]);
  });

  it("startSearchRun stores quick_scan from the request; omitted means 0 (Radar-started searches never quick-scan)", async () => {
    const done = async () => { await env.DB.prepare(`UPDATE searches SET status = 'done'`).run(); };
    const input = { location: "Quickville", businessType: "plumber", radiusKm: 5, maxResults: 5 };
    const a = await startSearchRun({ db: env.DB, startWorkflow: done }, { ...input, quickScan: true });
    const b = await startSearchRun({ db: env.DB, startWorkflow: done }, input);
    const c = await startSearchRun({ db: env.DB, startWorkflow: done }, input, { newOnly: true });
    expect(a.ok && a.search.quick_scan).toBe(1);
    expect(b.ok && b.search.quick_scan).toBe(0);
    expect(c.ok && [c.search.quick_scan, c.search.new_only]).toEqual([0, 1]);
  });

  it("POST /api/searches accepts quickScan and rejects a non-boolean", async () => {
    const orig = env.SEARCH_WORKFLOW.create;
    (env.SEARCH_WORKFLOW as any).create = async () => ({ id: "x" });
    try {
      const r = await api("/api/searches", { method: "POST", body: JSON.stringify({ location: "Routeville", businessType: "plumber", maxResults: 5, quickScan: true }) });
      expect(r.status).toBe(201);
      expect((await r.json<any>()).quick_scan).toBe(1);
      expect((await api("/api/searches", { method: "POST", body: JSON.stringify({ location: "Routeville", businessType: "plumber", maxResults: 5, quickScan: "yes" }) })).status).toBe(400);
    } finally { (env.SEARCH_WORKFLOW as any).create = orig; }
  });
});

// ---------------------------------------------------------------------------------------------------------------------
async function seedQuick(o: { name: string; category?: string | null; address?: string | null; score?: number; stage?: "quick" | "full"; website?: string | null;
  placeId?: string | null; archived?: boolean; withAudit?: boolean }) {
  const s = await createSearch(env.DB, { location: "Boise", businessType: "plumber", radiusKm: 10, maxResults: 5 });
  const b = await upsertBusiness(env.DB, { placeId: o.placeId === undefined ? crypto.randomUUID() : o.placeId, name: o.name, category: o.category ?? null, address: o.address ?? null,
    phone: null, websiteUrl: o.website === undefined ? `https://${crypto.randomUUID()}.example.com` : o.website, mapsUrl: null, rating: null, reviewCount: null }, s.id);
  await env.DB.prepare(`UPDATE businesses SET scan_stage = ?, archived_at = ? WHERE id = ?`).bind(o.stage ?? "quick", o.archived ? "2026-01-01" : null, b.id).run();
  if (o.withAudit !== false) await insertAudit(env.DB, { business_id: b.id, site_status: "ok", partial: true, pagespeed_mobile: null, lcp_ms: null, cls: null, mobile_friendly: null,
    https: false, has_title: true, has_meta_description: true, has_contact_form: false, copyright_year: null, latest_content_date: null, broken_link_count: 0,
    platform: null, seo_score: null, accessibility_score: null, mail_warning: null, score: o.score ?? 10, offer: "seo_basics", findings: [], raw_r2_key: null,
    health_score: null, niche: null, category_scores: {}, ai_review: null, screenshots: { desktop: null, mobile: null }, site_links: {} });
  return b;
}

describe("rankPromising", () => {
  const row = (name: string, fit: number | null, score: number | null) => ({ name, fit: { fit }, score });
  it("fit desc, null fit last, then score desc (null score last); never drops a null-fit row", () => {
    const rows = [row("nofit-hi", null, 90), row("fit50-lo", 50, 10), row("fit100-lo", 100, 5), row("fit50-hi", 50, 70), row("nofit-lo", null, 20), row("fit0", 0, 99), row("fit50-null", 50, null)];
    expect(rankPromising(rows).map((r) => r.name)).toEqual(["fit100-lo", "fit50-hi", "fit50-lo", "fit50-null", "fit0", "nofit-hi", "nofit-lo"]);
  });
  it("minFit drops only rows whose fit is a number below it; null-fit rows stay", () => {
    const rows = [row("a", 80, 1), row("b", 40, 1), row("c", null, 1), row("d", 0, 1)];
    expect(rankPromising(rows, { minFit: 50 }).map((r) => r.name)).toEqual(["a", "c"]);
    expect(rankPromising(rows, { minFit: 40 }).map((r) => r.name)).toEqual(["a", "b", "c"]);
    expect(rankPromising(rows, { minFit: 0 }).map((r) => r.name)).toEqual(["a", "b", "d", "c"]);
    expect(rankPromising(rows).map((r) => r.name)).toHaveLength(4);
  });
  it("does not mutate its input", () => {
    const rows = [row("a", 1, 1), row("b", 2, 2)];
    rankPromising(rows);
    expect(rows.map((r) => r.name)).toEqual(["a", "b"]);
  });
});

describe("suppressedLeadIds", () => {
  afterEach(async () => { await env.DB.prepare(`DELETE FROM suppressions`).run(); });
  it("agrees with isSuppressed for each lead, from one query", async () => {
    await addSuppression(env.DB, { kind: "domain", value: "clientco.com", reason: "client" });
    await addSuppression(env.DB, { kind: "place_id", value: "SUP-PLACE", reason: "opt_out" });
    const bs = [
      await seedQuick({ name: "by-domain", website: "https://www.ClientCo.com/x" }),
      await seedQuick({ name: "by-place", placeId: "SUP-PLACE" }),
      await seedQuick({ name: "clear" }),
      await seedQuick({ name: "no-site", website: null, placeId: null }),
    ];
    const set = await suppressedLeadIds(env.DB, bs);
    for (const b of bs) expect(set.has(b.id)).toBe(!!(await isSuppressed(env.DB, { domain: b.domain, placeId: b.place_id, websiteUrl: b.website_url })));
    expect([...set].length).toBe(2);
    expect((await suppressedLeadIds(env.DB, [])).size).toBe(0);
  });
});

describe("GET /api/leads/promising", () => {
  beforeAll(async () => { await createFitProfile(env.DB, { name: "Boise plumbers", service_key: "seo_basics", industries: ["plumb"], geos: ["boise"] }); });
  afterEach(async () => {
    await env.DB.prepare(`DELETE FROM suppressions`).run();
    await env.DB.prepare(`UPDATE businesses SET scan_stage = 'full' WHERE name LIKE 'PQ-%'`).run();
  });
  const names = async (qs = "") => (await (await api(`/api/leads/promising${qs}`)).json<any[]>()).filter((r) => r.business.name.startsWith("PQ-")).map((r) => r.business.name);

  it("lists quick-stage, non-archived, non-suppressed leads by fit then score, with scan_stage and fit on the rows", async () => {
    await addSuppression(env.DB, { kind: "domain", value: "blocked-pq.com", reason: "client" });
    await seedQuick({ name: "PQ-fit50-score20", category: "Plumber", address: "Austin", score: 20 });
    await seedQuick({ name: "PQ-fit100-score5", category: "Plumber", address: "Boise, ID", score: 5 });
    await seedQuick({ name: "PQ-fit50-score60", category: "Plumber", address: "Dallas", score: 60 });
    await seedQuick({ name: "PQ-fit0-score99", category: "Bakery", address: "Austin", score: 99 });
    await seedQuick({ name: "PQ-full-stage", category: "Plumber", address: "Boise", stage: "full" });
    await seedQuick({ name: "PQ-archived", category: "Plumber", address: "Boise", archived: true });
    await seedQuick({ name: "PQ-suppressed", category: "Plumber", address: "Boise", website: "https://www.blocked-pq.com/" });
    expect(await names()).toEqual(["PQ-fit100-score5", "PQ-fit50-score60", "PQ-fit50-score20", "PQ-fit0-score99"]);
    const rows = (await (await api(`/api/leads/promising`)).json<any[]>()).filter((r) => r.business.name.startsWith("PQ-"));
    expect(rows[0]).toMatchObject({ scan_stage: "quick", fit: { fit: 100 }, score: 5 });
  });

  it("minFit filters numeric fits below it only", async () => {
    await seedQuick({ name: "PQ-hi", category: "Plumber", address: "Boise" });
    await seedQuick({ name: "PQ-mid", category: "Plumber", address: "Austin" });
    await seedQuick({ name: "PQ-lo", category: "Bakery", address: "Austin" });
    expect(await names("?minFit=60")).toEqual(["PQ-hi"]);
    expect(await names("?minFit=50")).toEqual(["PQ-hi", "PQ-mid"]);
    expect((await api("/api/leads/promising?minFit=abc")).status).toBe(400);
    expect((await api("/api/leads/promising?minFit=101")).status).toBe(400);
  });

  it("with no active fit profile every fit is null and no lead is excluded; they order by score", async () => {
    // The seeded profiles are always present, so "no fit" means every profile switched off.
    const prior = (await env.DB.prepare(`SELECT id, active FROM fit_profiles`).all<{ id: string; active: number }>()).results;
    await env.DB.prepare(`UPDATE fit_profiles SET active = 0`).run();
    try {
      await seedQuick({ name: "PQ-nofit-low", score: 12 });
      await seedQuick({ name: "PQ-nofit-high", score: 80 });
      await seedQuick({ name: "PQ-nofit-noaudit", withAudit: false });
      const rows = (await (await api(`/api/leads/promising`)).json<any[]>()).filter((r) => r.business.name.startsWith("PQ-"));
      expect(rows.every((r) => r.fit.fit === null)).toBe(true);
      expect(rows.map((r) => r.business.name)).toEqual(["PQ-nofit-high", "PQ-nofit-low", "PQ-nofit-noaudit"]);
      expect(await names("?minFit=90")).toEqual(["PQ-nofit-high", "PQ-nofit-low", "PQ-nofit-noaudit"]); // null fit is never filtered out
    } finally { for (const p of prior) await env.DB.prepare(`UPDATE fit_profiles SET active = ? WHERE id = ?`).bind(p.active, p.id).run(); }
  });

  it("is not shadowed by /:id", async () => {
    const r = await api("/api/leads/promising");
    expect(r.status).toBe(200);
    expect(Array.isArray(await r.json())).toBe(true);
  });
});

describe("lead rows carry scan_stage", () => {
  it("GET /api/leads exposes each lead's stage", async () => {
    const b = await seedQuick({ name: "ROW-stage", stage: "quick" });
    const rows = await (await api("/api/leads")).json<any[]>();
    expect(rows.find((r) => r.business.id === b.id)).toMatchObject({ scan_stage: "quick" });
  });
});

describe("POST /api/leads/:id/full-scan", () => {
  async function withWorkflow<T>(fn: (created: any[]) => Promise<T>) {
    const created: any[] = [];
    const orig = env.LEAD_WORKFLOW.create;
    (env.LEAD_WORKFLOW as any).create = async (o: any) => { created.push(o); return { id: o.id }; };
    try { return await fn(created); } finally { (env.LEAD_WORKFLOW as any).create = orig; }
  }

  it("starts the lead workflow with stage 'full' and logs a reaudit", async () => {
    const b = await seedQuick({ name: "FS-quick" });
    await withWorkflow(async (created) => {
      const r = await api(`/api/leads/${b.id}/full-scan`, { method: "POST", body: JSON.stringify({}) });
      expect(r.status).toBe(202);
      expect(created).toHaveLength(1);
      expect(created[0].params).toEqual({ businessId: b.id, searchId: null, forceDraft: false, stage: "full" });
      expect(created[0].id).toMatch(new RegExp(`^fullscan-${b.id}-`));
    });
    const detail = await (await api(`/api/leads/${b.id}`)).json<any>();
    expect(detail.activity[0].kind).toBe("reaudit");
  });

  it("works for a lead with no audit, and for one already at the full stage", async () => {
    const noAudit = await seedQuick({ name: "FS-noaudit", withAudit: false });
    const full = await seedQuick({ name: "FS-full", stage: "full" });
    await withWorkflow(async (created) => {
      expect((await api(`/api/leads/${noAudit.id}/full-scan`, { method: "POST" })).status).toBe(202);
      expect((await api(`/api/leads/${full.id}/full-scan`, { method: "POST" })).status).toBe(202);
      expect(created.map((c) => c.params.stage)).toEqual(["full", "full"]);
    });
  });

  it("is not refused for a suppressed lead (the draft step guards itself)", async () => {
    const b = await seedQuick({ name: "FS-supp", website: "https://fs-supp.example.org" });
    await addSuppression(env.DB, { kind: "domain", value: "fs-supp.example.org", reason: "client" });
    try {
      await withWorkflow(async (created) => {
        expect((await api(`/api/leads/${b.id}/full-scan`, { method: "POST" })).status).toBe(202);
        expect(created).toHaveLength(1);
      });
    } finally { await env.DB.prepare(`DELETE FROM suppressions`).run(); }
  });

  it("404s for an unknown lead and starts nothing", async () => {
    await withWorkflow(async (created) => {
      expect((await api(`/api/leads/nope/full-scan`, { method: "POST" })).status).toBe(404);
      expect(created).toHaveLength(0);
    });
  });

  it("reports a workflow start failure as 502 instead of throwing", async () => {
    const b = await seedQuick({ name: "FS-fail" });
    const orig = env.LEAD_WORKFLOW.create;
    (env.LEAD_WORKFLOW as any).create = async () => { throw new Error("workflow unavailable"); };
    try {
      const r = await api(`/api/leads/${b.id}/full-scan`, { method: "POST" });
      expect(r.status).toBe(502);
      expect(await r.json()).toEqual({ error: "workflow unavailable" });
    } finally { (env.LEAD_WORKFLOW as any).create = orig; }
  });
});

describe("radar-style search flags", () => {
  it("a new_only search created without quickScan stores new_only 1 and quick_scan 0", async () => {
    const s = await createSearch(env.DB, { location: "B", businessType: "p", radiusKm: 1, maxResults: 5 }, { newOnly: true });
    expect([s.new_only, s.quick_scan]).toEqual([1, 0]);
  });
});

describe("a quick search never downgrades a lead that is already full", () => {
  const step: StepLike = { do: (_n, fn) => fn(), sleep: async () => {} };
  const audit = (businessId: string, o: { partial?: boolean; score?: number } = {}) => insertAudit(env.DB, {
    business_id: businessId, site_status: "ok", partial: o.partial ?? false, pagespeed_mobile: 80, lcp_ms: null, cls: null, mobile_friendly: null,
    https: true, has_title: true, has_meta_description: true, has_contact_form: true, copyright_year: null, latest_content_date: null, broken_link_count: 0,
    platform: null, seo_score: null, accessibility_score: null, score: o.score ?? 33, offer: "seo_basics", findings: [], raw_r2_key: null, mail_warning: null,
    health_score: null, niche: null, category_scores: {}, ai_review: null, screenshots: { desktop: "shots/x.jpg", mobile: null }, site_links: {} });
  async function seed(placeId: string, stage: "quick" | "full", status: "new" | "reviewed" = "reviewed") {
    const s0 = await createSearch(env.DB, { location: "B", businessType: "p", radiusKm: 1, maxResults: 50 });
    const b = await upsertBusiness(env.DB, L(placeId), s0.id);
    await env.DB.prepare(`UPDATE businesses SET scan_stage = ?, lead_status = ? WHERE id = ?`).bind(stage, status, b.id).run();
    return b;
  }
  async function run(listings: Listing[], o: { quickScan: boolean; newOnly?: boolean }) {
    const s = await createSearch(env.DB, { location: "B", businessType: "p", radiusKm: 1, maxResults: 50 }, o);
    const started: { businessId: string; stage: string }[] = [];
    await runSearch({ db: env.DB, source: new FakeListingSource(listings), startLead: async (p) => { started.push(p); } }, step, s.id);
    return { started, after: (await getSearch(env.DB, s.id))! };
  }

  it("(a) starts no workflow for a full lead, leaves its stage and latest audit alone, and still finishes with correct counts", async () => {
    const full = await seed("QS-FULL", "full");
    const a = await audit(full.id, { score: 41 });
    const r = await run([L("QS-FULL")], { quickScan: true });
    expect(r.started).toEqual([]);
    expect(r.after).toMatchObject({ quick_scan: 1, status: "done", found_count: 1, processed_count: 1 });
    expect((await getBusiness(env.DB, full.id))!.scan_stage).toBe("full");
    expect((await latestAudit(env.DB, full.id))!.id).toBe(a.id);
  });

  it("(a) also holds for a full lead whose status is still 'new', and a mix counts every lead once", async () => {
    const full = await seed("QS-FULL-NEW", "full", "new");
    await audit(full.id);
    const quick = await seed("QS-MIX-QUICK", "quick");
    const r = await run([L("QS-FULL-NEW"), L("QS-MIX-QUICK"), L("QS-MIX-FRESH")], { quickScan: true });
    const fresh = (await env.DB.prepare(`SELECT id FROM businesses WHERE place_id = 'QS-MIX-FRESH'`).first<{ id: string }>())!.id;
    expect(r.started.map((p) => p.businessId).sort()).toEqual([quick.id, fresh].sort());
    expect(r.started.every((p) => p.stage === "quick")).toBe(true);
    expect(r.after).toMatchObject({ status: "done", found_count: 3, processed_count: 1 }); // the full lead counts as processed
    expect((await getBusiness(env.DB, full.id))!.scan_stage).toBe("full");
  });

  it("(b) a quick search still starts a quick-stage lead and a brand-new one", async () => {
    const quick = await seed("QS-B-QUICK", "quick");
    const r = await run([L("QS-B-QUICK"), L("QS-B-NEW")], { quickScan: true });
    const fresh = (await env.DB.prepare(`SELECT id FROM businesses WHERE place_id = 'QS-B-NEW'`).first<{ id: string }>())!.id;
    expect(r.started.map((p) => p.businessId).sort()).toEqual([quick.id, fresh].sort());
    expect(r.after).toMatchObject({ found_count: 2, processed_count: 0 });
  });

  it("(c) a non-quick search re-runs a full lead exactly as before, with the full stage", async () => {
    const full = await seed("QS-C-FULL", "full");
    const r = await run([L("QS-C-FULL")], { quickScan: false });
    expect(r.started).toEqual([{ businessId: full.id, searchId: expect.any(String), stage: "full" }]);
    expect(r.after).toMatchObject({ found_count: 1, processed_count: 0 });
  });
});
