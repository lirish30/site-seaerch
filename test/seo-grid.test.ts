import { createExecutionContext, env } from "cloudflare:test";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import worker from "../src/worker/index";
import { listActivity } from "../src/worker/db/activity";
import { addKeyword, getProfile, listKeywords, rankChecksFor, setKeywordActive, snapshotsFor, upsertProfile } from "../src/worker/db/seo";
import type { Env } from "../src/worker/env";
import { runBaseline } from "../src/worker/seo/baseline";
import { MIN_MEASURED_POINTS, gridPoints, isUsable, radiusMeters, runRankGrid } from "../src/worker/seo/grid";
import { SeoRefusal, setupProfile } from "../src/worker/seo/profile";
import { seedClient } from "./fixtures/clients";
import { E } from "./fixtures/close";

const KEY = "AIza-SECRET-KEY-123";
const e = { ...E, GOOGLE_PLACES_API_KEY: KEY } as Env;
// 18:00 UTC is 10:00 in the booking zone (America/Los_Angeles): the local day is 2026-12-02.
const NOW = new Date("2026-12-02T18:00:00.000Z");
const DAY = "2026-12-02";
const ctx = () => createExecutionContext();
const jsonRes = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
const html = (body: string) => new Response(`<html><head><title>Ace</title></head><body>${body}</body></html>`, { headers: { "content-type": "text/html" } });

const DETAILS = {
  id: "ChIJace", displayName: { text: "Ace Plumbing" }, formattedAddress: "12345 SW Main St, Tigard, OR 97224, USA", nationalPhoneNumber: "(503) 555-0147",
  websiteUri: "https://ace.com/", googleMapsUri: "https://maps.google.com/?cid=42", rating: 4.6, userRatingCount: 80, location: { latitude: 45.43, longitude: -122.77 },
  primaryTypeDisplayName: { text: "Plumber" }, photos: [{}, {}, {}], regularOpeningHours: {}, reviews: [],
};
const SETUP = { placeId: "ChIJace", trade: "plumber", towns: ["Tigard"], gridKm: 3 };

interface Search { term: string; lat: number; lng: number; radius: number }
let urls: string[] = [];
let searches: Search[] = [];
type Handler = (url: string, init?: RequestInit) => Response | Promise<Response>;
function stub(h: Handler) {
  urls = [];
  searches = [];
  vi.stubGlobal("fetch", vi.fn(async (u: string | URL | Request, init?: RequestInit) => {
    const url = String(u);
    urls.push(url);
    if (url.endsWith("places:searchText") && typeof init?.body === "string") {
      const b = JSON.parse(init.body) as { textQuery: string; locationBias: { circle: { center: { latitude: number; longitude: number }; radius: number } } };
      searches.push({ term: b.textQuery, lat: b.locationBias.circle.center.latitude, lng: b.locationBias.circle.center.longitude, radius: b.locationBias.circle.radius });
    }
    return h(url, init);
  }));
}
/** Google: the details answer, the search answer for call number `n` (0-based) given by `search`, and the client's site. */
const google = (search: (n: number, s: Search) => Response): Handler => (u) => {
  if (u.endsWith("places:searchText")) return search(searches.length - 1, searches[searches.length - 1]);
  if (u.startsWith("https://places.googleapis.com/v1/places/")) return jsonRes(DETAILS);
  if (u === "https://ace.com/") return html("<h1>Ace Plumbing</h1><p>12345 SW Main St</p><a href='tel:5035550147'>Call</a>");
  return new Response("", { status: 404 });
};
const found = (pos: number | null) => jsonRes({ places: pos === null ? [{ id: "other" }] : [...Array.from({ length: pos - 1 }, (_, i) => ({ id: `x${i}` })), { id: "ChIJace" }] });
const placesCalls = () => urls.filter((u) => u.startsWith("https://places.googleapis.com/")).length;

const rad = (d: number) => (d * Math.PI) / 180;
function km(a: { lat: number; lng: number }, b: { lat: number; lng: number }): number {
  const h = Math.sin(rad(b.lat - a.lat) / 2) ** 2 + Math.cos(rad(a.lat)) * Math.cos(rad(b.lat)) * Math.sin(rad(b.lng - a.lng) / 2) ** 2;
  return 2 * 6371 * Math.asin(Math.sqrt(h));
}

let cookie = "";
async function jcall(method: string, path: string, body: unknown, status = 200, o: { env?: Env } = {}) {
  if (!cookie) {
    const login = await worker.fetch(new Request("https://x/api/login", { method: "POST", body: JSON.stringify({ password: "test-pass" }), headers: { "content-type": "application/json" } }), E, ctx());
    cookie = login.headers.get("set-cookie")!.split(";")[0];
  }
  const r = await worker.fetch(new Request(`https://x/api${path}`, { method, body: JSON.stringify(body), headers: { cookie, "content-type": "application/json" } }), o.env ?? e, ctx());
  const text = await r.text();
  expect(r.status, `${method} ${path} ${text}`).toBe(status);
  expect(text).not.toContain(KEY);
  return JSON.parse(text) as any;
}

beforeEach(async () => {
  vi.spyOn(console, "error").mockImplementation(() => {});
  for (const t of ["seo_rank_checks", "seo_gbp_snapshots", "seo_citations", "seo_keywords", "seo_profiles"]) await env.DB.prepare(`DELETE FROM ${t}`).run();
});
afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); });

/** A client with a set-up profile (place `ChIJace`, grid 3 km) and the given keywords. */
async function ready(keywords: { term: string; town: string }[] = [{ term: "plumber", town: "Tigard" }]) {
  const s = await seedClient();
  stub(google(() => found(null)));
  await setupProfile(e, s.businessId, SETUP, NOW.toISOString());
  const ids: string[] = [];
  for (const k of keywords) ids.push((await addKeyword(env.DB, s.businessId, k, NOW.toISOString())).keyword.id);
  return { ...s, ids };
}

describe("gridPoints, radiusMeters and isUsable", () => {
  const centre = { lat: 45.4, lng: -122.7 };

  it("gives 9 points row by row from the north-west with the centre at index 4 and neighbours 3 km apart", () => {
    const g = gridPoints(centre, 3);
    expect(g).toHaveLength(9);
    expect(g[4]).toEqual(centre);
    expect(g[0].lat).toBeGreaterThan(centre.lat);
    expect(g[0].lng).toBeLessThan(centre.lng);
    expect(g[2].lng).toBeGreaterThan(centre.lng);
    expect(g[8].lat).toBeLessThan(centre.lat);
    expect(g[1].lng).toBeCloseTo(centre.lng, 9);
    expect(g[3].lat).toBeCloseTo(centre.lat, 9);
    for (const [a, b] of [[4, 1], [4, 7], [4, 3], [4, 5], [0, 1], [1, 2], [0, 3], [6, 7], [5, 8]]) expect(Math.abs(km(g[a], g[b]) / 3 - 1), `${a}-${b}`).toBeLessThan(0.01);
  });

  it("makes circles that meet: the radius is half the spacing in metres, and the largest grid stays inside Google's cap", () => {
    expect(radiusMeters(3)).toBe(1500);
    expect(radiusMeters(10)).toBe(5000);
    expect(radiusMeters(10)).toBeLessThanOrEqual(50_000);
  });

  it("calls a check usable from 7 measured points", () => {
    const pts = (ok: number) => Array.from({ length: 9 }, (_, i) => ({ lat: 1, lng: 1, pos: null, ok: i < ok }));
    expect(MIN_MEASURED_POINTS).toBe(7);
    expect(isUsable(pts(6))).toBe(false);
    expect(isUsable(pts(7))).toBe(true);
    expect(isUsable([])).toBe(false);
  });
});

describe("runRankGrid", () => {
  it("searches '<term> <town>' from each of the 9 points with the radius, and a keyword without a town as is", async () => {
    const s = await ready([{ term: "plumber", town: "Tigard" }, { term: "emergency plumber", town: "" }]);
    stub(google(() => found(null)));
    expect(await runRankGrid(e, s.businessId, NOW)).toEqual({ checked: 2, unmeasured: 0 });
    expect(searches).toHaveLength(18);
    expect(new Set(searches.slice(0, 9).map((q) => q.term))).toEqual(new Set(["plumber Tigard"]));
    expect(new Set(searches.slice(9).map((q) => q.term))).toEqual(new Set(["emergency plumber"]));
    expect(new Set(searches.map((q) => q.radius))).toEqual(new Set([1500]));
    const g = gridPoints({ lat: 45.43, lng: -122.77 }, 3);
    expect(searches.slice(0, 9).map((q) => ({ lat: q.lat, lng: q.lng }))).toEqual(g);
  });

  it("stores positions as given: 2 is 2, not found is null, and every point that answered is ok", async () => {
    const s = await ready();
    stub(google((n) => (n === 4 ? found(2) : n === 0 ? found(1) : found(null))));
    await runRankGrid(e, s.businessId, NOW);
    const [row] = await rankChecksFor(env.DB, s.businessId, {});
    expect(row).toMatchObject({ keywordId: s.ids[0], takenOn: DAY });
    expect(row.points).toHaveLength(9);
    expect(row.points.map((p) => p.pos)).toEqual([1, null, null, null, 2, null, null, null, null]);
    expect(row.points.every((p) => p.ok)).toBe(true);
    expect(row.points[4]).toEqual({ lat: 45.43, lng: -122.77, pos: 2, ok: true });
  });

  it("marks a point whose call failed as not ok with no position (never 0), and the check is still usable with 7 measured", async () => {
    const s = await ready();
    stub(google((n) => (n === 0 || n === 8 ? new Response("boom", { status: 500 }) : found(3))));
    expect(await runRankGrid(e, s.businessId, NOW)).toEqual({ checked: 1, unmeasured: 0 });
    const [row] = await rankChecksFor(env.DB, s.businessId, {});
    expect(row.points[0]).toMatchObject({ pos: null, ok: false });
    expect(row.points[8]).toMatchObject({ pos: null, ok: false });
    expect(row.points.filter((p) => p.ok)).toHaveLength(7);
    expect(row.points.every((p) => p.pos !== 0)).toBe(true);
    expect(isUsable(row.points)).toBe(true);
  });

  it("counts a keyword with fewer than 7 measured points as unmeasured", async () => {
    const s = await ready();
    stub(google((n) => (n % 3 === 0 ? new Response("", { status: 400 }) : found(1))));
    // points 0, 3, 6 fail with a 400 (not retryable): 6 measured
    expect(await runRankGrid(e, s.businessId, NOW)).toEqual({ checked: 1, unmeasured: 1 });
  });

  it("stops the whole run after 3 retryable errors in a row: the keyword in progress keeps what it measured, the ones not reached get no row", async () => {
    const s = await ready([{ term: "plumber", town: "Tigard" }, { term: "drain cleaning", town: "Tigard" }]);
    stub(google((n) => (n < 2 ? found(1) : new Response("slow down", { status: 429 }))));
    expect(await runRankGrid(e, s.businessId, NOW)).toEqual({ checked: 1, unmeasured: 2 });
    expect(searches).toHaveLength(5); // 2 measured, then 3 refusals, then nothing more
    const rows = await rankChecksFor(env.DB, s.businessId, {});
    expect(rows).toHaveLength(1);
    expect(rows[0].keywordId).toBe(s.ids[0]);
    expect(rows[0].points.map((p) => p.ok)).toEqual([true, true, false, false, false, false, false, false, false]);
    expect(rows[0].points.every((p) => p.pos === null || p.ok)).toBe(true);
    expect(rows[0].points[0].pos).toBe(1);
  });

  it("does not stop for errors that are not in a row: a success between them starts the count again", async () => {
    const s = await ready();
    stub(google((n) => (n % 3 === 2 ? found(1) : new Response("", { status: 429 }))));
    expect(await runRankGrid(e, s.businessId, NOW)).toEqual({ checked: 1, unmeasured: 1 });
    expect(searches).toHaveLength(9);
  });

  it("does not count errors that cannot be retried, and are not about the key, towards stopping the run", async () => {
    const s = await ready();
    stub(google(() => new Response("", { status: 400 })));
    expect(await runRankGrid(e, s.businessId, NOW)).toEqual({ checked: 1, unmeasured: 1 });
    expect(searches).toHaveLength(9);
  });

  it("stops the whole run at the first 401 or 403 (a key Google refuses): one call for the first keyword, nothing for the others, and the day's row says 'not checked' everywhere", async () => {
    for (const status of [401, 403]) {
      const s = await ready([{ term: "plumber", town: "Tigard" }, { term: "drain cleaning", town: "Tigard" }]);
      stub(google(() => new Response("{}", { status })));
      expect(await runRankGrid(e, s.businessId, NOW)).toEqual({ checked: 1, unmeasured: 2 });
      expect(searches, String(status)).toHaveLength(1);
      const rows = await rankChecksFor(env.DB, s.businessId, {});
      expect(rows).toHaveLength(1);
      expect(rows[0].points.every((p) => !p.ok && p.pos === null)).toBe(true);
      await env.DB.prepare(`DELETE FROM seo_rank_checks`).run();
    }
  });

  it("keeps one row per keyword when run twice on one local day, and the second run's points win", async () => {
    const s = await ready([{ term: "plumber", town: "Tigard" }, { term: "drain cleaning", town: "" }]);
    stub(google(() => found(5)));
    await runRankGrid(e, s.businessId, NOW);
    stub(google(() => found(2)));
    // 02:00 UTC the next day is still 2026-12-02 on the booking-zone clock
    await runRankGrid(e, s.businessId, new Date("2026-12-03T02:00:00.000Z"));
    const rows = await rankChecksFor(env.DB, s.businessId, {});
    expect(rows).toHaveLength(2);
    expect(rows.every((r) => r.takenOn === DAY && r.points.every((p) => p.pos === 2))).toBe(true);
  });

  it("a throttled rerun the same day does not degrade a good row", async () => {
    const s = await ready();
    stub(google(() => found(5)));
    await runRankGrid(e, s.businessId, NOW);
    stub(google(() => new Response("boom", { status: 500 })));
    expect(await runRankGrid(e, s.businessId, new Date("2026-12-02T20:00:00.000Z"))).toEqual({ checked: 1, unmeasured: 0 });
    const [row] = await rankChecksFor(env.DB, s.businessId, {});
    expect(row.points.every((p) => p.ok && p.pos === 5)).toBe(true);
  });

  it("keeps the earlier measurement where a rerun's point failed, and takes the rerun's where it measured", async () => {
    const s = await ready();
    stub(google((n) => (n === 0 || n === 8 ? new Response("", { status: 400 }) : found(3))));
    await runRankGrid(e, s.businessId, NOW);
    stub(google((n) => (n === 2 || n === 4 || n === 8 ? new Response("", { status: 400 }) : found(1))));
    await runRankGrid(e, s.businessId, new Date("2026-12-02T20:00:00.000Z"));
    const [row] = await rankChecksFor(env.DB, s.businessId, {});
    expect(row.points.map((p) => [p.ok, p.pos])).toEqual([[true, 1], [true, 1], [true, 3], [true, 1], [true, 3], [true, 1], [true, 1], [true, 1], [false, null]]);
  });

  it("a throttled rerun writes no row for a keyword it never got to, and leaves that keyword's good row alone", async () => {
    const s = await ready([{ term: "plumber", town: "Tigard" }, { term: "drain cleaning", town: "Tigard" }]);
    stub(google(() => found(2)));
    await runRankGrid(e, s.businessId, NOW);
    stub(google(() => new Response("", { status: 429 })));
    expect(await runRankGrid(e, s.businessId, NOW)).toEqual({ checked: 1, unmeasured: 1 });
    expect(searches).toHaveLength(3);
    const rows = await rankChecksFor(env.DB, s.businessId, {});
    expect(rows).toHaveLength(2);
    expect(rows.every((r) => r.points.every((p) => p.ok && p.pos === 2))).toBe(true);
  });

  it("skips a keyword that was switched off", async () => {
    const s = await ready([{ term: "plumber", town: "Tigard" }, { term: "drain cleaning", town: "Tigard" }]);
    await setKeywordActive(env.DB, s.ids[1], false);
    stub(google(() => found(1)));
    expect(await runRankGrid(e, s.businessId, NOW)).toEqual({ checked: 1, unmeasured: 0 });
    expect(searches.every((q) => q.term === "plumber Tigard")).toBe(true);
    expect((await rankChecksFor(env.DB, s.businessId, {})).map((r) => r.keywordId)).toEqual([s.ids[0]]);
  });

  it("refuses a profile with no place, and makes no request", async () => {
    const s = await seedClient();
    await upsertProfile(env.DB, s.businessId, { trade: "plumber", napName: "Ace" }, NOW.toISOString());
    stub(google(() => found(1)));
    const err = await runRankGrid(e, s.businessId, NOW).catch((x: unknown) => x);
    expect(err).toBeInstanceOf(SeoRefusal);
    expect((err as SeoRefusal).message).toMatch(/place/i);
    expect(placesCalls()).toBe(0);
  });

  it("refuses, rather than storing a grid of failures, when the Places key is not set", async () => {
    const s = await ready();
    stub(google(() => found(1)));
    const err = await runRankGrid(E as Env, s.businessId, NOW).catch((x: unknown) => x);
    expect(err).toBeInstanceOf(SeoRefusal);
    expect((err as SeoRefusal).message).toMatch(/not set up/i);
    expect(await rankChecksFor(env.DB, s.businessId, {})).toEqual([]);
    expect(urls).toEqual([]);
  });
});

describe("runBaseline", () => {
  it("refuses a profile with no place id, or no profile, with a plain sentence and nothing written", async () => {
    const s = await seedClient();
    stub(google(() => found(1)));
    const none = await runBaseline(e, s.businessId, NOW).catch((x: unknown) => x);
    expect(none).toBeInstanceOf(SeoRefusal);
    await upsertProfile(env.DB, s.businessId, { trade: "plumber", napName: "Ace" }, NOW.toISOString());
    const err = await runBaseline(e, s.businessId, NOW).catch((x: unknown) => x);
    expect(err).toBeInstanceOf(SeoRefusal);
    expect((err as SeoRefusal).message).toMatch(/place/i);
    expect((err as SeoRefusal).message).not.toContain(KEY);
    expect(placesCalls()).toBe(0);
    expect(await snapshotsFor(env.DB, s.businessId, {})).toEqual([]);
    expect((await getProfile(env.DB, s.businessId))!.status).toBe("setup");
  });

  it("writes one snapshot, the NAP result, one rank row per keyword, makes the profile active, and logs one activity line even when run twice that day", async () => {
    const s = await ready([{ term: "plumber", town: "Tigard" }, { term: "drain cleaning", town: "" }]);
    stub(google((n) => (n % 2 === 0 ? found(3) : found(null))));
    const r = await runBaseline(e, s.businessId, NOW);
    expect(r.snapshot).toEqual({ businessId: s.businessId, takenOn: DAY, rating: 4.6, reviewCount: 80, category: "Plumber", photoCount: 3, hasHours: true });
    expect(r.nap).toEqual({ phone: "match", address: "match", name: "match", checkedPages: 1 });
    expect(r.ranked).toBe(2);

    const profile = (await getProfile(env.DB, s.businessId))!;
    expect(profile.status).toBe("active");
    expect(JSON.parse(profile.napResult!)).toEqual(r.nap);
    expect(await snapshotsFor(env.DB, s.businessId, {})).toEqual([r.snapshot]);
    expect(await rankChecksFor(env.DB, s.businessId, {})).toHaveLength(2);

    await runBaseline(e, s.businessId, new Date("2026-12-02T20:00:00.000Z"));
    expect(await snapshotsFor(env.DB, s.businessId, {})).toHaveLength(1);
    expect(await rankChecksFor(env.DB, s.businessId, {})).toHaveLength(2);
    const lines = (await listActivity(env.DB, s.businessId)).filter((a) => a.kind === "seo_baseline");
    expect(lines).toHaveLength(1);
    expect(lines[0].detail).toContain(DAY);
    expect(lines[0].detail).not.toMatch(/rank(s|ing)? (#|first|top)|guarantee|promis/i);
  });

  it("logs a new line on a new local day", async () => {
    const s = await ready();
    stub(google(() => found(1)));
    await runBaseline(e, s.businessId, NOW);
    await runBaseline(e, s.businessId, new Date("2026-12-03T18:00:00.000Z"));
    expect((await listActivity(env.DB, s.businessId)).filter((a) => a.kind === "seo_baseline")).toHaveLength(2);
  });

  it("a baseline with a keyword that could not be measured counts only the ranked ones", async () => {
    const s = await ready([{ term: "plumber", town: "Tigard" }, { term: "drain cleaning", town: "" }]);
    stub(google((n) => (n >= 9 && n % 2 === 0 ? new Response("", { status: 403 }) : found(1))));
    const r = await runBaseline(e, s.businessId, NOW);
    expect(r.ranked).toBe(1);
  });

  it("carries on past a name, address and phone check that cannot be done: the grid runs, the watch starts, nap is null with a note", async () => {
    const s = await ready();
    stub((u, i) => (u === "https://ace.com/" ? new Response("", { status: 500 }) : google(() => found(2))(u, i)));
    const down = await runBaseline(e, s.businessId, NOW);
    expect(down.nap).toBeNull();
    expect(down.napNote).toMatch(/couldn't|could not/i);
    expect(down.ranked).toBe(1);
    expect(down.snapshot).toMatchObject({ rating: 4.6 });
    expect(await rankChecksFor(env.DB, s.businessId, {})).toHaveLength(1);
    const profile = (await getProfile(env.DB, s.businessId))!;
    expect(profile.status).toBe("active");
    expect(profile.napResult).toBeNull();

    await env.DB.prepare(`UPDATE sites SET url = NULL, domain = NULL WHERE business_id = ?`).bind(s.businessId).run();
    stub(google(() => found(2)));
    const none = await runBaseline(e, s.businessId, NOW);
    expect(none.nap).toBeNull();
    expect(none.napNote).toMatch(/website|site/i);
    expect(none.ranked).toBe(1);
  });

  it("does not make the profile active when Google cannot be reached, and says so plainly", async () => {
    const s = await ready();
    stub((u) => (u.startsWith("https://places.googleapis.com/v1/places/") ? new Response("", { status: 500 }) : google(() => found(1))(u)));
    const err = await runBaseline(e, s.businessId, NOW).catch((x: unknown) => x);
    expect(err).toBeInstanceOf(SeoRefusal);
    expect((err as SeoRefusal).message).not.toContain(KEY);
    expect((await getProfile(env.DB, s.businessId))!.status).toBe("setup");
    expect(await rankChecksFor(env.DB, s.businessId, {})).toEqual([]);
  });
});

describe("the baseline and rank-check routes", () => {
  it("POST /seo/baseline takes the baseline and answers with the snapshot, the NAP result and the count ranked", async () => {
    const s = await ready();
    stub(google(() => found(2)));
    const r = await jcall("POST", `/clients/${s.businessId}/seo/baseline`, {});
    expect(r.ranked).toBe(1);
    expect(r.nap).toMatchObject({ name: "match" });
    expect(r.snapshot).toMatchObject({ rating: 4.6, reviewCount: 80 });
    expect(r.snapshot.takenOn).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    expect((await getProfile(env.DB, s.businessId))!.status).toBe("active");
  });

  it("POST /seo/rank-check checks the grid now, leaves the profile's status alone, and says how many were measured", async () => {
    const s = await ready([{ term: "plumber", town: "Tigard" }, { term: "drain cleaning", town: "" }]);
    stub(google(() => found(4)));
    expect(await jcall("POST", `/clients/${s.businessId}/seo/rank-check`, {})).toEqual({ checked: 2, unmeasured: 0 });
    expect((await getProfile(env.DB, s.businessId))!.status).toBe("setup");
    expect(await rankChecksFor(env.DB, s.businessId, {})).toHaveLength(2);
  });

  it("answers 409 in a plain sentence without a place, 404 for something that is not a client, and 503 without a Places key", async () => {
    const s = await seedClient();
    stub(google(() => found(1)));
    const none = await jcall("POST", `/clients/${s.businessId}/seo/baseline`, {}, 409);
    expect(none.error).toMatch(/profile|place/i);
    await upsertProfile(env.DB, s.businessId, { trade: "plumber" }, NOW.toISOString());
    expect((await jcall("POST", `/clients/${s.businessId}/seo/rank-check`, {}, 409)).error).toMatch(/place/i);
    await jcall("POST", `/clients/nobody/seo/baseline`, {}, 404);
    await jcall("POST", `/clients/nobody/seo/rank-check`, {}, 404);
    const ready2 = await ready();
    expect((await jcall("POST", `/clients/${ready2.businessId}/seo/rank-check`, {}, 503, { env: E as Env })).error).toMatch(/not set up|Places key/i);
    expect((await listKeywords(env.DB, ready2.businessId)).length).toBe(1);
  });
});
