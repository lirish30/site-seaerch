import { createExecutionContext, env } from "cloudflare:test";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import worker from "../src/worker/index";
import { archiveSite, createSite } from "../src/worker/db/sites";
import { addKeyword, getProfile, listCitations, listKeywords } from "../src/worker/db/seo";
import type { Env } from "../src/worker/env";
import { CITATION_DIRECTORIES } from "../src/worker/seo/nap";
import { runNapCheck, setupProfile } from "../src/worker/seo/profile";
import { seedClient } from "./fixtures/clients";
import { E } from "./fixtures/close";

const KEY = "AIza-SECRET-KEY-123";
const e = { ...E, GOOGLE_PLACES_API_KEY: KEY } as Env;
const NOW = new Date("2026-12-02T18:00:00.000Z");
const ctx = () => createExecutionContext();
const html = (body: string) => new Response(`<html><head><title>Ace</title></head><body>${body}</body></html>`, { headers: { "content-type": "text/html" } });
const jsonRes = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

const DETAILS = {
  id: "ChIJace", displayName: { text: "Ace Plumbing" }, formattedAddress: "12345 SW Main St, Tigard, OR 97224, USA", nationalPhoneNumber: "(503) 555-0147",
  websiteUri: "https://ace.com/", googleMapsUri: "https://maps.google.com/?cid=42", rating: 4.6, userRatingCount: 80, location: { latitude: 45.43, longitude: -122.77 },
  primaryTypeDisplayName: { text: "Plumber" }, photos: [{}], regularOpeningHours: {}, reviews: [],
};
const cand = (id: string, name: string) => ({ id, displayName: { text: name }, formattedAddress: `${id} Main St`, googleMapsUri: `https://maps.google.com/?cid=${id}`, rating: 4.5, userRatingCount: 10 });

let urls: string[] = [];
type Handler = (url: string, init?: RequestInit) => Response | Promise<Response>;
function stub(h: Handler) {
  urls = [];
  vi.stubGlobal("fetch", vi.fn(async (u: string | URL | Request, init?: RequestInit) => { urls.push(String(u)); return h(String(u), init); }));
}
const places = () => urls.filter((u) => u.startsWith("https://places.googleapis.com/"));
/** Google answers details with `details` (null: unknown place), search with `found`. */
const google = (details: unknown | null = DETAILS, found: unknown[] = []): Handler => (u) => {
  if (u.endsWith("places:searchText")) return jsonRes({ places: found });
  if (u.startsWith("https://places.googleapis.com/v1/places/")) return details === null ? jsonRes({ error: { message: "not found" } }, 404) : jsonRes(details);
  return new Response("", { status: 404 });
};

let cookie = "";
async function signIn() {
  const login = await worker.fetch(new Request("https://x/api/login", { method: "POST", body: JSON.stringify({ password: "test-pass" }), headers: { "content-type": "application/json" } }), E, ctx());
  expect(login.status).toBe(200);
  cookie = login.headers.get("set-cookie")!.split(";")[0];
}
async function call(method: string, path: string, body?: unknown, o: { session?: boolean; env?: Env } = {}) {
  const session = o.session ?? true;
  if (session && !cookie) await signIn();
  return worker.fetch(new Request(`https://x/api${path}`, {
    method, body: body === undefined ? undefined : JSON.stringify(body), headers: { ...(session ? { cookie } : {}), "content-type": "application/json" },
  }), o.env ?? e, ctx());
}
const jcall = async (method: string, path: string, body?: unknown, status = 200) => {
  const r = await call(method, path, body);
  const text = await r.text();
  expect(r.status, `${method} ${path} ${text}`).toBe(status);
  return JSON.parse(text) as any;
};

beforeEach(async () => {
  vi.spyOn(console, "error").mockImplementation(() => {});
  for (const t of ["seo_citations", "seo_keywords", "seo_profiles"]) await env.DB.prepare(`DELETE FROM ${t}`).run();
});
afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); });

const SETUP = { placeId: "ChIJace", trade: "plumber", towns: ["Tigard", "Tualatin"], gridKm: 3 };

describe("setupProfile", () => {
  it("takes lat, lng, maps url and name, address and phone from Google, makes a setup profile and seeds the citation list", async () => {
    const s = await seedClient();
    stub(google());
    const p = await setupProfile(e, s.businessId, SETUP, NOW.toISOString());
    expect(p).toMatchObject({
      businessId: s.businessId, placeId: "ChIJace", mapsUrl: "https://maps.google.com/?cid=42", napName: "Ace Plumbing", napAddress: "12345 SW Main St, Tigard, OR 97224, USA", napPhone: "(503) 555-0147",
      lat: 45.43, lng: -122.77, trade: "plumber", towns: ["Tigard", "Tualatin"], gridKm: 3, status: "setup", createdAt: NOW.toISOString(),
    });
    expect(await getProfile(env.DB, s.businessId)).toEqual(p);
    expect((await listCitations(env.DB, s.businessId)).map((c) => [c.directory, c.status])).toEqual(CITATION_DIRECTORIES.map((d) => [d, "todo"]));
  });

  it("refuses a place Google no longer knows, with a plain sentence, and writes nothing", async () => {
    const s = await seedClient();
    stub(google(null));
    const err = await setupProfile(e, s.businessId, SETUP, NOW.toISOString()).catch((x: Error) => x);
    expect(err).toBeInstanceOf(Error);
    expect((err as Error).message).toMatch(/no longer|can't find|cannot find/i);
    expect((err as Error).message).not.toContain("ChIJace");
    expect(await getProfile(env.DB, s.businessId)).toBeNull();
    expect(await listCitations(env.DB, s.businessId)).toEqual([]);
  });

  it("refuses more than 8 towns, a town outside 2 to 60 characters, and a grid outside 1 to 10 km, before asking Google", async () => {
    const s = await seedClient();
    stub(google());
    const nine = Array.from({ length: 9 }, (_, i) => `Town ${i}`);
    for (const bad of [{ towns: nine }, { towns: ["X"] }, { towns: ["x".repeat(61)] }, { towns: ["  "] }, { gridKm: 0 }, { gridKm: 11 }, { gridKm: Number.NaN }]) {
      await expect(setupProfile(e, s.businessId, { ...SETUP, ...bad }, NOW.toISOString()), JSON.stringify(bad).slice(0, 40)).rejects.toThrow();
    }
    expect(places()).toEqual([]);
    expect(await getProfile(env.DB, s.businessId)).toBeNull();
    // The limits themselves are allowed.
    const ok = await setupProfile(e, s.businessId, { ...SETUP, towns: nine.slice(0, 8), gridKm: 10 }, NOW.toISOString());
    expect(ok.towns).toHaveLength(8);
    expect((await setupProfile(e, s.businessId, { ...SETUP, gridKm: 1 }, NOW.toISOString())).gridKm).toBe(1);
  });

  it("keeps the watch status when a profile that is already running is set up again, and forgets a NAP result for another place", async () => {
    const s = await seedClient();
    stub(google());
    await setupProfile(e, s.businessId, SETUP, NOW.toISOString());
    await env.DB.prepare(`UPDATE seo_profiles SET status = 'active', nap_result = '{"x":1}' WHERE business_id = ?`).bind(s.businessId).run();
    const same = await setupProfile(e, s.businessId, { ...SETUP, towns: ["Tigard"] }, NOW.toISOString());
    expect(same).toMatchObject({ status: "active", napResult: '{"x":1}', towns: ["Tigard"] });
    stub(google({ ...DETAILS, id: "ChIJother" }));
    const other = await setupProfile(e, s.businessId, { ...SETUP, placeId: "ChIJother" }, NOW.toISOString());
    expect(other).toMatchObject({ status: "active", placeId: "ChIJother", napResult: null });
  });

  it("only takes a site that belongs to the client and is not archived", async () => {
    const s = await seedClient();
    const mine = (await createSite(env.DB, { businessId: s.businessId, url: "https://ace-two.com" })).site;
    const other = await seedClient();
    stub(google());
    expect((await setupProfile(e, s.businessId, { ...SETUP, siteId: mine.id }, NOW.toISOString())).siteId).toBe(mine.id);
    await expect(setupProfile(e, s.businessId, { ...SETUP, siteId: other.site!.id }, NOW.toISOString())).rejects.toThrow(/site/i);
    await archiveSite(env.DB, mine.id, NOW.toISOString());
    await expect(setupProfile(e, s.businessId, { ...SETUP, siteId: mine.id }, NOW.toISOString())).rejects.toThrow(/site/i);
  });
});

describe("PUT /clients/:id/seo/profile", () => {
  it("ignores a lat and lng in the body: the place decides", async () => {
    const s = await seedClient();
    stub(google());
    const r = await jcall("PUT", `/clients/${s.businessId}/seo/profile`, { ...SETUP, lat: 1, lng: 2, napName: "Evil Co", napPhone: "000" });
    expect(r.profile).toMatchObject({ lat: 45.43, lng: -122.77, napName: "Ace Plumbing", napPhone: "(503) 555-0147", status: "setup", napResult: null });
    expect(r.citations).toHaveLength(CITATION_DIRECTORIES.length);
    expect(await getProfile(env.DB, s.businessId)).toMatchObject({ lat: 45.43, lng: -122.77, napName: "Ace Plumbing" });
  });

  it("answers an unknown place with a plain sentence and 409, and writes no profile", async () => {
    const s = await seedClient();
    stub(google(null));
    const r = await jcall("PUT", `/clients/${s.businessId}/seo/profile`, SETUP, 409);
    expect(r.error).toMatch(/no longer|can't find/i);
    expect(await getProfile(env.DB, s.businessId)).toBeNull();
  });

  it("answers 400 for 9 towns and for a grid of 0 or 11, and 400 for a body that is not the right shape", async () => {
    const s = await seedClient();
    stub(google());
    const nine = Array.from({ length: 9 }, (_, i) => `Town ${i}`);
    expect((await jcall("PUT", `/clients/${s.businessId}/seo/profile`, { ...SETUP, towns: nine }, 400)).error).toMatch(/8 towns/);
    expect((await jcall("PUT", `/clients/${s.businessId}/seo/profile`, { ...SETUP, gridKm: 0 }, 400)).error).toMatch(/1 and 10/);
    expect((await jcall("PUT", `/clients/${s.businessId}/seo/profile`, { ...SETUP, gridKm: 11 }, 400)).error).toMatch(/1 and 10/);
    await jcall("PUT", `/clients/${s.businessId}/seo/profile`, { trade: "plumber" }, 400);
    await jcall("PUT", `/clients/${s.businessId}/seo/profile`, { ...SETUP, towns: "Tigard" }, 400);
    expect(places()).toEqual([]);
  });

  it("never echoes the Places key, whatever Google says, and says when Places is not set up", async () => {
    const s = await seedClient();
    stub(() => jsonRes({ error: { message: `bad key ${KEY}` } }, 403));
    const r = await call("PUT", `/clients/${s.businessId}/seo/profile`, SETUP);
    const text = await r.text();
    expect(r.status).toBe(502);
    expect(text).not.toContain(KEY);
    stub(google());
    const none = await call("PUT", `/clients/${s.businessId}/seo/profile`, SETUP, { env: { ...e, GOOGLE_PLACES_API_KEY: undefined } as Env });
    expect(none.status).toBe(503);
    expect(((await none.json()) as { error: string }).error).toMatch(/not set up/i);
    expect(places()).toEqual([]);
  });

  it("refuses a place that has no location, with a plain sentence", async () => {
    const s = await seedClient();
    stub(google({ ...DETAILS, location: undefined }));
    const r = await jcall("PUT", `/clients/${s.businessId}/seo/profile`, SETUP, 502);
    expect(r.error).toMatch(/location|different place/i);
    expect(await getProfile(env.DB, s.businessId)).toBeNull();
  });

  it("asks to try again when Google could not be reached", async () => {
    const s = await seedClient();
    stub(() => jsonRes({ error: { message: "busy" } }, 503));
    const r = await jcall("PUT", `/clients/${s.businessId}/seo/profile`, SETUP, 502);
    expect(r.error).toMatch(/try again/i);
  });
});

describe("POST /clients/:id/seo/place-search", () => {
  it("returns at most 5 candidates and never picks one, even when two share a name", async () => {
    const s = await seedClient();
    stub(google(DETAILS, [cand("a", "Ace Plumbing"), cand("b", "Ace Plumbing"), cand("c", "Ace Plumbing Supply"), cand("d", "d"), cand("e", "e"), cand("f", "f"), cand("g", "g")]));
    const r = await jcall("POST", `/clients/${s.businessId}/seo/place-search`, { name: "Ace Plumbing", address: "Tigard, OR" });
    expect(r.candidates).toHaveLength(5);
    expect(r.candidates.slice(0, 2).map((c: { id: string; name: string }) => [c.id, c.name])).toEqual([["a", "Ace Plumbing"], ["b", "Ace Plumbing"]]);
    expect(Object.keys(r).sort()).toEqual(["candidates"]);
    expect(JSON.stringify(r)).not.toMatch(/selected|chosen|best/i);
    expect(await getProfile(env.DB, s.businessId)).toBeNull();
  });

  it("answers 400 for a missing name and for an over-long one, and sends no request", async () => {
    const s = await seedClient();
    stub(google());
    await jcall("POST", `/clients/${s.businessId}/seo/place-search`, { address: "x" }, 400);
    await jcall("POST", `/clients/${s.businessId}/seo/place-search`, { name: "  ", address: "x" }, 400);
    await jcall("POST", `/clients/${s.businessId}/seo/place-search`, { name: "x".repeat(201), address: "x" }, 400);
    expect(places()).toEqual([]);
  });

  it("answers 404 for something that is not a client", async () => {
    stub(google());
    await jcall("POST", `/clients/not-a-client/seo/place-search`, { name: "Ace", address: "x" }, 404);
    expect(places()).toEqual([]);
  });
});

describe("keywords", () => {
  const path = (id: string) => `/clients/${id}/seo/keywords`;

  it("adds a keyword with or without a town, once", async () => {
    const s = await seedClient();
    const a = await jcall("POST", path(s.businessId), { term: "  emergency   plumber ", town: "Tigard" }, 201);
    expect(a).toMatchObject({ created: true, keyword: { term: "emergency plumber", town: "Tigard", active: true } });
    const b = await jcall("POST", path(s.businessId), { term: "Emergency Plumber", town: "tigard" }, 200);
    expect(b).toMatchObject({ created: false, keyword: { id: a.keyword.id } });
    const c = await jcall("POST", path(s.businessId), { term: "plumber" }, 201);
    expect(c.keyword).toMatchObject({ term: "plumber", town: "" });
    expect(await listKeywords(env.DB, s.businessId)).toHaveLength(2);
  });

  it("refuses the 11th active keyword, and a deactivated one frees a place", async () => {
    const s = await seedClient();
    const ids: string[] = [];
    for (let i = 0; i < 10; i++) ids.push((await jcall("POST", path(s.businessId), { term: `term ${i}` }, 201)).keyword.id);
    const r = await jcall("POST", path(s.businessId), { term: "one too many" }, 409);
    expect(r.error).toMatch(/10/);
    expect(await listKeywords(env.DB, s.businessId)).toHaveLength(10);
    const off = await jcall("DELETE", `${path(s.businessId)}/${ids[0]}`);
    expect(off.keyword).toMatchObject({ id: ids[0], active: false });
    await jcall("POST", path(s.businessId), { term: "one too many" }, 201);
    // Putting the switched-off one back needs a place too.
    await jcall("POST", path(s.businessId), { term: "term 0" }, 409);
    expect((await listKeywords(env.DB, s.businessId, { activeOnly: true }))).toHaveLength(10);
  });

  it("puts a switched-off keyword back when it is added again and there is room", async () => {
    const s = await seedClient();
    const a = await jcall("POST", path(s.businessId), { term: "drain cleaning" }, 201);
    await jcall("DELETE", `${path(s.businessId)}/${a.keyword.id}`);
    const again = await jcall("POST", path(s.businessId), { term: "drain cleaning" }, 200);
    expect(again).toMatchObject({ created: false, keyword: { id: a.keyword.id, active: true } });
  });

  it("refuses a term or town that looks like a credential", async () => {
    const s = await seedClient();
    expect((await jcall("POST", path(s.businessId), { term: "password: hunter2" }, 400)).error).toMatch(/password|login|key/i);
    await jcall("POST", path(s.businessId), { term: "plumber", town: "api key = abc" }, 400);
    expect(await listKeywords(env.DB, s.businessId)).toEqual([]);
  });

  it("refuses a term outside 2 to 60 characters and a town outside it", async () => {
    const s = await seedClient();
    await jcall("POST", path(s.businessId), { term: "x" }, 400);
    await jcall("POST", path(s.businessId), { term: "x".repeat(61) }, 400);
    await jcall("POST", path(s.businessId), { term: "ok term", town: "x" }, 400);
    await jcall("POST", path(s.businessId), { term: "ok term", town: "x".repeat(61) }, 400);
    await jcall("POST", path(s.businessId), {}, 400);
    expect(await listKeywords(env.DB, s.businessId)).toEqual([]);
    await jcall("POST", path(s.businessId), { term: "xy", town: "" }, 201);
    await jcall("POST", path(s.businessId), { term: "x".repeat(60) }, 201);
  });

  it("only switches off the client's own keywords, and switching off twice is fine", async () => {
    const a = await seedClient();
    const b = await seedClient();
    const k = (await addKeyword(env.DB, b.businessId, { term: "other", town: "" }, NOW.toISOString())).keyword;
    await jcall("DELETE", `${path(a.businessId)}/${k.id}`, undefined, 404);
    expect((await listKeywords(env.DB, b.businessId))[0].active).toBe(true);
    await jcall("DELETE", `${path(b.businessId)}/${k.id}`);
    await jcall("DELETE", `${path(b.businessId)}/${k.id}`);
    expect((await listKeywords(env.DB, b.businessId))[0].active).toBe(false);
  });
});

describe("PUT /clients/:id/seo/citations/:directory", () => {
  it("sets a directory's status, link and note, and leaves what it is not given", async () => {
    const s = await seedClient();
    stub(google());
    await setupProfile(e, s.businessId, SETUP, NOW.toISOString());
    const r = await jcall("PUT", `/clients/${s.businessId}/seo/citations/Yellow%20Pages`, { status: "listed", url: "https://yellowpages.test/ace", note: "claimed" });
    expect(r.citation).toMatchObject({ directory: "Yellow Pages", status: "listed", url: "https://yellowpages.test/ace", note: "claimed" });
    expect(r.citation.checkedOn).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    const r2 = await jcall("PUT", `/clients/${s.businessId}/seo/citations/Yellow%20Pages`, { status: "needs_fix" });
    expect(r2.citation).toMatchObject({ status: "needs_fix", url: "https://yellowpages.test/ace", note: "claimed" });
    expect(r2.citations).toHaveLength(CITATION_DIRECTORIES.length);
  });

  it("refuses a directory that is not on the list, a status that is not one, a link that is not http(s), and a credential in the note", async () => {
    const s = await seedClient();
    stub(google());
    await setupProfile(e, s.businessId, SETUP, NOW.toISOString());
    await jcall("PUT", `/clients/${s.businessId}/seo/citations/Craigslist`, { status: "listed" }, 404);
    await jcall("PUT", `/clients/${s.businessId}/seo/citations/Yelp`, { status: "done" }, 400);
    await jcall("PUT", `/clients/${s.businessId}/seo/citations/Yelp`, { status: "listed", url: "javascript:alert(1)" }, 400);
    await jcall("PUT", `/clients/${s.businessId}/seo/citations/Yelp`, { status: "listed", note: "password: hunter2" }, 400);
    expect((await listCitations(env.DB, s.businessId)).find((c) => c.directory === "Yelp")).toMatchObject({ status: "todo", url: null });
  });

  it("answers 404 before the profile has made the list", async () => {
    const s = await seedClient();
    await jcall("PUT", `/clients/${s.businessId}/seo/citations/Yelp`, { status: "listed" }, 404);
  });
});

describe("NAP check", () => {
  const profile = async (s: { businessId: string }, details: unknown = DETAILS) => { stub(google(details)); return setupProfile(e, s.businessId, SETUP, NOW.toISOString()); };
  /** The client's site: a home page that links to a contact page, and whatever else is asked for is a 404. */
  const site = (home: string, contact: string): Handler => (u) => {
    if (u === "https://ace.com/") return html(`<nav><a href="/contact">Contact us</a><a href="/about">About</a></nav>${home}`);
    if (u === "https://ace.com/contact") return html(contact);
    if (u === "https://ace.com/about") return html("<p>(360) 555-9999 ABOUT PAGE</p>");
    return new Response("", { status: 404 });
  };

  it("crawls the home page and the contact page, stores the result on the profile and returns it", async () => {
    const s = await seedClient();
    await profile(s);
    stub(site("<footer>Ace Plumbing</footer>", "<p>12345 Southwest Main Street, Tigard. Call (503) 555-0147</p>"));
    const r = await jcall("POST", `/clients/${s.businessId}/seo/nap-check`, {});
    expect(r.nap).toEqual({ phone: "match", address: "match", name: "match", checkedPages: 2 });
    expect(JSON.parse((await getProfile(env.DB, s.businessId))!.napResult!)).toEqual(r.nap);
    expect(urls.filter((u) => u === "https://ace.com/about")).toEqual([]);
  });

  it("reports a wrong phone, and a name and address that are not there", async () => {
    const s = await seedClient();
    await profile(s);
    stub(site("<footer>Call (360) 555-0100</footer>", "<p>Hello</p>"));
    const r = await jcall("POST", `/clients/${s.businessId}/seo/nap-check`, {});
    expect(r.nap).toEqual({ phone: "mismatch", address: "missing", name: "missing", checkedPages: 2 });
  });

  it("checks the home page alone when the site has no contact page", async () => {
    const s = await seedClient();
    await profile(s);
    stub((u) => (u === "https://ace.com/" ? html("<p>Ace Plumbing (503) 555-0147</p>") : new Response("", { status: 404 })));
    const r = await jcall("POST", `/clients/${s.businessId}/seo/nap-check`, {});
    expect(r.nap).toEqual({ phone: "match", address: "missing", name: "match", checkedPages: 1 });
  });

  it("runNapCheck uses the profile's site when it has one, else the client's live site", async () => {
    const s = await seedClient();
    const two = (await createSite(env.DB, { businessId: s.businessId, url: "https://ace-two.com" })).site;
    stub(google());
    await setupProfile(e, s.businessId, { ...SETUP, siteId: two.id }, NOW.toISOString());
    stub((u) => (u === "https://ace-two.com/" ? html("<p>Ace Plumbing</p>") : new Response("", { status: 404 })));
    expect(await runNapCheck(e, s.businessId)).toMatchObject({ name: "match", checkedPages: 1 });
    expect(urls.some((u) => u.startsWith("https://ace.com"))).toBe(false);
  });

  it("refuses without a profile, without a site address, and when the site cannot be read, and stores nothing", async () => {
    const s = await seedClient();
    stub(site("a", "b"));
    expect((await jcall("POST", `/clients/${s.businessId}/seo/nap-check`, {}, 409)).error).toMatch(/profile/i);
    await profile(s);
    stub(() => new Response("", { status: 500 }));
    const down = await jcall("POST", `/clients/${s.businessId}/seo/nap-check`, {}, 409);
    expect(down.error).toMatch(/couldn't|could not/i);
    expect((await getProfile(env.DB, s.businessId))!.napResult).toBeNull();
    await env.DB.prepare(`UPDATE sites SET url = NULL, domain = NULL WHERE business_id = ?`).bind(s.businessId).run();
    expect((await jcall("POST", `/clients/${s.businessId}/seo/nap-check`, {}, 409)).error).toMatch(/website|site/i);
  });

  it("never fetches a private or internal address", async () => {
    const s = await seedClient();
    await profile(s);
    await env.DB.prepare(`UPDATE sites SET url = 'http://169.254.169.254/latest', domain = NULL WHERE business_id = ?`).bind(s.businessId).run();
    stub(() => html("<p>secret</p>"));
    const r = await jcall("POST", `/clients/${s.businessId}/seo/nap-check`, {}, 409);
    expect(r.error).toMatch(/can't be checked|public/i);
    expect(urls).toEqual([]);
  });
});

describe("access", () => {
  it("needs a session on every route", async () => {
    const s = await seedClient();
    const k = (await addKeyword(env.DB, s.businessId, { term: "x y", town: "" }, NOW.toISOString())).keyword;
    stub(google());
    const id = s.businessId;
    const routes: [string, string, unknown][] = [
      ["POST", `/clients/${id}/seo/place-search`, { name: "Ace", address: "x" }],
      ["PUT", `/clients/${id}/seo/profile`, SETUP],
      ["POST", `/clients/${id}/seo/keywords`, { term: "plumber" }],
      ["DELETE", `/clients/${id}/seo/keywords/${k.id}`, undefined],
      ["PUT", `/clients/${id}/seo/citations/Yelp`, { status: "listed" }],
      ["POST", `/clients/${id}/seo/nap-check`, {}],
    ];
    for (const [m, p, b] of routes) expect((await call(m, p, b, { session: false })).status, `${m} ${p}`).toBe(401);
    expect(places()).toEqual([]);
    expect((await listKeywords(env.DB, id))[0].active).toBe(true);
  });

  it("allows a test client", async () => {
    const s = await seedClient({ test: true });
    stub(google(DETAILS, [cand("a", "Ace")]));
    expect((await jcall("POST", `/clients/${s.businessId}/seo/place-search`, { name: "Ace", address: "x" })).candidates).toHaveLength(1);
    expect((await jcall("PUT", `/clients/${s.businessId}/seo/profile`, SETUP)).profile.status).toBe("setup");
    await jcall("POST", `/clients/${s.businessId}/seo/keywords`, { term: "plumber" }, 201);
  });

  it("answers 404 for a business that is not a client, on every route", async () => {
    const lead = await seedClient({ won: false, project: false });
    stub(google());
    const id = lead.businessId;
    for (const [m, p, b] of [
      ["PUT", `/clients/${id}/seo/profile`, SETUP], ["POST", `/clients/${id}/seo/keywords`, { term: "plumber" }], ["DELETE", `/clients/${id}/seo/keywords/x`, undefined],
      ["PUT", `/clients/${id}/seo/citations/Yelp`, { status: "listed" }], ["POST", `/clients/${id}/seo/nap-check`, {}],
    ] as [string, string, unknown][]) expect((await call(m, p, b)).status, `${m} ${p}`).toBe(404);
    expect(places()).toEqual([]);
  });
});
