import { env, SELF } from "cloudflare:test";
import { describe, it, expect, beforeAll } from "vitest";
import { createSearch } from "../src/worker/db/searches";
import { upsertBusiness, getBusiness, listAllBusinesses, setStarred } from "../src/worker/db/businesses";
import { listActivity } from "../src/worker/db/activity";

let cookie = "";
const api = (path: string, init: RequestInit = {}) =>
  SELF.fetch(`https://x${path}`, { ...init, headers: { cookie, "content-type": "application/json", ...(init.headers ?? {}) } });
const post = (path: string, body: unknown) => api(path, { method: "POST", body: JSON.stringify(body) });
const patch = (path: string, body: unknown) => api(path, { method: "PATCH", body: JSON.stringify(body) });
const bulk = (body: unknown) => post("/api/leads/bulk", body);

beforeAll(async () => {
  const r = await SELF.fetch("https://x/api/login", { method: "POST", body: JSON.stringify({ password: "test-pass" }), headers: { "content-type": "application/json" } });
  cookie = r.headers.get("set-cookie")!.split(";")[0];
});

let searchId = "";
async function lead(name = "Biz", o: { starredAt?: string | null; archived?: boolean; createdAt?: string } = {}) {
  if (!searchId) searchId = (await createSearch(env.DB, { location: "Boise", businessType: "plumber", radiusKm: 10, maxResults: 5 })).id;
  const b = await upsertBusiness(env.DB, { placeId: crypto.randomUUID(), name, category: null, address: null, phone: null, websiteUrl: null, mapsUrl: null, rating: null, reviewCount: null }, searchId);
  await env.DB.prepare(`UPDATE businesses SET starred_at = ?, archived_at = ?, created_at = COALESCE(?, created_at) WHERE id = ?`)
    .bind(o.starredAt ?? null, o.archived ? "2026-01-01T00:00:00.000Z" : null, o.createdAt ?? null, b.id).run();
  return b.id;
}
const kinds = async (id: string) => (await listActivity(env.DB, id)).map((a) => a.kind);

describe("starring one lead", () => {
  it("a new lead is not starred", async () => {
    const id = await lead();
    expect((await getBusiness(env.DB, id))!.starred_at).toBeNull();
  });
  it("PATCH starred:true stamps starred_at and logs one activity row", async () => {
    const id = await lead();
    const r = await patch(`/api/leads/${id}`, { starred: true });
    expect(r.status).toBe(200);
    const b = await r.json<any>();
    expect(Date.parse(b.starred_at)).not.toBeNaN();
    expect(await kinds(id)).toEqual(["starred"]);
  });
  it("starring again keeps the original time and logs nothing more", async () => {
    const id = await lead("Twice", { starredAt: "2026-09-01T00:00:00.000Z" });
    await patch(`/api/leads/${id}`, { starred: true });
    expect((await getBusiness(env.DB, id))!.starred_at).toBe("2026-09-01T00:00:00.000Z");
    expect(await kinds(id)).toEqual([]);
  });
  it("PATCH starred:false clears it and logs unstarred; unstarring an unstarred lead logs nothing", async () => {
    const id = await lead("Off", { starredAt: "2026-09-01T00:00:00.000Z" });
    await patch(`/api/leads/${id}`, { starred: false });
    expect((await getBusiness(env.DB, id))!.starred_at).toBeNull();
    expect(await kinds(id)).toEqual(["unstarred"]);
    await patch(`/api/leads/${id}`, { starred: false });
    expect(await kinds(id)).toEqual(["unstarred"]);
  });
  it("rejects a non-boolean", async () => {
    const id = await lead();
    expect((await patch(`/api/leads/${id}`, { starred: "yes" })).status).toBe(400);
  });
  it("setStarred is a no-op on a missing lead", async () => {
    expect(await setStarred(env.DB, "nope", true)).toBeNull();
  });
});

describe("listing", () => {
  it("lists starred leads first, then newest first, so a star always survives the row limit", async () => {
    for (const t of ["businesses"]) await env.DB.prepare(`DELETE FROM search_results`).run(), await env.DB.prepare(`DELETE FROM ${t}`).run();
    const old = await lead("Old starred", { starredAt: "2026-09-02T00:00:00.000Z", createdAt: "2020-01-01T00:00:00.000Z" });
    const newest = await lead("Newest", { createdAt: "2026-10-04T00:00:00.000Z" });
    const mid = await lead("Mid", { createdAt: "2026-10-03T00:00:00.000Z" });
    const top2 = await listAllBusinesses(env.DB, { limit: 2 });
    expect(top2.map((b) => b.id)).toEqual([old, newest]);
    expect((await listAllBusinesses(env.DB, {})).map((b) => b.id)).toEqual([old, newest, mid]);
  });
  it("the starred filter returns only starred leads, and ?starred=1 works over the API", async () => {
    await env.DB.prepare(`DELETE FROM search_results`).run();
    await env.DB.prepare(`DELETE FROM businesses`).run();
    const a = await lead("A", { starredAt: "2026-09-02T00:00:00.000Z" });
    await lead("B");
    expect((await listAllBusinesses(env.DB, { starred: true })).map((b) => b.id)).toEqual([a]);
    const rows = await (await api("/api/leads?starred=1")).json<any[]>();
    expect(rows.map((r) => r.business.id)).toEqual([a]);
    expect((await (await api("/api/leads")).json<any[]>())).toHaveLength(2);
  });
});

describe("bulk star and unstar", () => {
  it("stars many leads, leaves already-starred ones untouched, and logs a bulk row", async () => {
    const [a, b] = [await lead("A"), await lead("B", { starredAt: "2026-09-01T00:00:00.000Z" })];
    const r = await (await bulk({ ids: [a, b], action: "star" })).json<any>();
    expect(r).toMatchObject({ updated: 1, skipped: 1 });
    expect((await getBusiness(env.DB, a))!.starred_at).not.toBeNull();
    expect((await getBusiness(env.DB, b))!.starred_at).toBe("2026-09-01T00:00:00.000Z");
    expect(await kinds(a)).toContain("bulk");
  });
  it("unstars, and undo puts the exact star time back", async () => {
    const id = await lead("U", { starredAt: "2026-09-01T00:00:00.000Z" });
    const r = await (await bulk({ ids: [id], action: "unstar" })).json<any>();
    expect(r.updated).toBe(1);
    expect((await getBusiness(env.DB, id))!.starred_at).toBeNull();
    const u = await (await post("/api/leads/bulk/undo", { undoToken: r.undoToken })).json<any>();
    expect(u).toMatchObject({ restored: 1, skipped: 0 });
    expect((await getBusiness(env.DB, id))!.starred_at).toBe("2026-09-01T00:00:00.000Z");
  });
  it("undoing a bulk star leaves a lead alone if it was unstarred in the meantime", async () => {
    const id = await lead("Moved");
    const r = await (await bulk({ ids: [id], action: "star" })).json<any>();
    await patch(`/api/leads/${id}`, { starred: false });
    await patch(`/api/leads/${id}`, { starred: true }); // a different star time than the bulk one
    const u = await (await post("/api/leads/bulk/undo", { undoToken: r.undoToken })).json<any>();
    expect(u).toMatchObject({ restored: 0, skipped: 1 });
    expect((await getBusiness(env.DB, id))!.starred_at).not.toBeNull();
  });
});

describe("bulk archive and starred leads", () => {
  it("leaves starred leads alone and says how many", async () => {
    const [plain, starred] = [await lead("Plain"), await lead("Keep", { starredAt: "2026-09-01T00:00:00.000Z" })];
    const r = await (await bulk({ ids: [plain, starred], action: "archive" })).json<any>();
    expect(r).toMatchObject({ updated: 1, keptStarred: 1 });
    expect((await getBusiness(env.DB, plain))!.archived_at).not.toBeNull();
    expect((await getBusiness(env.DB, starred))!.archived_at).toBeNull();
  });
  it("keptStarred is 0 for other actions and when nothing starred is selected", async () => {
    const id = await lead("Solo");
    expect(await (await bulk({ ids: [id], action: "archive" })).json<any>()).toMatchObject({ keptStarred: 0 });
  });
  it("an already-archived starred lead is not counted as kept, and restore still works on it", async () => {
    const id = await lead("Old archive", { starredAt: "2026-09-01T00:00:00.000Z", archived: true });
    expect(await (await bulk({ ids: [id], action: "archive" })).json<any>()).toMatchObject({ updated: 0, keptStarred: 0 });
    expect(await (await bulk({ ids: [id], action: "restore" })).json<any>()).toMatchObject({ updated: 1 });
  });
  it("archiving one starred lead from its own page is a deliberate act and still works", async () => {
    const id = await lead("Single", { starredAt: "2026-09-01T00:00:00.000Z" });
    const r = await post(`/api/leads/${id}/archive`, {});
    expect((await r.json<any>()).archived_at).not.toBeNull();
  });
});
