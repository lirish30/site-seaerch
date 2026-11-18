import { env, SELF } from "cloudflare:test";
import { describe, it, expect, beforeAll, beforeEach } from "vitest";
import { MIN_TOTAL_AUDITS, nicheReport, nicheStats, nicheVerdict, opportunity, type NicheRow } from "../src/worker/niche";
import { createCampaign, updateCampaign, type Campaign } from "../src/worker/db/campaigns";
import { createSearch } from "../src/worker/db/searches";
import { insertAudit } from "../src/worker/db/audits";

let cookie = "";
const api = (path: string) => SELF.fetch(`https://x${path}`, { headers: { cookie } });
beforeAll(async () => {
  const r = await SELF.fetch("https://x/api/login", { method: "POST", body: JSON.stringify({ password: "test-pass" }), headers: { "content-type": "application/json" } });
  cookie = r.headers.get("set-cookie")!.split(";")[0];
});
beforeEach(async () => {
  await env.DB.batch(["audits", "search_results", "businesses", "searches", "campaigns"].map((t) => env.DB.prepare(`DELETE FROM ${t}`)));
});

const searchOf = new Map<string, string>();
async function campaign(name: string, o: { value?: number | null; status?: Campaign["status"] } = {}) {
  const c = await createCampaign(env.DB, { name, niche: name.toLowerCase(), region: "Portland, OR", towns: ["Tigard, OR"] });
  await updateCampaign(env.DB, c.id, { est_job_value_usd: o.value ?? null, status: o.status ?? "testing" });
  searchOf.set(c.id, (await createSearch(env.DB, { location: "Tigard, OR", businessType: name, radiusKm: 10, maxResults: 20 }, { campaignId: c.id })).id);
  return c.id;
}
let seq = 0;
/** One business reached through each given campaign; `health` lists its audits oldest first (null = a legacy audit with no Site Health). */
async function lead(campaigns: string[], o: { reviews: number | null; health: (number | null)[] }) {
  const id = crypto.randomUUID();
  await env.DB.prepare(`INSERT INTO businesses (id, place_id, name, review_count, created_at) VALUES (?,?,?,?,?)`).bind(id, `p-${id}`, `Biz ${seq++}`, o.reviews, new Date().toISOString()).run();
  for (const c of campaigns) await env.DB.prepare(`INSERT INTO search_results (search_id, business_id) VALUES (?,?)`).bind(searchOf.get(c)!, id).run();
  for (const [i, h] of o.health.entries()) {
    const a = await insertAudit(env.DB, {
      business_id: id, site_status: "ok", partial: false, pagespeed_mobile: 40, lcp_ms: 3000, cls: 0.1, mobile_friendly: true, https: true, has_title: true,
      has_meta_description: true, has_contact_form: true, copyright_year: 2024, latest_content_date: null, broken_link_count: 0, platform: null, seo_score: null,
      accessibility_score: null, score: 99, offer: "new_site", findings: [], raw_r2_key: null, mail_warning: null, health_score: h, niche: null,
      category_scores: {}, ai_review: null, screenshots: { desktop: null, mobile: null }, site_links: {},
    });
    await env.DB.prepare(`UPDATE audits SET created_at = ? WHERE id = ?`).bind(`2026-11-0${i + 1}T10:00:00.000Z`, a.id).run();
  }
  return id;
}
const row = (rows: NicheRow[], id: string) => rows.find((r) => r.campaignId === id)!;
const fake = (id: string, o: Partial<NicheRow>): NicheRow => ({ campaignId: id, name: id, niche: id, audited: 10, avgScore: 50, avgReviews: 10, jobValueUsd: 1000, opportunity: 1000, ...o });

describe("opportunity formula", () => {
  it("opportunity formula", () => {
    expect(opportunity(40, 100, 1000)).toBe(30000);
    expect(opportunity(100, 0, 5000)).toBe(0); // a perfect site leaves nothing to sell
    expect(opportunity(50, 0, 1001)).toBe(50050);
    expect(opportunity(33, 7, 999)).toBe(Math.round((67 * 999) / 1.07));
  });
});

describe("nicheStats", () => {
  it("stats use each business's latest audit only", async () => {
    const c = await campaign("Plumbers", { value: 1000 });
    await lead([c], { reviews: 10, health: [20, 80] }); // improved since the first audit: 80 counts
    await lead([c], { reviews: 30, health: [60] });
    await lead([c], { reviews: 500, health: [] }); // reached but never audited: counts nowhere
    const r = row(await nicheStats(env.DB), c);
    expect(r).toMatchObject({ name: "Plumbers", niche: "plumbers", audited: 2, avgScore: 70, avgReviews: 20, jobValueUsd: 1000 });
    expect(r.opportunity).toBe(opportunity(70, 20, 1000));
  });

  it("uses Site Health (higher is a better site), not the opportunity score", async () => {
    const c = await campaign("Roofers", { value: 100 });
    await lead([c], { reviews: 0, health: [30] }); // the helper stores score 99 (opportunity) beside health 30
    expect(row(await nicheStats(env.DB), c).avgScore).toBe(30);
  });

  it("a business with no measured Site Health counts as audited but stays out of the score mean", async () => {
    const c = await campaign("Painters", { value: 100 });
    await lead([c], { reviews: 10, health: [null] });
    await lead([c], { reviews: 30, health: [40] });
    expect(row(await nicheStats(env.DB), c)).toMatchObject({ audited: 2, avgScore: 40, avgReviews: 20 });
    const d = await campaign("Sweeps", { value: 100 });
    await lead([d], { reviews: 10, health: [null] });
    expect(row(await nicheStats(env.DB), d)).toMatchObject({ audited: 1, avgScore: null, opportunity: null });
  });

  it("treats a missing review count as zero", async () => {
    const c = await campaign("Movers", { value: 100 });
    await lead([c], { reviews: null, health: [50] });
    await lead([c], { reviews: 40, health: [50] });
    expect(row(await nicheStats(env.DB), c).avgReviews).toBe(20);
  });

  it("row without a job value has null opportunity", async () => {
    const c = await campaign("Electricians");
    await lead([c], { reviews: 20, health: [50] });
    expect(row(await nicheStats(env.DB), c)).toMatchObject({ audited: 1, avgScore: 50, avgReviews: 20, jobValueUsd: null, opportunity: null });
  });

  it("a trade with no audits has null averages and null opportunity", async () => {
    const c = await campaign("HVAC", { value: 5000 });
    await lead([c], { reviews: 20, health: [] });
    expect(row(await nicheStats(env.DB), c)).toMatchObject({ audited: 0, avgScore: null, avgReviews: null, jobValueUsd: 5000, opportunity: null });
  });

  it("archived campaigns are excluded", async () => {
    const live = await campaign("Plumbers", { value: 100 });
    const old = await campaign("Old trade", { value: 100, status: "archived" });
    await lead([live], { reviews: 1, health: [50] });
    await lead([old], { reviews: 1, health: [50] });
    expect((await nicheStats(env.DB)).map((r) => r.campaignId)).toEqual([live]);
  });

  it("a business reached by two campaigns counts in both, and once in the distinct total", async () => {
    const a = await campaign("Plumbers", { value: 100 });
    const b = await campaign("Electricians", { value: 100 });
    await lead([a, b], { reviews: 10, health: [50] });
    await lead([a], { reviews: 10, health: [50] });
    const { rows, distinctAudited, verdict } = await nicheReport(env.DB);
    expect([row(rows, a).audited, row(rows, b).audited]).toEqual([2, 1]);
    expect(distinctAudited).toBe(2);
    expect(verdict.audited).toBe(2);
  });

  it("two searches of one campaign reaching the same business count it once", async () => {
    const c = await campaign("Plumbers", { value: 100 });
    const id = await lead([c], { reviews: 10, health: [50] });
    const second = await createSearch(env.DB, { location: "Sherwood, OR", businessType: "plumber", radiusKm: 10, maxResults: 20 }, { campaignId: c });
    await env.DB.prepare(`INSERT INTO search_results (search_id, business_id) VALUES (?,?)`).bind(second.id, id).run();
    expect(row(await nicheStats(env.DB), c).audited).toBe(1);
  });

  it("ignores searches that belong to no campaign", async () => {
    const c = await campaign("Plumbers", { value: 100 });
    const loose = await createSearch(env.DB, { location: "Tigard, OR", businessType: "plumber", radiusKm: 10, maxResults: 20 });
    const id = await lead([], { reviews: 10, health: [50] });
    await env.DB.prepare(`INSERT INTO search_results (search_id, business_id) VALUES (?,?)`).bind(loose.id, id).run();
    expect(row(await nicheStats(env.DB), c).audited).toBe(0);
  });
});

describe("nicheVerdict", () => {
  it("verdict not ready below 50 audits", () => {
    const rows = [fake("a", { audited: 20, opportunity: 500 }), fake("b", { audited: 29, opportunity: 900 })];
    expect(nicheVerdict(rows)).toEqual({ ready: false, audited: 49, needed: MIN_TOTAL_AUDITS, leaderId: "b" });
    expect(MIN_TOTAL_AUDITS).toBe(50);
  });

  it("ready names the leader above 50", () => {
    const rows = [fake("a", { audited: 25, opportunity: 500 }), fake("b", { audited: 25, opportunity: 900 }), fake("c", { audited: 25, opportunity: null, jobValueUsd: null })];
    expect(nicheVerdict(rows)).toEqual({ ready: true, audited: 75, needed: 50, leaderId: "b" });
  });

  it("leader ties go to more audits, then name", () => {
    expect(nicheVerdict([fake("a", { audited: 10, opportunity: 100, name: "Alpha" }), fake("b", { audited: 30, opportunity: 100, name: "Beta" })]).leaderId).toBe("b");
    expect(nicheVerdict([fake("a", { audited: 30, opportunity: 100, name: "Zed" }), fake("b", { audited: 30, opportunity: 100, name: "Alpha" })]).leaderId).toBe("b");
  });

  it("no leader when no row has an opportunity", () => {
    expect(nicheVerdict([fake("a", { audited: 60, opportunity: null, jobValueUsd: null })])).toMatchObject({ ready: true, leaderId: null });
    expect(nicheVerdict([])).toEqual({ ready: false, audited: 0, needed: 50, leaderId: null });
  });

  it("uses the distinct audited total when given one", () => {
    const rows = [fake("a", { audited: 30 }), fake("b", { audited: 30 })];
    expect(nicheVerdict(rows).audited).toBe(60);
    expect(nicheVerdict(rows, 40)).toMatchObject({ ready: false, audited: 40 });
  });

  it("overlapping campaigns do not push the total past 50 twice", async () => {
    const a = await campaign("Plumbers", { value: 100 });
    const b = await campaign("Electricians", { value: 100 });
    for (let i = 0; i < 30; i++) await lead([a, b], { reviews: 1, health: [50] }); // 30 businesses, each in both rows: 60 summed, 30 distinct
    const { verdict, rows } = await nicheReport(env.DB);
    expect(rows.reduce((n, r) => n + r.audited, 0)).toBe(60);
    expect(verdict).toMatchObject({ audited: 30, ready: false });
  });
});

describe("GET /api/niche", () => {
  it("needs a login", async () => {
    expect((await SELF.fetch("https://x/api/niche")).status).toBe(401);
  });

  it("returns the rows and the verdict", async () => {
    const c = await campaign("Plumbers", { value: 1000 });
    await lead([c], { reviews: 100, health: [40] });
    const r = await api("/api/niche");
    expect(r.status).toBe(200);
    const j = await r.json<any>();
    expect(j.rows).toEqual([{ campaignId: c, name: "Plumbers", niche: "plumbers", audited: 1, avgScore: 40, avgReviews: 100, jobValueUsd: 1000, opportunity: 30000 }]);
    expect(j.verdict).toEqual({ ready: false, audited: 1, needed: 50, leaderId: c });
  });

  it("returns an empty list when there are no campaigns", async () => {
    expect(await (await api("/api/niche")).json()).toEqual({ rows: [], verdict: { ready: false, audited: 0, needed: 50, leaderId: null } });
  });
});
