import { env, SELF } from "cloudflare:test";
import { describe, it, expect, beforeAll } from "vitest";
import { createSearch, getSearch, setFoundCount, setProcessedCount, setSearchStatus } from "../src/worker/db/searches";
import { upsertBusiness } from "../src/worker/db/businesses";
import { insertAudit } from "../src/worker/db/audits";
import { recordUsage } from "../src/worker/db/usage";
import { HOT_SCORE, searchCostUsd } from "../src/worker/search-summary";
import { STOPPED_ERROR } from "../src/worker/search-stop";
import { PER_LEAD_COST } from "../src/worker/cost";
import { HOT_AT } from "../src/client/scoreView";

let cookie = "";
const api = (path: string, init: RequestInit = {}) => SELF.fetch(`https://x${path}`, { ...init, headers: { cookie, "content-type": "application/json" }, ...init });

beforeAll(async () => {
  const r = await SELF.fetch("https://x/api/login", { method: "POST", body: JSON.stringify({ password: "test-pass" }), headers: { "content-type": "application/json" } });
  cookie = r.headers.get("set-cookie")!.split(";")[0];
});

async function lead(searchId: string, score: number) {
  const b = await upsertBusiness(env.DB, { placeId: crypto.randomUUID(), name: `Biz ${score}`, category: null, address: null, phone: null, websiteUrl: "https://x.com", mapsUrl: null, rating: null, reviewCount: null }, searchId);
  await insertAudit(env.DB, { business_id: b.id, site_status: "ok", partial: false, pagespeed_mobile: null, lcp_ms: null, cls: null, mobile_friendly: null,
    https: true, has_title: true, has_meta_description: true, has_contact_form: true, copyright_year: null, latest_content_date: null, broken_link_count: 0,
    platform: null, seo_score: null, accessibility_score: null, mail_warning: null, score, offer: "seo_basics", findings: [], raw_r2_key: null, health_score: 50,
    niche: null, category_scores: {}, ai_review: null, screenshots: { desktop: null, mobile: null }, site_links: {} });
  return b;
}

describe("search summary", () => {
  it("uses the client's Hot cut-off", () => expect(HOT_SCORE).toBe(HOT_AT));

  it("estimates cost: nothing before listings arrive, listings only for a quick scan, plus each finished lead for a full scan", () => {
    expect(searchCostUsd({ business_type: "plumber", max_results: 50, found_count: 0, processed_count: 0, quick_scan: 0 })).toBe(0);
    expect(searchCostUsd({ business_type: "plumber", max_results: 50, found_count: 50, processed_count: 50, quick_scan: 1 })).toBe(0); // 3 pages at $0.0015 rounds to cents
    expect(searchCostUsd({ business_type: "plumber", max_results: 50, found_count: 50, processed_count: 20, quick_scan: 0 })).toBe(Math.round((3 * 0.0015 + 20 * PER_LEAD_COST) * 100) / 100);
  });

  it("charges an import nothing", () => expect(searchCostUsd({ business_type: "import", max_results: 1, found_count: 18, processed_count: 18, quick_scan: 0 })).toBe(0));

  it("returns hot counts (latest audit only), cost and totals", async () => {
    const s = await createSearch(env.DB, { location: "Summary Town", businessType: "plumber", radiusKm: 10, maxResults: 20 });
    await setFoundCount(env.DB, s.id, 3); await setProcessedCount(env.DB, s.id, 3);
    await lead(s.id, 90); await lead(s.id, 60); await lead(s.id, 59);
    const reaudited = await lead(s.id, 80);
    await new Promise((r) => setTimeout(r, 5));
    await insertAudit(env.DB, { business_id: reaudited.id, site_status: "ok", partial: false, pagespeed_mobile: null, lcp_ms: null, cls: null, mobile_friendly: null,
      https: true, has_title: true, has_meta_description: true, has_contact_form: true, copyright_year: null, latest_content_date: null, broken_link_count: 0,
      platform: null, seo_score: null, accessibility_score: null, mail_warning: null, score: 10, offer: "seo_basics", findings: [], raw_r2_key: null, health_score: 90,
      niche: null, category_scores: {}, ai_review: null, screenshots: { desktop: null, mobile: null }, site_links: {} });
    await recordUsage(env.DB, "claude", 1, 1.25);
    const body = await (await api("/api/searches/summary")).json<any>();
    expect(body.items[s.id].hot).toBe(2); // 90 and 60; 59 is warm; the re-audited lead's latest score is 10
    expect(body.items[s.id].costUsd).toBeGreaterThan(0);
    expect(body.totals.searches).toBeGreaterThanOrEqual(1);
    expect(body.totals.found).toBeGreaterThanOrEqual(3);
    expect(body.totals.spentUsd).toBeGreaterThanOrEqual(1.25);
  });

  it("gives a search with no leads zero hot leads", async () => {
    const s = await createSearch(env.DB, { location: "Empty Town", businessType: "plumber", radiusKm: 10, maxResults: 20 });
    expect((await (await api("/api/searches/summary")).json<any>()).items[s.id]).toEqual({ hot: 0, costUsd: 0 });
  });
});

/** Replaces the workflow binding's `get` for one test so no real instance is needed. */
async function withWorkflowGet<T>(get: (id: string) => Promise<unknown>, fn: () => Promise<T>): Promise<T> {
  const orig = env.SEARCH_WORKFLOW.get;
  (env.SEARCH_WORKFLOW as any).get = get;
  try { return await fn(); } finally { (env.SEARCH_WORKFLOW as any).get = orig; }
}

describe("POST /api/searches/:id/stop", () => {
  it("terminates the search's workflow and leaves the search failed with the stopped marker", async () => {
    const s = await createSearch(env.DB, { location: "Stop Town", businessType: "plumber", radiusKm: 10, maxResults: 20 });
    const terminated: string[] = [];
    const r = await withWorkflowGet(async (id) => ({ terminate: async () => { terminated.push(id); } }), () => api(`/api/searches/${s.id}/stop`, { method: "POST" }));
    expect(r.status).toBe(200);
    expect(await r.json()).toMatchObject({ id: s.id, status: "failed", error: STOPPED_ERROR });
    expect(terminated).toEqual([`search-${s.id}`]);
    expect(await getSearch(env.DB, s.id)).toMatchObject({ status: "failed", error: STOPPED_ERROR });
  });
  it("still stops the search when its workflow instance is already gone", async () => {
    const s = await createSearch(env.DB, { location: "Gone Town", businessType: "plumber", radiusKm: 10, maxResults: 20 });
    const r = await withWorkflowGet(async () => { throw new Error("instance.not_found"); }, () => api(`/api/searches/${s.id}/stop`, { method: "POST" }));
    expect(r.status).toBe(200);
    expect((await getSearch(env.DB, s.id))!.status).toBe("failed");
  });
  it("refuses a search that is not running, and an unknown one", async () => {
    const s = await createSearch(env.DB, { location: "Done Town", businessType: "plumber", radiusKm: 10, maxResults: 20 });
    await setSearchStatus(env.DB, s.id, "done");
    expect((await api(`/api/searches/${s.id}/stop`, { method: "POST" })).status).toBe(409);
    expect((await getSearch(env.DB, s.id))!.status).toBe("done");
    expect((await api("/api/searches/nope/stop", { method: "POST" })).status).toBe(404);
  });
});
