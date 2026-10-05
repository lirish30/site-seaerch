import { env, SELF } from "cloudflare:test";
import { describe, it, expect, beforeAll, beforeEach } from "vitest";
import { createSearch } from "../src/worker/db/searches";
import { upsertBusiness } from "../src/worker/db/businesses";
import { addSuppression } from "../src/worker/db/suppression";
import { listActivity } from "../src/worker/db/activity";
import { buildToday, parseSnooze, type TodayKind } from "../src/worker/today";

const NOW = new Date("2026-10-04T12:00:00.000Z");
const DAY = 86_400_000;
const ago = (days: number) => new Date(NOW.getTime() - days * DAY).toISOString();
const ahead = (days: number) => new Date(NOW.getTime() + days * DAY).toISOString();

let cookie = "";
const api = (path: string, init: RequestInit = {}) =>
  SELF.fetch(`https://x${path}`, { ...init, headers: { cookie, "content-type": "application/json", ...(init.headers ?? {}) } });
const post = (path: string, body?: unknown) => api(path, { method: "POST", body: JSON.stringify(body ?? {}) });

beforeAll(async () => {
  const r = await SELF.fetch("https://x/api/login", { method: "POST", body: JSON.stringify({ password: "test-pass" }), headers: { "content-type": "application/json" } });
  cookie = r.headers.get("set-cookie")!.split(";")[0];
});

// buildToday reads every lead, so each test starts from an empty set.
beforeEach(async () => {
  for (const t of ["activity", "drafts", "audits", "search_results", "businesses", "suppressions"]) await env.DB.prepare(`DELETE FROM ${t}`).run();
});

let searchId = "";
interface Seed {
  status?: string; followUpAt?: string | null; dealValue?: number | null; stage?: "quick" | "full"; archived?: boolean; website?: string | null;
}
async function lead(name: string, o: Seed = {}) {
  if (!searchId) searchId = (await createSearch(env.DB, { location: "Boise", businessType: "plumber", radiusKm: 10, maxResults: 5 })).id;
  const b = await upsertBusiness(env.DB, { placeId: crypto.randomUUID(), name, category: null, address: null, phone: null,
    websiteUrl: o.website === undefined ? null : o.website, mapsUrl: null, rating: null, reviewCount: null }, searchId);
  await env.DB.prepare(`UPDATE businesses SET lead_status = ?, follow_up_at = ?, deal_value = ?, scan_stage = ?, archived_at = ? WHERE id = ?`)
    .bind(o.status ?? "new", o.followUpAt ?? null, o.dealValue ?? null, o.stage ?? "full", o.archived ? "2026-01-01T00:00:00.000Z" : null, b.id).run();
  return b.id;
}
const draft = (businessId: string, createdAt: string) => env.DB.prepare(
  `INSERT INTO drafts (id, business_id, recipient_reason, subject, body, offer, created_at) VALUES (?,?,?,?,?,?,?)`)
  .bind(crypto.randomUUID(), businessId, "r", "S", "B", "seo_basics", createdAt).run();
const audit = (businessId: string, score: number, createdAt = ago(1)) => env.DB.prepare(
  `INSERT INTO audits (id, business_id, created_at, site_status, partial, score, offer, findings) VALUES (?,?,?,?,?,?,?,?)`)
  .bind(crypto.randomUUID(), businessId, createdAt, "ok", 1, score, "care_plan", "[]").run();
const act = (businessId: string, kind: string, createdAt: string, detail: string | null = null) => env.DB.prepare(
  `INSERT INTO activity (id, business_id, kind, detail, created_at) VALUES (?,?,?,?,?)`)
  .bind(crypto.randomUUID(), businessId, kind, detail, createdAt).run();
const today = async () => buildToday(env.DB, NOW);
const of = async (kind: TodayKind) => (await today()).filter((i) => i.kind === kind);

describe("follow_up_due", () => {
  it("appears once follow_up_at is at or before now, with due = follow_up_at and id kind:businessId", async () => {
    const id = await lead("Overdue", { followUpAt: ago(3) });
    const [item] = await of("follow_up_due");
    expect(item).toMatchObject({ id: `follow_up_due:${id}`, kind: "follow_up_due", businessId: id, businessName: "Overdue", due: ago(3) });
    expect(item.reason).toMatch(/3 days/);
    await lead("Exactly now", { followUpAt: NOW.toISOString() });
    expect((await of("follow_up_due")).map((i) => i.businessName).sort()).toEqual(["Exactly now", "Overdue"]);
  });
  it("a future follow-up does not appear", async () => {
    await lead("Later", { followUpAt: ahead(1) });
    expect(await today()).toEqual([]);
  });
  it("priority is 100 plus whole days overdue, capped at +30", async () => {
    await lead("Today", { followUpAt: ago(0.5) });
    await lead("Five", { followUpAt: ago(5) });
    await lead("Ancient", { followUpAt: ago(400) });
    const p = Object.fromEntries((await of("follow_up_due")).map((i) => [i.businessName, i.priority]));
    expect(p).toEqual({ Today: 100, Five: 105, Ancient: 130 });
  });
  it("won, lost and skipped leads never appear", async () => {
    for (const status of ["won", "lost", "skip"]) await lead(`S-${status}`, { status, followUpAt: ago(2) });
    expect(await today()).toEqual([]);
  });
  it("still appears for contacted and replied leads", async () => {
    await lead("C", { status: "contacted", followUpAt: ago(1) });
    await lead("R", { status: "replied", followUpAt: ago(1) });
    expect(await of("follow_up_due")).toHaveLength(2);
  });
});

describe("draft_unsent", () => {
  it("appears for a new or reviewed lead whose latest draft is older than 2 days", async () => {
    const a = await lead("New", { status: "new" }), b = await lead("Reviewed", { status: "reviewed" });
    await draft(a, ago(3)); await draft(b, ago(10));
    const items = await of("draft_unsent");
    expect(items.map((i) => i.businessName).sort()).toEqual(["New", "Reviewed"]);
    expect(items.every((i) => i.priority === 60 && i.due === null)).toBe(true);
  });
  it("does not appear for a draft 2 days old or newer", async () => {
    await draft(await lead("Fresh"), ago(2)); // exactly 2 days is not "older than"
    await draft(await lead("Fresher"), ago(0.1));
    expect(await today()).toEqual([]);
  });
  it("uses the latest draft: an old draft plus a fresh regeneration does not appear", async () => {
    const id = await lead("Regenerated");
    await draft(id, ago(20)); await draft(id, ago(1));
    expect(await today()).toEqual([]);
  });
  it("an export activity at or after the draft hides it; one before the draft does not", async () => {
    const sent = await lead("Exported"), earlier = await lead("Export before draft");
    await draft(sent, ago(5)); await act(sent, "export", ago(4));
    await draft(earlier, ago(5)); await act(earlier, "export", ago(9));
    expect((await of("draft_unsent")).map((i) => i.businessName)).toEqual(["Export before draft"]);
  });
  it("an export long ago still counts when it is after that draft (no activity-window cutoff)", async () => {
    const id = await lead("Old export");
    await draft(id, ago(200)); await act(id, "export", ago(199));
    expect(await today()).toEqual([]);
  });
  it("is only for new or reviewed leads, and a lead with no draft never appears", async () => {
    await draft(await lead("Contacted", { status: "contacted" }), ago(9));
    await draft(await lead("Skipped", { status: "skip" }), ago(9));
    await lead("No draft");
    expect(await today()).toEqual([]);
  });
});

describe("stalled_deal", () => {
  it("appears for a contacted or replied lead with a deal value and no activity in 14 days", async () => {
    const a = await lead("Contacted", { status: "contacted", dealValue: 1500 });
    const b = await lead("Replied", { status: "replied", dealValue: 0 });
    await act(a, "status", ago(15));
    const items = await of("stalled_deal");
    expect(items.map((i) => i.businessName).sort()).toEqual(["Contacted", "Replied"]);
    expect(items.every((i) => i.priority === 70 && i.due === null)).toBe(true);
    expect(items.find((i) => i.businessId === a)!.reason).toMatch(/\$1,500/);
    expect(b).toBeTruthy();
  });
  it("any recent activity (14 days or newer) un-stalls it", async () => {
    const id = await lead("Active", { status: "contacted", dealValue: 900 });
    await act(id, "status", ago(13));
    expect(await today()).toEqual([]);
  });
  it("needs a deal value and a contacted/replied status", async () => {
    await lead("No value", { status: "contacted" });
    await lead("New with value", { status: "new", dealValue: 500 });
    await lead("Won", { status: "won", dealValue: 500 });
    expect(await today()).toEqual([]);
  });
  it("today_done, snoozed and bulk rows are queue/bulk interactions, not contact with the prospect, so they do not un-stall a deal", async () => {
    const id = await lead("Still stalled", { status: "contacted", dealValue: 700 });
    await act(id, "today_done", ago(1), "promising_quick_scan");
    await act(id, "snoozed", ago(1), `promising_quick_scan|${ago(-3)}`);
    await act(id, "bulk", ago(1), "tag");
    expect(await of("stalled_deal")).toHaveLength(1);
  });
});

describe("promising_quick_scan", () => {
  it("needs scan_stage 'quick' and a latest-audit score of at least 50", async () => {
    const hit = await lead("Hit", { stage: "quick" }); await audit(hit, 50);
    const low = await lead("Low", { stage: "quick" }); await audit(low, 49);
    const full = await lead("Full", { stage: "full" }); await audit(full, 90);
    const none = await lead("Never audited", { stage: "quick" });
    expect(none).toBeTruthy();
    const items = await of("promising_quick_scan");
    expect(items.map((i) => i.businessName)).toEqual(["Hit"]);
    expect(items[0]).toMatchObject({ priority: 40, due: null });
    expect(items[0].reason).toMatch(/50/);
  });
  it("judges the latest audit, not an older one", async () => {
    const id = await lead("Dropped", { stage: "quick" });
    await audit(id, 95, ago(30)); await audit(id, 20, ago(1));
    const risen = await lead("Risen", { stage: "quick" });
    await audit(risen, 10, ago(30)); await audit(risen, 70, ago(1));
    expect((await of("promising_quick_scan")).map((i) => i.businessName)).toEqual(["Risen"]);
  });
  it("shows at most 5, the highest-scoring ones", async () => {
    for (let i = 0; i < 8; i++) await audit(await lead(`Q${i}`, { stage: "quick" }), 60 + i);
    expect((await of("promising_quick_scan")).map((i) => i.businessName)).toEqual(["Q7", "Q6", "Q5", "Q4", "Q3"]);
  });
  it("hidden items are replaced by the next-best, so the cap is 5 visible items", async () => {
    const ids: string[] = [];
    for (let i = 0; i < 7; i++) { const id = await lead(`Q${i}`, { stage: "quick" }); ids.push(id); await audit(id, 60 + i); }
    await act(ids[6], "today_done", ago(1), "promising_quick_scan");
    expect((await of("promising_quick_scan")).map((i) => i.businessName)).toEqual(["Q5", "Q4", "Q3", "Q2", "Q1"]);
  });
  it("skip, won and lost leads are left out", async () => {
    for (const status of ["skip", "won", "lost"]) await audit(await lead(`S-${status}`, { stage: "quick", status }), 80);
    expect(await today()).toEqual([]);
  });
});

describe("archived and suppressed leads", () => {
  it("archived leads are hidden for every kind", async () => {
    await lead("A1", { archived: true, followUpAt: ago(2) });
    const d = await lead("A2", { archived: true }); await draft(d, ago(5));
    await lead("A3", { archived: true, status: "contacted", dealValue: 100 });
    await audit(await lead("A4", { archived: true, stage: "quick" }), 90);
    expect(await today()).toEqual([]);
  });
  it("an archived lead stays hidden even when it is also suppressed", async () => {
    await lead("A5", { archived: true, website: "https://both.com", followUpAt: ago(2), status: "contacted", dealValue: 100 });
    await addSuppression(env.DB, { kind: "domain", value: "both.com", reason: "client" });
    expect(await today()).toEqual([]);
  });
  // Suppression keeps a lead out of searches and automations. The owner's own follow-up dates and open deals (marked "Active deal" or
  // "Client") still need a work surface, so those two kinds stay. Drafts and quick scans lead toward outreach or spend, so they hide.
  it("suppressed leads (by domain or place ID) still get follow_up_due and stalled_deal items", async () => {
    const f = await lead("S1", { website: "https://blocked.com", followUpAt: ago(2) });
    const st = await lead("S3", { website: "https://www.blocked.com", status: "contacted", dealValue: 100 });
    await addSuppression(env.DB, { kind: "domain", value: "blocked.com", reason: "client" });
    const byPlace = await lead("S5", { followUpAt: ago(2) });
    const pid = (await env.DB.prepare(`SELECT place_id FROM businesses WHERE id = ?`).bind(byPlace).first<{ place_id: string }>())!.place_id;
    await addSuppression(env.DB, { kind: "place_id", value: pid, reason: "client" });
    expect((await of("follow_up_due")).map((i) => i.businessId).sort()).toEqual([f, byPlace].sort());
    expect((await of("stalled_deal")).map((i) => i.businessId)).toEqual([st]);
  });
  it("suppressed leads get no draft_unsent or promising_quick_scan items", async () => {
    const d = await lead("S2", { website: "https://blocked.com/x" }); await draft(d, ago(5));
    await audit(await lead("S4", { website: "https://blocked.com", stage: "quick" }), 90);
    const byPlace = await lead("S6", { stage: "quick" }); await audit(byPlace, 90);
    const dByPlace = await lead("S7"); await draft(dByPlace, ago(5));
    await addSuppression(env.DB, { kind: "domain", value: "blocked.com", reason: "opt_out" });
    for (const id of [byPlace, dByPlace]) {
      const pid = (await env.DB.prepare(`SELECT place_id FROM businesses WHERE id = ?`).bind(id).first<{ place_id: string }>())!.place_id;
      await addSuppression(env.DB, { kind: "place_id", value: pid, reason: "opt_out" });
    }
    const v = await lead("Visible", { stage: "quick" }); await audit(v, 70);
    const vd = await lead("VisibleDraft"); await draft(vd, ago(5));
    expect((await of("draft_unsent")).map((i) => i.businessId)).toEqual([vd]);
    expect((await of("promising_quick_scan")).map((i) => i.businessId)).toEqual([v]);
  });
  it("one suppressed lead shows its follow-up and deal but not its draft or quick scan", async () => {
    const id = await lead("Mixed", { website: "https://mixed.com", followUpAt: ago(2), status: "contacted", dealValue: 500, stage: "quick" });
    await draft(id, ago(5)); await audit(id, 90);
    await env.DB.prepare(`UPDATE businesses SET lead_status = 'new' WHERE id = ?`).bind(id).run();
    await addSuppression(env.DB, { kind: "domain", value: "mixed.com", reason: "client" });
    expect((await today()).map((i) => i.kind)).toEqual(["follow_up_due"]);
    await env.DB.prepare(`UPDATE businesses SET lead_status = 'contacted' WHERE id = ?`).bind(id).run();
    expect((await today()).map((i) => i.kind).sort()).toEqual(["follow_up_due", "stalled_deal"]);
  });
  it("suppressed quick-scan leads do not use up the five quick-scan slots", async () => {
    for (let n = 0; n < 5; n++) await audit(await lead(`Sup${n}`, { website: "https://slots.com", stage: "quick" }), 95);
    await addSuppression(env.DB, { kind: "domain", value: "slots.com", reason: "opt_out" });
    for (let n = 0; n < 5; n++) await audit(await lead(`Vis${n}`, { stage: "quick" }), 60);
    expect((await of("promising_quick_scan")).map((i) => i.businessName).sort()).toEqual(["Vis0", "Vis1", "Vis2", "Vis3", "Vis4"]);
  });
});

describe("done and snooze", () => {
  it("done hides that exact item for 7 days, then it comes back", async () => {
    const id = await lead("Done", { followUpAt: ago(2) });
    await act(id, "today_done", ago(6.9), "follow_up_due");
    expect(await today()).toEqual([]);
    await env.DB.prepare(`DELETE FROM activity`).run();
    await act(id, "today_done", ago(7.1), "follow_up_due");
    expect(await of("follow_up_due")).toHaveLength(1);
  });
  it("done hides only the kind it names, not the lead's other items", async () => {
    const id = await lead("Both", { followUpAt: ago(2), status: "contacted", dealValue: 400 });
    await act(id, "today_done", ago(1), "follow_up_due");
    expect((await today()).map((i) => i.kind)).toEqual(["stalled_deal"]);
  });
  it("done on one lead does not hide another lead's item", async () => {
    const a = await lead("A", { followUpAt: ago(2) }); await lead("B", { followUpAt: ago(2) });
    await act(a, "today_done", ago(1), "follow_up_due");
    expect((await today()).map((i) => i.businessName)).toEqual(["B"]);
  });
  it("snooze hides the item until the stated date, then it comes back", async () => {
    const id = await lead("Snoozed", { followUpAt: ago(2) });
    await act(id, "snoozed", ago(1), `follow_up_due|${ahead(2)}`);
    expect(await today()).toEqual([]);
    await env.DB.prepare(`DELETE FROM activity`).run();
    await act(id, "snoozed", ago(5), `follow_up_due|${ago(0.01)}`);
    expect(await of("follow_up_due")).toHaveLength(1);
  });
  it("the latest snooze wins over an older, longer one", async () => {
    const id = await lead("Resnoozed", { followUpAt: ago(2) });
    await act(id, "snoozed", ago(3), `follow_up_due|${ahead(20)}`);
    await act(id, "snoozed", ago(1), `follow_up_due|${ago(0.5)}`);
    expect(await of("follow_up_due")).toHaveLength(1);
  });
  it("a malformed detail never crashes and hides nothing", async () => {
    const id = await lead("Odd", { followUpAt: ago(2) });
    for (const d of [null, "", "garbage", "follow_up_due|", "follow_up_due|not-a-date", "|2999-01-01T00:00:00.000Z", "nope|2999-01-01T00:00:00.000Z"])
      await act(id, "snoozed", ago(1), d);
    await act(id, "today_done", ago(1), "not_a_kind");
    await act(id, "today_done", ago(1), null);
    expect(await of("follow_up_due")).toHaveLength(1);
  });
});

describe("parseSnooze", () => {
  it("reads kind|until and rejects anything else", () => {
    expect(parseSnooze("stalled_deal|2026-10-12T00:00:00.000Z")).toEqual({ kind: "stalled_deal", until: Date.parse("2026-10-12T00:00:00.000Z") });
    for (const bad of [null, "", "x", "stalled_deal|", "stalled_deal|nope", "bogus|2026-10-12T00:00:00.000Z"]) expect(parseSnooze(bad)).toBeNull();
  });
});

describe("ordering and scale", () => {
  it("sorts by priority desc, then due asc, with an overdue follow-up above a stalled deal", async () => {
    const stalled = await lead("Stalled", { status: "contacted", dealValue: 1000 });
    const d = await lead("Draft"); await draft(d, ago(4));
    await audit(await lead("Quick", { stage: "quick" }), 80);
    await lead("Overdue 2d", { followUpAt: ago(2) });
    await lead("Overdue 9d", { followUpAt: ago(9) });
    expect(stalled).toBeTruthy();
    const items = await today();
    expect(items.map((i) => i.businessName)).toEqual(["Overdue 9d", "Overdue 2d", "Stalled", "Draft", "Quick"]);
    expect(items.map((i) => i.priority)).toEqual([109, 102, 70, 60, 40]);
  });
  it("equal-priority follow-ups are ordered by due date ascending", async () => {
    // Both are 130 (capped), so the earliest due comes first.
    await lead("Later", { followUpAt: ago(60) });
    await lead("Earlier", { followUpAt: ago(90) });
    expect((await today()).map((i) => i.businessName)).toEqual(["Earlier", "Later"]);
  });
  it("handles more candidates than one D1 query can bind (chunked activity lookup)", async () => {
    const stmts: D1PreparedStatement[] = [];
    for (let i = 0; i < 250; i++) {
      stmts.push(env.DB.prepare(`INSERT INTO businesses (id, name, lead_status, deal_value, created_at) VALUES (?,?,?,?,?)`)
        .bind(`bulk-${i}`, `Bulk ${i}`, "contacted", 100, ago(100)));
      // every third one has recent activity and must stay out
      if (i % 3 === 0) stmts.push(env.DB.prepare(`INSERT INTO activity (id, business_id, kind, created_at) VALUES (?,?,?,?)`).bind(`bulk-act-${i}`, `bulk-${i}`, "status", ago(2)));
    }
    await env.DB.batch(stmts);
    expect(await of("stalled_deal")).toHaveLength(250 - 84);
  });
});

describe("GET /api/today and the done / snooze actions", () => {
  it("requires login", async () => {
    expect((await SELF.fetch("https://x/api/today")).status).toBe(401);
  });
  it("GET returns { items } built from the current time", async () => {
    const id = await lead("Route lead", { followUpAt: "2020-01-01T00:00:00.000Z" });
    const r = await api("/api/today");
    expect(r.status).toBe(200);
    const { items } = await r.json<{ items: any[] }>();
    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({ id: `follow_up_due:${id}`, kind: "follow_up_due", businessId: id, businessName: "Route lead", due: "2020-01-01T00:00:00.000Z" });
    expect(items[0].priority).toBe(130);
  });
  it("POST done logs today_done with the kind as detail, and the item leaves the queue", async () => {
    const id = await lead("Doer", { followUpAt: "2020-01-01T00:00:00.000Z" });
    const r = await post(`/api/today/follow_up_due/${id}/done`);
    expect(r.status).toBe(200);
    const [row] = (await listActivity(env.DB, id)).filter((a) => a.kind === "today_done");
    expect(row.detail).toBe("follow_up_due");
    expect((await (await api("/api/today")).json<{ items: any[] }>()).items).toEqual([]);
  });
  it("POST snooze logs snoozed with `kind|until` (now + days) and hides the item", async () => {
    const id = await lead("Sleeper", { followUpAt: "2020-01-01T00:00:00.000Z" });
    const before = Date.now();
    const r = await post(`/api/today/follow_up_due/${id}/snooze`, { days: 3 });
    expect(r.status).toBe(200);
    const [row] = (await listActivity(env.DB, id)).filter((a) => a.kind === "snoozed");
    const parsed = parseSnooze(row.detail)!;
    expect(parsed.kind).toBe("follow_up_due");
    expect(parsed.until).toBeGreaterThanOrEqual(before + 3 * DAY - 1000);
    expect(parsed.until).toBeLessThanOrEqual(Date.now() + 3 * DAY + 1000);
    expect((await r.json<any>()).until).toBe(new Date(parsed.until).toISOString());
    expect((await (await api("/api/today")).json<{ items: any[] }>()).items).toEqual([]);
  });
  it("snooze rejects days outside 1-30 or not a whole number with 400, and logs nothing", async () => {
    const id = await lead("Strict", { followUpAt: "2020-01-01T00:00:00.000Z" });
    for (const days of [0, 31, -1, 1.5, "3", null, undefined, NaN])
      expect((await post(`/api/today/follow_up_due/${id}/snooze`, { days })).status, String(days)).toBe(400);
    expect((await post(`/api/today/follow_up_due/${id}/snooze`)).status).toBe(400);
    expect((await listActivity(env.DB, id)).filter((a) => a.kind === "snoozed")).toEqual([]);
    for (const days of [1, 30]) expect((await post(`/api/today/follow_up_due/${id}/snooze`, { days })).status).toBe(200);
  });
  it("404s for an unknown business and 404s for an unknown kind", async () => {
    const id = await lead("Real");
    expect((await post(`/api/today/follow_up_due/nope/done`)).status).toBe(404);
    expect((await post(`/api/today/follow_up_due/nope/snooze`, { days: 1 })).status).toBe(404);
    expect((await post(`/api/today/bogus/${id}/done`)).status).toBe(404);
    expect((await post(`/api/today/bogus/${id}/snooze`, { days: 1 })).status).toBe(404);
  });
});
