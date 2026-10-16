import { env, SELF } from "cloudflare:test";
import { describe, it, expect, beforeAll, beforeEach } from "vitest";
import { createSearch } from "../src/worker/db/searches";
import { upsertBusiness } from "../src/worker/db/businesses";
import { addSuppression } from "../src/worker/db/suppression";
import { PER_LEAD_COST } from "../src/worker/cost";
import { buildSummary, HOT_SCORE, movedTo } from "../src/worker/todaySummary";
import { HOT_AT } from "../src/client/scoreView";

const NOW = new Date("2026-10-15T12:00:00.000Z");
const DAY = 86_400_000;
const ago = (days: number) => new Date(NOW.getTime() - days * DAY).toISOString();

let cookie = "";
beforeAll(async () => {
  const r = await SELF.fetch("https://x/api/login", { method: "POST", body: JSON.stringify({ password: "test-pass" }), headers: { "content-type": "application/json" } });
  cookie = r.headers.get("set-cookie")!.split(";")[0];
});
beforeEach(async () => {
  for (const t of ["activity", "drafts", "audits", "search_results", "businesses", "suppressions"]) await env.DB.prepare(`DELETE FROM ${t}`).run();
});

let searchId = "";
interface Seed { status?: string; deal?: number | null; createdAt?: string; website?: string | null; archived?: boolean }
async function lead(name: string, o: Seed = {}) {
  if (!searchId) searchId = (await createSearch(env.DB, { location: "Boise", businessType: "plumber", radiusKm: 10, maxResults: 5 })).id;
  const b = await upsertBusiness(env.DB, { placeId: crypto.randomUUID(), name, category: null, address: null, phone: null,
    websiteUrl: o.website ?? null, mapsUrl: null, rating: null, reviewCount: null }, searchId);
  await env.DB.prepare(`UPDATE businesses SET lead_status = ?, deal_value = ?, created_at = ?, archived_at = ? WHERE id = ?`)
    .bind(o.status ?? "new", o.deal ?? null, o.createdAt ?? ago(30), o.archived ? ago(1) : null, b.id).run();
  return b.id;
}
const audit = (id: string, score: number, createdAt = ago(1)) => env.DB.prepare(
  `INSERT INTO audits (id, business_id, created_at, site_status, partial, score, offer, findings) VALUES (?,?,?,?,?,?,?,?)`)
  .bind(crypto.randomUUID(), id, createdAt, "ok", 0, score, "care_plan", "[]").run();
const draft = (id: string, createdAt: string) => env.DB.prepare(
  `INSERT INTO drafts (id, business_id, recipient_reason, subject, body, offer, created_at) VALUES (?,?,?,?,?,?,?)`)
  .bind(crypto.randomUUID(), id, "r", "S", "B", "seo_basics", createdAt).run();
const act = (id: string, kind: string, createdAt: string, detail: string | null = null) => env.DB.prepare(
  `INSERT INTO activity (id, business_id, kind, detail, created_at) VALUES (?,?,?,?,?)`).bind(crypto.randomUUID(), id, kind, detail, createdAt).run();

describe("movedTo", () => {
  it("reads the new status out of a single change and a bulk change", () => {
    expect(movedTo("contacted → won")).toBe("won");
    expect(movedTo("status → replied (bulk)")).toBe("replied");
    expect(movedTo("archive (bulk)")).toBeNull();
    expect(movedTo(null)).toBeNull();
  });
  it("uses the same Hot cut-off as the client", () => { expect(HOT_SCORE).toBe(HOT_AT); });
});

describe("buildSummary", () => {
  it("is all zeros with no leads", async () => {
    const s = await buildSummary(env.DB, NOW);
    expect(s).toMatchObject({ hot: { total: 0, newThisWeek: 0 }, drafts: { ready: 0, waiting: 0 }, replied: { total: 0, thisWeek: 0 }, won: { thisMonth: 0, valueThisMonth: 0, openValue: 0 }, totalLeads: 0, recent: [] });
    expect(s.fullScanCostUsd).toBe(PER_LEAD_COST);
  });

  it("counts hot open leads by their latest score and how many arrived this week", async () => {
    const a = await lead("Hot old"), b = await lead("Hot new", { createdAt: ago(2) }), c = await lead("Warm"), d = await lead("Cooled");
    const e = await lead("Hot but won", { status: "won" }), f = await lead("Hot but archived", { archived: true });
    await audit(a, 80); await audit(b, 60); await audit(c, 59); await audit(d, 90, ago(5)); await audit(d, 10, ago(1)); await audit(e, 95); await audit(f, 99);
    expect((await buildSummary(env.DB, NOW)).hot).toEqual({ total: 2, newThisWeek: 1 });
  });

  it("leaves suppressed leads out of Hot and Drafts", async () => {
    const id = await lead("Competitor", { website: "https://rival.example" });
    await audit(id, 90); await draft(id, ago(5));
    await addSuppression(env.DB, { kind: "domain", value: "rival.example", reason: "competitor" });
    const s = await buildSummary(env.DB, NOW);
    expect(s.hot.total).toBe(0);
    expect(s.drafts).toEqual({ ready: 0, waiting: 0 });
  });

  it("counts drafts on new or reviewed leads and those whose draft is older than 2 days", async () => {
    const a = await lead("Fresh"), b = await lead("Stale", { status: "reviewed" }), c = await lead("Sent", { status: "contacted" });
    await draft(a, ago(1)); await draft(b, ago(4)); await draft(c, ago(9));
    expect((await buildSummary(env.DB, NOW)).drafts).toEqual({ ready: 2, waiting: 1 });
  });

  it("counts replied leads and the ones that replied in the last 7 days", async () => {
    const a = await lead("Replied now", { status: "replied" }), b = await lead("Replied long ago", { status: "replied" });
    const c = await lead("Bulk replied", { status: "replied" }), d = await lead("Replied then lost", { status: "lost" });
    await act(a, "status", ago(2), "contacted → replied"); await act(b, "status", ago(12), "contacted → replied");
    await act(c, "bulk", ago(1), "status → replied (bulk)"); await act(d, "status", ago(1), "contacted → replied");
    expect((await buildSummary(env.DB, NOW)).replied).toEqual({ total: 3, thisWeek: 2 });
  });

  it("sums the deal value of leads won this calendar month, and of every open lead", async () => {
    const a = await lead("Won now", { status: "won", deal: 6000 }), b = await lead("Won September", { status: "won", deal: 9000 });
    const c = await lead("Won, no row", { status: "won", deal: 500 }), d = await lead("Won twice", { status: "won", deal: 3400 });
    await act(a, "status", ago(3), "replied → won"); await act(b, "status", ago(20), "replied → won"); await act(d, "status", ago(40), "replied → won"); await act(d, "status", ago(1), "lost → won");
    await lead("Open A", { status: "contacted", deal: 4500 }); await lead("Open B", { status: "replied", deal: 13700 }); await lead("Closed", { status: "lost", deal: 800 });
    void c;
    expect((await buildSummary(env.DB, NOW)).won).toEqual({ thisMonth: 2, valueThisMonth: 9400, openValue: 18200 });
  });

  it("counts every stage and returns the latest activity (not Home's own done/snooze rows), newest first", async () => {
    const a = await lead("A", { status: "new" }); await lead("B", { status: "new" }); await lead("C", { status: "skip" });
    await act(a, "note", ago(3), "called"); await act(a, "status", ago(2), "new → reviewed"); await act(a, "today_done", ago(1), "follow_up_due");
    const s = await buildSummary(env.DB, NOW);
    expect(s.pipeline).toMatchObject({ new: 2, skip: 1, won: 0 });
    expect(s.totalLeads).toBe(3);
    expect(s.recent.map((r) => r.kind)).toEqual(["status", "note"]);
    expect(s.recent[0]).toMatchObject({ businessId: a, businessName: "A", detail: "new → reviewed" });
  });
});

describe("GET /api/today/summary", () => {
  it("needs a login and returns the summary", async () => {
    expect((await SELF.fetch("https://x/api/today/summary")).status).toBe(401);
    const r = await SELF.fetch("https://x/api/today/summary", { headers: { cookie } });
    expect(r.status).toBe(200);
    expect(await r.json()).toMatchObject({ hot: { total: 0 }, pipeline: { new: 0 }, totalLeads: 0, recent: [] });
  });
});
