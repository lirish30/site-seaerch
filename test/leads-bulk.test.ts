import { env, SELF } from "cloudflare:test";
import { describe, it, expect, beforeAll } from "vitest";
import { createSearch } from "../src/worker/db/searches";
import { upsertBusiness, getBusiness, updateLead, listAllBusinesses, listBusinessesForSearch, loadMatchPool, normalizeTag } from "../src/worker/db/businesses";
import { listActivity } from "../src/worker/db/activity";

let cookie = "";
const api = (path: string, init: RequestInit = {}) =>
  SELF.fetch(`https://x${path}`, { ...init, headers: { cookie, "content-type": "application/json", ...(init.headers ?? {}) } });
const post = (path: string, body: unknown) => api(path, { method: "POST", body: JSON.stringify(body) });
const bulk = (body: unknown) => post("/api/leads/bulk", body);

beforeAll(async () => {
  const r = await SELF.fetch("https://x/api/login", { method: "POST", body: JSON.stringify({ password: "test-pass" }), headers: { "content-type": "application/json" } });
  cookie = r.headers.get("set-cookie")!.split(";")[0];
});

let searchId = "";
async function lead(name = "Biz", o: { status?: string; archived?: boolean; tags?: string[]; contactedAt?: string | null } = {}) {
  if (!searchId) searchId = (await createSearch(env.DB, { location: "Boise", businessType: "plumber", radiusKm: 10, maxResults: 5 })).id;
  const b = await upsertBusiness(env.DB, { placeId: crypto.randomUUID(), name: name, category: null, address: null, phone: null, websiteUrl: null, mapsUrl: null, rating: null, reviewCount: null }, searchId);
  await env.DB.prepare(`UPDATE businesses SET lead_status = ?, archived_at = ?, tags = ?, contacted_at = ? WHERE id = ?`)
    .bind(o.status ?? "new", o.archived ? "2026-01-01T00:00:00.000Z" : null, JSON.stringify(o.tags ?? []), o.contactedAt ?? null, b.id).run();
  return b.id;
}
const leads = async (n: number, o: Parameters<typeof lead>[1] = {}) => Promise.all(Array.from({ length: n }, (_, i) => lead(`L${i}`, o)));
const bulkActivity = async (id: string) => (await listActivity(env.DB, id)).filter((a) => a.kind === "bulk");

describe("tags on reads", () => {
  it("every read path exposes tags as a string array, never the raw JSON", async () => {
    const id = await lead("Tagged", { tags: ["a", "b"] });
    expect((await getBusiness(env.DB, id))!.tags).toEqual(["a", "b"]);
    expect((await listAllBusinesses(env.DB, {})).find((b) => b.id === id)!.tags).toEqual(["a", "b"]);
    expect((await listBusinessesForSearch(env.DB, searchId, { hideSkipped: false })).find((b) => b.id === id)!.tags).toEqual(["a", "b"]);
    expect((await loadMatchPool(env.DB)).find((b) => b.id === id)!.tags).toEqual(["a", "b"]);
    const rows = await (await api("/api/leads?limit=500")).json<any[]>();
    expect(rows.find((r) => r.business.id === id).business.tags).toEqual(["a", "b"]);
  });
  it("a row written before the column existed, or holding bad JSON, reads as no tags", async () => {
    const id = await lead("Odd");
    await env.DB.prepare(`UPDATE businesses SET tags = 'not json' WHERE id = ?`).bind(id).run();
    expect((await getBusiness(env.DB, id))!.tags).toEqual([]);
  });
});

describe("tag normalisation", () => {
  it("trims, lowercases, collapses spaces and strips other characters", () => {
    expect(normalizeTag("  Hot   LEAD ")).toBe("hot lead");
    expect(normalizeTag("Follow-up_1!!")).toBe("follow-up_1");
    expect(normalizeTag("a\n\tb")).toBe("a b");
    expect(normalizeTag("<b>x</b>")).toBe("bxb");
  });
  it("returns null for empty or over-long results", () => {
    expect(normalizeTag("   ")).toBeNull();
    expect(normalizeTag("!!!")).toBeNull();
    expect(normalizeTag("x".repeat(33))).toBeNull();
    expect(normalizeTag("x".repeat(32))).toBe("x".repeat(32));
  });
});

describe("POST /api/leads/bulk", () => {
  it("sets a status on every id and logs one bulk activity row each", async () => {
    const ids = await leads(3);
    const r = await bulk({ ids, action: "status", status: "contacted" });
    expect(r.status).toBe(200);
    const body = await r.json<any>();
    expect(body.updated).toBe(3);
    expect(typeof body.undoToken).toBe("string");
    for (const id of ids) {
      const b = (await getBusiness(env.DB, id))!;
      expect(b.lead_status).toBe("contacted");
      expect(b.contacted_at).toBeTruthy();
      const acts = await bulkActivity(id);
      expect(acts).toHaveLength(1);
      expect(acts[0].detail).toBe("status → contacted (bulk)");
    }
  });

  it("ignores unknown ids and does not count them", async () => {
    const [a] = await leads(1);
    const body = await (await bulk({ ids: [a, "nope-1", "nope-2"], action: "status", status: "reviewed" })).json<any>();
    expect(body.updated).toBe(1);
    expect((await getBusiness(env.DB, a))!.lead_status).toBe("reviewed");
  });

  it("returns updated 0 and no token when nothing changed", async () => {
    const body = await (await bulk({ ids: ["nope"], action: "archive" })).json<any>();
    expect(body).toEqual({ updated: 0, skipped: 0, keptStarred: 0, undoToken: null });
  });

  it("treats a duplicate id once", async () => {
    const [a] = await leads(1);
    const body = await (await bulk({ ids: [a, a, a], action: "status", status: "lost" })).json<any>();
    expect(body.updated).toBe(1);
    expect(await bulkActivity(a)).toHaveLength(1);
  });

  it("skips leads already in the requested state without logging them", async () => {
    const [a, b] = await Promise.all([lead("A", { status: "won" }), lead("B", { status: "new" })]);
    const body = await (await bulk({ ids: [a, b], action: "status", status: "won" })).json<any>();
    expect(body).toMatchObject({ updated: 1, skipped: 1 });
    expect(await bulkActivity(a)).toHaveLength(0);
  });

  it("archives and restores", async () => {
    const ids = await leads(2);
    expect((await (await bulk({ ids, action: "archive" })).json<any>()).updated).toBe(2);
    for (const id of ids) {
      expect((await getBusiness(env.DB, id))!.archived_at).toBeTruthy();
      expect((await bulkActivity(id))[0].detail).toBe("archive (bulk)");
    }
    expect((await (await bulk({ ids, action: "restore" })).json<any>()).updated).toBe(2);
    for (const id of ids) expect((await getBusiness(env.DB, id))!.archived_at).toBeNull();
  });

  it("rejects bad input with 400: >200 ids, no ids, delete or unknown action, bad status, missing tag", async () => {
    const many = Array.from({ length: 201 }, (_, i) => `id-${i}`);
    expect((await bulk({ ids: many, action: "archive" })).status).toBe(400);
    expect((await bulk({ ids: Array.from({ length: 200 }, (_, i) => `id-${i}`), action: "archive" })).status).toBe(200);
    expect((await bulk({ ids: [], action: "archive" })).status).toBe(400);
    expect((await bulk({ action: "archive" })).status).toBe(400);
    const [a] = await leads(1);
    expect((await bulk({ ids: [a], action: "delete" })).status).toBe(400);
    expect((await bulk({ ids: [a], action: "purge" })).status).toBe(400);
    expect((await bulk({ ids: [a], action: "status", status: "bogus" })).status).toBe(400);
    expect((await bulk({ ids: [a], action: "status" })).status).toBe(400);
    expect((await bulk({ ids: [a], action: "tag" })).status).toBe(400);
    expect((await bulk({ ids: [a], action: "tag", tag: "   " })).status).toBe(400);
    expect((await bulk({ ids: [a], action: "untag", tag: "x".repeat(33) })).status).toBe(400);
    expect((await api("/api/leads/bulk", { method: "POST", body: "{not json" })).status).toBe(400);
    expect((await getBusiness(env.DB, a))!.lead_status).toBe("new");
  });

  it("still exists nowhere as a delete: the lead survives a bulk call with action delete", async () => {
    const [a] = await leads(1);
    await bulk({ ids: [a], action: "delete" });
    expect(await getBusiness(env.DB, a)).not.toBeNull();
  });
});

describe("tag / untag", () => {
  it("normalises case, dedupes and keeps the other tags", async () => {
    const a = await lead("A", { tags: ["keep"] });
    expect((await (await bulk({ ids: [a], action: "tag", tag: "  Hot   LEAD " })).json<any>()).updated).toBe(1);
    expect((await getBusiness(env.DB, a))!.tags).toEqual(["keep", "hot lead"]);
    expect((await bulkActivity(a))[0].detail).toBe('tag "hot lead" (bulk)');
    // Same tag in a different spelling is already there: nothing to do.
    const again = await (await bulk({ ids: [a], action: "tag", tag: "HOT lead" })).json<any>();
    expect(again).toMatchObject({ updated: 0, skipped: 1, undoToken: null });
    expect((await getBusiness(env.DB, a))!.tags).toEqual(["keep", "hot lead"]);
  });

  it("untag removes it (any spelling) and skips leads without it", async () => {
    const a = await lead("A", { tags: ["x", "y"] });
    const b = await lead("B", { tags: ["z"] });
    const r = await (await bulk({ ids: [a, b], action: "untag", tag: "X" })).json<any>();
    expect(r).toMatchObject({ updated: 1, skipped: 1 });
    expect((await getBusiness(env.DB, a))!.tags).toEqual(["y"]);
    expect((await getBusiness(env.DB, b))!.tags).toEqual(["z"]);
  });

  it("caps a lead at 20 tags: a lead already at the cap is skipped and reported", async () => {
    const full = await lead("Full", { tags: Array.from({ length: 20 }, (_, i) => `t${i}`) });
    const room = await lead("Room", { tags: ["t0"] });
    const r = await (await bulk({ ids: [full, room], action: "tag", tag: "extra" })).json<any>();
    expect(r).toMatchObject({ updated: 1, skipped: 1 });
    expect((await getBusiness(env.DB, full))!.tags).toHaveLength(20);
    expect((await getBusiness(env.DB, room))!.tags).toEqual(["t0", "extra"]);
  });
});

describe("GET /api/leads?tag=", () => {
  it("filters the list by tag (normalised), together with the status filter", async () => {
    const tag = `tg${Date.now()}`;
    const a = await lead("A", { tags: [tag, "other"], status: "new" });
    const b = await lead("B", { tags: [tag], status: "won" });
    await lead("C", { tags: ["unrelated"] });
    const all = await (await api(`/api/leads?limit=500&tag=${tag.toUpperCase()}`)).json<any[]>();
    expect(all.map((r) => r.business.id).sort()).toEqual([a, b].sort());
    const won = await (await api(`/api/leads?limit=500&tag=${tag}&status=won`)).json<any[]>();
    expect(won.map((r) => r.business.id)).toEqual([b]);
  });
  it("treats the tag as data, not SQL", async () => {
    const r = await api(`/api/leads?tag=${encodeURIComponent("x' OR '1'='1")}`);
    expect(r.status).toBe(200);
    expect(await r.json<any[]>()).toEqual([]);
  });
  it("400s on a tag with nothing usable in it", async () => {
    expect((await api("/api/leads?tag=%21%21")).status).toBe(400);
  });
});

describe("undo", () => {
  it("restores archived_at and status, logs one bulk 'undo' row per lead, and is single use", async () => {
    const ids = await Promise.all([lead("A", { status: "replied" }), lead("B", { status: "new" }), lead("C", { status: "lost" })]);
    const { undoToken } = await (await bulk({ ids, action: "archive" })).json<any>();
    for (const id of ids) expect((await getBusiness(env.DB, id))!.archived_at).toBeTruthy();
    const r = await post("/api/leads/bulk/undo", { undoToken });
    expect(r.status).toBe(200);
    expect(await r.json()).toEqual({ restored: 3, skipped: 0 });
    const prior = ["replied", "new", "lost"];
    for (const [i, id] of ids.entries()) {
      const b = (await getBusiness(env.DB, id))!;
      expect(b.archived_at).toBeNull();
      expect(b.lead_status).toBe(prior[i]);
      const acts = await bulkActivity(id);
      expect(acts.map((a) => a.detail).sort()).toEqual(["archive (bulk)", "undo"]);
    }
    expect((await post("/api/leads/bulk/undo", { undoToken })).status).toBe(404);
  });

  it("restores contacted_at and tags too", async () => {
    const a = await lead("A", { status: "new", tags: ["keep"], contactedAt: null });
    const b = await lead("B", { status: "replied", tags: [], contactedAt: "2026-02-02T00:00:00.000Z" });
    const s = await (await bulk({ ids: [a, b], action: "status", status: "contacted" })).json<any>();
    expect((await getBusiness(env.DB, a))!.contacted_at).toBeTruthy();
    await post("/api/leads/bulk/undo", { undoToken: s.undoToken });
    expect(await getBusiness(env.DB, a)).toMatchObject({ lead_status: "new", contacted_at: null });
    expect(await getBusiness(env.DB, b)).toMatchObject({ lead_status: "replied", contacted_at: "2026-02-02T00:00:00.000Z" });

    const t = await (await bulk({ ids: [a], action: "tag", tag: "hot" })).json<any>();
    expect((await getBusiness(env.DB, a))!.tags).toEqual(["keep", "hot"]);
    await post("/api/leads/bulk/undo", { undoToken: t.undoToken });
    expect((await getBusiness(env.DB, a))!.tags).toEqual(["keep"]);
  });

  it("snapshots only leads that changed", async () => {
    const [a, b] = await Promise.all([lead("A", { status: "won" }), lead("B", { status: "new" })]);
    const { undoToken } = await (await bulk({ ids: [a, b], action: "status", status: "won" })).json<any>();
    expect(await (await post("/api/leads/bulk/undo", { undoToken })).json()).toEqual({ restored: 1, skipped: 0 });
    expect((await getBusiness(env.DB, a))!.lead_status).toBe("won");
    expect((await getBusiness(env.DB, b))!.lead_status).toBe("new");
  });

  it("404s for an unknown token and for one older than 10 minutes, and purges the expired one", async () => {
    expect((await post("/api/leads/bulk/undo", { undoToken: "nope" })).status).toBe(404);
    const [a] = await leads(1);
    const { undoToken } = await (await bulk({ ids: [a], action: "archive" })).json<any>();
    await env.DB.prepare(`UPDATE bulk_undo SET created_at = ? WHERE token = ?`).bind(new Date(Date.now() - 11 * 60_000).toISOString(), undoToken).run();
    expect((await post("/api/leads/bulk/undo", { undoToken })).status).toBe(404);
    expect((await getBusiness(env.DB, a))!.archived_at).toBeTruthy();
    expect(await env.DB.prepare(`SELECT 1 FROM bulk_undo WHERE token = ?`).bind(undoToken).first()).toBeNull();
  });

  it("a token just inside the window still works", async () => {
    const [a] = await leads(1);
    const { undoToken } = await (await bulk({ ids: [a], action: "archive" })).json<any>();
    await env.DB.prepare(`UPDATE bulk_undo SET created_at = ? WHERE token = ?`).bind(new Date(Date.now() - 9 * 60_000).toISOString(), undoToken).run();
    expect((await post("/api/leads/bulk/undo", { undoToken })).status).toBe(200);
  });

  it("every bulk call purges expired tokens, so the table cannot grow without bound", async () => {
    await env.DB.prepare(`INSERT INTO bulk_undo (token, snapshot, created_at) VALUES ('stale-1', '[]', ?)`).bind(new Date(Date.now() - 60 * 60_000).toISOString()).run();
    const [a] = await leads(1);
    await bulk({ ids: [a], action: "archive" });
    expect(await env.DB.prepare(`SELECT 1 FROM bulk_undo WHERE token = 'stale-1'`).first()).toBeNull();
  });

  it("skips a lead that was deleted in the meantime and counts the rest", async () => {
    const ids = await leads(2);
    const { undoToken } = await (await bulk({ ids, action: "archive" })).json<any>();
    await env.DB.prepare(`DELETE FROM businesses WHERE id = ?`).bind(ids[0]).run();
    expect(await (await post("/api/leads/bulk/undo", { undoToken })).json()).toEqual({ restored: 1, skipped: 0 });
  });

  it("400s without a token", async () => {
    expect((await post("/api/leads/bulk/undo", {})).status).toBe(400);
  });
});

describe("undo only touches what the bulk action wrote, and only if it is still as the action left it", () => {
  const undo = async (token: string) => (await post("/api/leads/bulk/undo", { undoToken: token })).json<any>();

  it("a bulk tag undone after a manual status change reverts the tag and leaves the status alone", async () => {
    const [a, b] = await Promise.all([lead("A", { status: "new" }), lead("B", { status: "new" })]);
    const { undoToken } = await (await bulk({ ids: [a, b], action: "tag", tag: "hot" })).json<any>();
    await updateLead(env.DB, a, { leadStatus: "won" });
    expect(await undo(undoToken)).toEqual({ restored: 2, skipped: 0 });
    expect(await getBusiness(env.DB, a)).toMatchObject({ lead_status: "won", tags: [] });
    expect((await getBusiness(env.DB, b))!.tags).toEqual([]);
  });

  it("a bulk archive undone after the lead was opened (new -> reviewed) restores archived_at but keeps reviewed", async () => {
    const [a] = await leads(1);
    const { undoToken } = await (await bulk({ ids: [a], action: "archive" })).json<any>();
    expect((await api(`/api/leads/${a}`)).status).toBe(200);
    expect((await getBusiness(env.DB, a))!.lead_status).toBe("reviewed");
    expect(await undo(undoToken)).toEqual({ restored: 1, skipped: 0 });
    expect(await getBusiness(env.DB, a)).toMatchObject({ archived_at: null, lead_status: "reviewed" });
  });

  it("a bulk status change undone after a manual tag edit restores the status and keeps the tags", async () => {
    const a = await lead("A", { status: "new", tags: [] });
    const { undoToken } = await (await bulk({ ids: [a], action: "status", status: "contacted" })).json<any>();
    await env.DB.prepare(`UPDATE businesses SET tags = ? WHERE id = ?`).bind(JSON.stringify(["manual"]), a).run();
    expect(await undo(undoToken)).toEqual({ restored: 1, skipped: 0 });
    expect(await getBusiness(env.DB, a)).toMatchObject({ lead_status: "new", contacted_at: null, tags: ["manual"] });
  });

  it("a lead whose status was changed again since the bulk change is skipped, not clobbered", async () => {
    const [a, b] = await Promise.all([lead("A", { status: "new" }), lead("B", { status: "new" })]);
    const { undoToken } = await (await bulk({ ids: [a, b], action: "status", status: "contacted" })).json<any>();
    await updateLead(env.DB, a, { leadStatus: "replied" });
    expect(await undo(undoToken)).toEqual({ restored: 1, skipped: 1 });
    expect((await getBusiness(env.DB, a))!.lead_status).toBe("replied");
    expect((await getBusiness(env.DB, b))!.lead_status).toBe("new");
    // Only the restored lead gets an undo row.
    expect((await bulkActivity(a)).map((x) => x.detail)).toEqual(["status → contacted (bulk)"]);
    expect((await bulkActivity(b)).map((x) => x.detail).sort()).toEqual(["status → contacted (bulk)", "undo"]);
  });

  it("a bulk archive is skipped when the lead was restored by hand in the meantime", async () => {
    const [a] = await leads(1);
    const { undoToken } = await (await bulk({ ids: [a], action: "archive" })).json<any>();
    await env.DB.prepare(`UPDATE businesses SET archived_at = NULL WHERE id = ?`).bind(a).run();
    expect(await undo(undoToken)).toEqual({ restored: 0, skipped: 1 });
  });

  it("a tag edit made since leaves that lead's tags alone and counts it as skipped", async () => {
    const a = await lead("A", { tags: [] });
    const { undoToken } = await (await bulk({ ids: [a], action: "tag", tag: "hot" })).json<any>();
    await env.DB.prepare(`UPDATE businesses SET tags = ? WHERE id = ?`).bind(JSON.stringify(["hot", "later"]), a).run();
    expect(await undo(undoToken)).toEqual({ restored: 0, skipped: 1 });
    expect((await getBusiness(env.DB, a))!.tags).toEqual(["hot", "later"]);
  });
});

describe("saved filters", () => {
  it("creates, lists (newest first) and deletes", async () => {
    const a = await post("/api/leads/filters", { name: "  Hot wix  ", query: "status=new&platform=wix" });
    expect(a.status).toBe(201);
    const made = await a.json<any>();
    expect(made).toMatchObject({ name: "Hot wix", query: "status=new&platform=wix" });
    expect(made.id).toBeTruthy();
    const list = await (await api("/api/leads/filters")).json<any[]>();
    expect(list.map((f) => f.id)).toContain(made.id);
    expect((await api(`/api/leads/filters/${made.id}`, { method: "DELETE" })).status).toBe(200);
    expect((await (await api("/api/leads/filters")).json<any[]>()).map((f) => f.id)).not.toContain(made.id);
    expect((await api(`/api/leads/filters/${made.id}`, { method: "DELETE" })).status).toBe(404);
  });

  it("is not shadowed by /:id: GET /api/leads/filters is a list, not a lead lookup", async () => {
    const r = await api("/api/leads/filters");
    expect(r.status).toBe(200);
    expect(Array.isArray(await r.json())).toBe(true);
    // ... and a real lead id still resolves.
    const [a] = await leads(1);
    expect((await api(`/api/leads/${a}`)).status).toBe(200);
  });

  it("409s on a duplicate name regardless of case", async () => {
    expect((await post("/api/leads/filters", { name: "Dupe Check", query: "a=1" })).status).toBe(201);
    expect((await post("/api/leads/filters", { name: "dupe check", query: "a=2" })).status).toBe(409);
  });

  it("validates name (1-60) and query (<= 2000)", async () => {
    expect((await post("/api/leads/filters", { name: "  ", query: "a=1" })).status).toBe(400);
    expect((await post("/api/leads/filters", { name: "x".repeat(61), query: "a=1" })).status).toBe(400);
    expect((await post("/api/leads/filters", { name: "ok-long-q", query: "q".repeat(2001) })).status).toBe(400);
    expect((await post("/api/leads/filters", { name: "ok-2000", query: "q".repeat(2000) })).status).toBe(201);
    expect((await post("/api/leads/filters", { name: "no query" })).status).toBe(400);
    expect((await post("/api/leads/filters", { name: 5, query: "" })).status).toBe(400);
  });

  it("allows at most 50 saved filters", async () => {
    await env.DB.prepare(`DELETE FROM saved_filters`).run();
    for (let i = 0; i < 50; i++) expect((await post("/api/leads/filters", { name: `f${i}`, query: "" })).status).toBe(201);
    expect((await post("/api/leads/filters", { name: "one too many", query: "" })).status).toBe(400);
    await env.DB.prepare(`DELETE FROM saved_filters`).run();
  });
});
