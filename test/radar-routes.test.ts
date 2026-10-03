import { env, SELF } from "cloudflare:test";
import { describe, it, expect, beforeAll, beforeEach, afterEach } from "vitest";
import { saveSettings } from "../src/worker/db/settings";
import { createSearch } from "../src/worker/db/searches";
import { upsertBusiness } from "../src/worker/db/businesses";
import { MAX_RADARS } from "../src/worker/db/radar";
import { MISSING_MAILING_SETTINGS } from "../src/worker/routes/compliance";

let cookie = "";
const api = (path: string, init: RequestInit = {}) =>
  SELF.fetch(`https://x${path}`, { ...init, headers: { cookie, "content-type": "application/json", ...(init.headers ?? {}) } });
const post = (path: string, body: unknown = {}) => api(path, { method: "POST", body: JSON.stringify(body) });
const patch = (path: string, body: unknown) => api(path, { method: "PATCH", body: JSON.stringify(body) });
const DAY = 86400000;
const near = (iso: string, expectedMs: number) => Math.abs(new Date(iso).getTime() - expectedMs) < 60_000;
const OK = { location: "Boise, ID", businessType: "plumber" };

let created: any[] = [];
let origCreate: any;
let failCreate = false;
beforeAll(async () => {
  const r = await SELF.fetch("https://x/api/login", { method: "POST", body: JSON.stringify({ password: "test-pass" }), headers: { "content-type": "application/json" } });
  cookie = r.headers.get("set-cookie")!.split(";")[0];
});
beforeEach(async () => {
  await env.DB.batch([env.DB.prepare(`DELETE FROM radars`), env.DB.prepare(`DELETE FROM searches`), env.DB.prepare(`DELETE FROM businesses`), env.DB.prepare(`DELETE FROM usage`)]);
  await saveSettings(env.DB, { physical_address: "1 Main St, Boise, ID", opt_out_line: "Reply 'no thanks'.", monthly_spend_limit_usd: 25 });
  created = []; failCreate = false;
  origCreate = env.SEARCH_WORKFLOW.create;
  (env.SEARCH_WORKFLOW as any).create = async (o: any) => { if (failCreate) throw new Error("boom"); created.push(o); return {} as any; };
});
afterEach(() => { (env.SEARCH_WORKFLOW as any).create = origCreate; });

const radarRow = (id: string) => env.DB.prepare(`SELECT * FROM radars WHERE id = ?`).bind(id).first<any>();
const searchCount = async () => (await env.DB.prepare(`SELECT COUNT(*) AS n FROM searches`).first<{ n: number }>())!.n;
async function addRadar(body: Record<string, unknown> = {}) {
  const r = await post("/api/radar", { ...OK, ...body });
  expect(r.status).toBe(201);
  return r.json<any>();
}

describe("radar auth", () => {
  it("every /api/radar route is 401 without a cookie", async () => {
    for (const [m, p] of [["GET", "/api/radar"], ["POST", "/api/radar"], ["PATCH", "/api/radar/x"], ["DELETE", "/api/radar/x"], ["POST", "/api/radar/x/run"]]) {
      expect((await SELF.fetch(`https://x${p}`, { method: m, body: m === "GET" ? undefined : "{}", headers: { "content-type": "application/json" } })).status, `${m} ${p}`).toBe(401);
    }
  });
});

describe("POST /api/radar", () => {
  it("validates input", async () => {
    const bad: Record<string, unknown>[] = [
      { location: "B" }, { businessType: " " }, { radiusKm: 0 }, { radiusKm: 101 }, { maxResults: 0 }, { maxResults: 201 }, { maxResults: 1.5 },
      { intervalDays: 6 }, { intervalDays: 91 }, { intervalDays: 7.5 }, { runNow: "yes" },
    ];
    for (const b of bad) expect((await post("/api/radar", { ...OK, ...b })).status, JSON.stringify(b)).toBe(400);
    expect((await api("/api/radar", { method: "POST", body: "not json" })).status).toBe(400);
    expect(await env.DB.prepare(`SELECT COUNT(*) AS n FROM radars`).first<any>()).toEqual({ n: 0 });
  });

  it("creates with defaults, trims text, schedules the first run one interval out and starts nothing", async () => {
    const r = await post("/api/radar", { location: "  Boise, ID ", businessType: " plumber " });
    expect(r.status).toBe(201);
    const b = await r.json<any>();
    expect(b).toMatchObject({ location: "Boise, ID", business_type: "plumber", radius_km: 15, max_results: 50, interval_days: 30, enabled: 1, last_run_at: null, last_search_id: null, last_error: null });
    expect(near(b.next_run_at, Date.now() + 30 * DAY)).toBe(true);
    expect(await searchCount()).toBe(0);
    expect(created).toEqual([]);
  });

  it("rejects a duplicate market case-insensitively with 409", async () => {
    await addRadar();
    const r = await post("/api/radar", { location: " BOISE, id", businessType: "Plumber", maxResults: 10 });
    expect(r.status).toBe(409);
    expect(await r.json()).toEqual({ error: "a radar for this location and business type already exists" });
    expect((await addRadar({ businessType: "electrician" })).business_type).toBe("electrician");
  });

  it("caps the number of radars", async () => {
    for (let i = 0; i < MAX_RADARS; i++) await addRadar({ location: `City ${i}` });
    const r = await post("/api/radar", { ...OK, location: "One too many" });
    expect(r.status).toBe(409);
    expect((await r.json<any>()).error).toMatch(new RegExp(`${MAX_RADARS}`));
    expect(await env.DB.prepare(`SELECT COUNT(*) AS n FROM radars`).first<any>()).toEqual({ n: MAX_RADARS });
  });

  it("runNow starts the first search through the shared path and schedules the next run", async () => {
    const r = await post("/api/radar", { ...OK, runNow: true, intervalDays: 14, maxResults: 10 });
    expect(r.status).toBe(201);
    const b = await r.json<any>();
    expect(b.last_search_id).toBeTruthy();
    expect(b.last_run_at).toBeTruthy();
    expect(near(b.next_run_at, Date.now() + 14 * DAY)).toBe(true);
    expect(created).toEqual([{ id: `search-${b.last_search_id}`, params: { searchId: b.last_search_id } }]);
    expect(await env.DB.prepare(`SELECT location, max_results FROM searches WHERE id = ?`).bind(b.last_search_id).first()).toEqual({ location: "Boise, ID", max_results: 10 });
  });

  it("runNow rejects BEFORE creating anything when over the spend limit (same 402 as the manual route)", async () => {
    await saveSettings(env.DB, { monthly_spend_limit_usd: 0 });
    const manual = await post("/api/searches", { ...OK, maxResults: 10 });
    const r = await post("/api/radar", { ...OK, maxResults: 10, runNow: true });
    expect(r.status).toBe(402);
    expect(await r.json()).toEqual(await manual.json());
    expect(await env.DB.prepare(`SELECT COUNT(*) AS n FROM radars`).first<any>()).toEqual({ n: 0 });
    expect(await searchCount()).toBe(0);
  });

  it("runNow rejects with the manual route's 400 when mailing settings are missing", async () => {
    await saveSettings(env.DB, { physical_address: "" });
    const r = await post("/api/radar", { ...OK, runNow: true });
    expect(r.status).toBe(400);
    expect(await r.json()).toEqual({ error: MISSING_MAILING_SETTINGS });
    expect(await env.DB.prepare(`SELECT COUNT(*) AS n FROM radars`).first<any>()).toEqual({ n: 0 });
    // Without runNow nothing is spent, so the radar can still be saved.
    expect((await post("/api/radar", OK)).status).toBe(201);
  });

  it("runNow on a duplicate market is a 409 and does not spend", async () => {
    await addRadar();
    expect((await post("/api/radar", { ...OK, runNow: true })).status).toBe(409);
    expect(created).toEqual([]);
  });

  it("runNow with a workflow start failure is a 502 and leaves no radar behind", async () => {
    failCreate = true;
    const r = await post("/api/radar", { ...OK, runNow: true });
    expect(r.status).toBe(502);
    expect(await r.json()).toEqual({ error: "boom" });
    expect(await env.DB.prepare(`SELECT COUNT(*) AS n FROM radars`).first<any>()).toEqual({ n: 0 });
  });
});

describe("GET /api/radar", () => {
  it("lists newest first with newLeadCount and lastSearchStatus", async () => {
    const a = await addRadar({ location: "Alpha" });
    await new Promise((r) => setTimeout(r, 5));
    const b = await addRadar({ location: "Bravo" });
    const s = await createSearch(env.DB, { location: "Alpha", businessType: "plumber", radiusKm: 15, maxResults: 5 });
    const older = await createSearch(env.DB, { location: "Alpha", businessType: "plumber", radiusKm: 15, maxResults: 5 });
    const L = (placeId: string) => ({ placeId, name: placeId, category: null, address: null, phone: null, websiteUrl: null, mapsUrl: null, rating: null, reviewCount: null });
    await upsertBusiness(env.DB, L("p1"), s.id);
    await upsertBusiness(env.DB, L("p2"), s.id);
    await upsertBusiness(env.DB, L("p0"), older.id);
    await upsertBusiness(env.DB, L("p0"), s.id); // seen again: not new
    await env.DB.prepare(`UPDATE radars SET last_search_id = ? WHERE id = ?`).bind(s.id, a.id).run();
    const list = await (await api("/api/radar")).json<any[]>();
    expect(list.map((r) => r.id)).toEqual([b.id, a.id]);
    expect(list[0]).toMatchObject({ newLeadCount: 0, lastSearchStatus: null });
    expect(list[1]).toMatchObject({ newLeadCount: 2, lastSearchStatus: "running" });
  });

  it("is an empty list with no radars", async () => {
    expect(await (await api("/api/radar")).json()).toEqual([]);
  });
});

describe("PATCH /api/radar/:id", () => {
  it("404s a missing radar and validates the body", async () => {
    expect((await patch("/api/radar/nope", { enabled: false })).status).toBe(404);
    const r = await addRadar();
    for (const b of [{ intervalDays: 6 }, { intervalDays: 91 }, { enabled: "no" }, {}]) expect((await patch(`/api/radar/${r.id}`, b)).status, JSON.stringify(b)).toBe(400);
  });

  it("disables without touching the schedule", async () => {
    const r = await addRadar();
    const p = await (await patch(`/api/radar/${r.id}`, { enabled: false })).json<any>();
    expect(p).toMatchObject({ enabled: 0, next_run_at: r.next_run_at });
  });

  it("re-enabling schedules one interval from now and never starts a search", async () => {
    const r = await addRadar({ intervalDays: 30 });
    await env.DB.prepare(`UPDATE radars SET enabled = 0, next_run_at = ? WHERE id = ?`).bind(new Date(Date.now() - 40 * DAY).toISOString(), r.id).run(); // long overdue
    const p = await (await patch(`/api/radar/${r.id}`, { enabled: true })).json<any>();
    expect(p.enabled).toBe(1);
    expect(near(p.next_run_at, Date.now() + 30 * DAY)).toBe(true);
    expect(await searchCount()).toBe(0);
    expect(created).toEqual([]);
  });

  it("re-enabling together with a new interval uses the new interval", async () => {
    const r = await addRadar();
    await patch(`/api/radar/${r.id}`, { enabled: false });
    const p = await (await patch(`/api/radar/${r.id}`, { enabled: true, intervalDays: 7 })).json<any>();
    expect(p.interval_days).toBe(7);
    expect(near(p.next_run_at, Date.now() + 7 * DAY)).toBe(true);
  });

  it("enabling an already-enabled radar leaves the schedule alone", async () => {
    const r = await addRadar();
    const p = await (await patch(`/api/radar/${r.id}`, { enabled: true })).json<any>();
    expect(p.next_run_at).toBe(r.next_run_at);
  });

  it("a shorter interval pulls the next run in; a longer one never delays it", async () => {
    const r = await addRadar({ intervalDays: 30 });
    const shorter = await (await patch(`/api/radar/${r.id}`, { intervalDays: 7 })).json<any>();
    expect(near(shorter.next_run_at, Date.now() + 7 * DAY)).toBe(true);
    const longer = await (await patch(`/api/radar/${r.id}`, { intervalDays: 90 })).json<any>();
    expect(longer.interval_days).toBe(90);
    expect(longer.next_run_at).toBe(shorter.next_run_at);
  });
});

describe("DELETE /api/radar/:id", () => {
  it("404s a missing radar", async () => {
    expect((await api("/api/radar/nope", { method: "DELETE" })).status).toBe(404);
  });

  it("removes the radar but leaves its searches and businesses alone", async () => {
    const r = await addRadar();
    const s = await createSearch(env.DB, { location: "Boise, ID", businessType: "plumber", radiusKm: 15, maxResults: 5 });
    await upsertBusiness(env.DB, { placeId: "p1", name: "Ace", category: null, address: null, phone: null, websiteUrl: null, mapsUrl: null, rating: null, reviewCount: null }, s.id);
    await env.DB.prepare(`UPDATE radars SET last_search_id = ? WHERE id = ?`).bind(s.id, r.id).run();
    const d = await api(`/api/radar/${r.id}`, { method: "DELETE" });
    expect(d.status).toBe(200);
    expect(await d.json()).toEqual({ ok: true });
    expect(await radarRow(r.id)).toBeNull();
    expect(await searchCount()).toBe(1);
    expect(await env.DB.prepare(`SELECT COUNT(*) AS n FROM businesses`).first<any>()).toEqual({ n: 1 });
    expect((await api(`/api/radar/${r.id}`, { method: "DELETE" })).status).toBe(404);
  });
});

describe("POST /api/radar/:id/run", () => {
  it("404s a missing radar", async () => {
    expect((await post("/api/radar/nope/run")).status).toBe(404);
  });

  it("starts a search, records it and advances next_run_at by the interval", async () => {
    const r = await addRadar({ intervalDays: 14, maxResults: 10 });
    const res = await post(`/api/radar/${r.id}/run`);
    expect(res.status).toBe(200);
    const b = await res.json<any>();
    expect(b.last_search_id).toBeTruthy();
    expect(b.last_error).toBeNull();
    expect(near(b.next_run_at, Date.now() + 14 * DAY)).toBe(true);
    expect(created).toEqual([{ id: `search-${b.last_search_id}`, params: { searchId: b.last_search_id } }]);
  });

  it("402 spend limit, exactly like the manual route, and the schedule is not pushed out", async () => {
    const r = await addRadar({ maxResults: 10 });
    await saveSettings(env.DB, { monthly_spend_limit_usd: 0 });
    const manual = await post("/api/searches", { ...OK, maxResults: 10 });
    const res = await post(`/api/radar/${r.id}/run`);
    expect(res.status).toBe(402);
    expect(await res.json()).toEqual(await manual.json());
    expect(created).toEqual([]);
    const row = await radarRow(r.id);
    expect(row.last_search_id).toBeNull();
    expect(row.last_error).toMatch(/spend limit/i);
    expect(row.next_run_at).toBe(r.next_run_at); // not due yet: a blocked manual run must not reschedule
  });

  it("400 when mailing settings are missing", async () => {
    const r = await addRadar();
    await saveSettings(env.DB, { opt_out_line: "" });
    const res = await post(`/api/radar/${r.id}/run`);
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: MISSING_MAILING_SETTINGS });
    expect(created).toEqual([]);
  });

  it("502 when the workflow cannot start", async () => {
    const r = await addRadar();
    failCreate = true;
    const res = await post(`/api/radar/${r.id}/run`);
    expect(res.status).toBe(502);
    expect(await res.json()).toEqual({ error: "boom" });
    expect((await radarRow(r.id)).last_error).toBe("boom");
  });

  it("409 for a disabled radar", async () => {
    const r = await addRadar();
    await patch(`/api/radar/${r.id}`, { enabled: false });
    expect((await post(`/api/radar/${r.id}/run`)).status).toBe(409);
    expect(created).toEqual([]);
  });

  it("a double-click starts exactly one search", async () => {
    const r = await addRadar();
    const rs = await Promise.all([post(`/api/radar/${r.id}/run`), post(`/api/radar/${r.id}/run`)]);
    expect(rs.map((x) => x.status).sort()).toEqual([200, 409]);
    expect(created).toHaveLength(1);
    expect(await searchCount()).toBe(1);
  });

  it("a second click right after the first is refused too", async () => {
    const r = await addRadar();
    expect((await post(`/api/radar/${r.id}/run`)).status).toBe(200);
    expect((await post(`/api/radar/${r.id}/run`)).status).toBe(409);
    expect(created).toHaveLength(1);
  });
});
