import { createExecutionContext, env } from "cloudflare:test";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import worker from "../src/worker/index";
import { placeHold } from "../src/worker/db/holds";
import { addCadence } from "../src/worker/db/projects";
import { ensureSeedSops } from "../src/worker/db/sops";
import { listActivity } from "../src/worker/db/activity";
import { addKeyword, getProfile, listContent, rankChecksFor, setContent, snapshotsFor, upsertProfile, upsertRankCheck, type ProfileStatus } from "../src/worker/db/seo";
import { setSpendCap } from "../src/worker/db/spendCaps";
import { getSeoReportFor, listSeoReports } from "../src/worker/db/seoReports";
import { listTasks } from "../src/worker/db/tasks";
import type { Env } from "../src/worker/env";
import { generateRecurring } from "../src/worker/projects/sweep";
import { expireOldTasks } from "../src/worker/queue/db";
import "../src/worker/queue/kinds";
import { previousMonth } from "../src/worker/care/reportSweep";
import { DAILY_CRON, runScheduled } from "../src/worker/schedule";
import * as contentMod from "../src/worker/seo/content";
import { plainSeoSummary, type SeoReportFacts } from "../src/worker/seo/reportFacts";
import { runBaseline } from "../src/worker/seo/baseline";
import { setupProfile } from "../src/worker/seo/profile";
import { MAX_CLIENTS_PER_RUN, MAX_PLACES_CALLS_PER_RUN, MAX_PLACES_WALL_MS, MAX_PULL_DAYS_PER_MONTH, SeoReportRefused, seoClock, WATCH_EVERY_DAYS, startSeoReport, sweepSeo } from "../src/worker/seo/sweep";
import { zoneOf } from "../src/worker/sop/cadence";
import { getSettings } from "../src/worker/db/settings";
import { localDay } from "../src/worker/monitoring/rollup";
import { seedClient } from "./fixtures/clients";
import { E } from "./fixtures/close";
import { resetProjectWork } from "./fixtures/projects";

const KEY = "AIza-SECRET-KEY-123";
const e = { ...E, GOOGLE_PLACES_API_KEY: KEY } as Env;
const LA = "America/Los_Angeles";
// Tuesday 1 December 2026, 09:00 in Los Angeles: the first daily run of December (the report is of November, the month's slots are December's).
const NOW = new Date("2026-12-01T17:00:00.000Z");
const DAY = 86_400_000;
const at = (d: Date, days: number) => new Date(d.getTime() + days * DAY);
const jsonRes = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

const place = (id: string) => ({
  id, displayName: { text: "Ace Plumbing" }, formattedAddress: "12345 SW Main St, Tigard, OR 97224, USA", nationalPhoneNumber: "(503) 555-0147",
  websiteUri: "https://ace.com/", googleMapsUri: "https://maps.google.com/?cid=42", rating: 4.6, userRatingCount: 80, location: { latitude: 45.43, longitude: -122.77 },
  primaryTypeDisplayName: { text: "Plumber" }, photos: [{}, {}, {}], regularOpeningHours: {}, reviews: [],
});

let urls: string[] = [];
let details: (placeId: string) => Response = (id) => jsonRes(place(id));
let search: (term: string) => Response = () => jsonRes({ places: [{ id: "other" }, { id: "ChIJace" }] }); // the listing shows second
function stub() {
  urls = [];
  details = (id) => jsonRes(place(id));
  search = () => jsonRes({ places: [{ id: "other" }, { id: "ChIJace" }] });
  vi.stubGlobal("fetch", vi.fn(async (u: string | URL | Request, init?: RequestInit) => {
    const url = String(u);
    urls.push(url);
    if (url.endsWith("places:searchText") && typeof init?.body === "string") return search((JSON.parse(init.body) as { textQuery: string }).textQuery);
    if (url.startsWith("https://places.googleapis.com/v1/places/")) return details(decodeURIComponent(url.slice("https://places.googleapis.com/v1/places/".length)));
    return new Response("", { status: 404 });
  }));
}
const placesCalls = () => urls.filter((u) => u.startsWith("https://places.googleapis.com/")).length;
const detailsCalls = () => urls.filter((u) => u.startsWith("https://places.googleapis.com/v1/places/")).length;
const searchCalls = () => urls.filter((u) => u.endsWith("places:searchText")).length;

let errors: ReturnType<typeof vi.spyOn>;
let logs: ReturnType<typeof vi.spyOn>;
let t0 = Date.parse("2026-10-01T00:00:00.000Z");
beforeEach(async () => {
  errors = vi.spyOn(console, "error").mockImplementation(() => {});
  logs = vi.spyOn(console, "log").mockImplementation(() => {});
  stub();
  await resetProjectWork();
  for (const t of ["seo_reports", "seo_content", "seo_rank_checks", "seo_gbp_snapshots", "seo_reviews", "seo_citations", "seo_keywords", "seo_profiles", "usage", "spend_caps", "billing_holds", "invoice_nudges", "invoices", "subscriptions",
    "document_views", "document_signatures", "documents", "deals", "activity", "drafts", "audits", "search_results", "businesses", "suppressions"]) await env.DB.prepare(`DELETE FROM ${t}`).run();
  await env.DB.batch([env.DB.prepare(`DELETE FROM sop_template_steps`), env.DB.prepare(`DELETE FROM sop_templates`)]);
  await ensureSeedSops(env.DB);
});
afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); });

interface Spec { plan?: "local_seo" | "local_seo_growth"; keywords?: number; status?: ProfileStatus; test?: boolean; cadence?: boolean; lastWatchOn?: string | null; placeId?: string; term?: string }
/** A real client with a live Local SEO plan, the SEO-1 cadence on its project (unless said) and an `active` profile with a Google place and `keywords` search terms (2 by default). Each is made a second later than the one before. */
async function seoClient(o: Spec = {}) {
  const s = await seedClient({ subs: [{ key: o.plan ?? "local_seo", monthlyCents: 60_000 }], test: o.test });
  if (o.cadence !== false) await addCadence(env.DB, s.project!.id, "SEO-1");
  t0 += 1000;
  await upsertProfile(env.DB, s.businessId, {
    placeId: o.placeId ?? "ChIJace", lat: 45.43, lng: -122.77, gridKm: 3, trade: "plumber", towns: ["Tigard"], status: o.status ?? "active", lastWatchOn: o.lastWatchOn ?? null,
  }, new Date(t0).toISOString());
  for (let i = 0; i < (o.keywords ?? 2); i++) await addKeyword(env.DB, s.businessId, { term: `${o.term ?? "drain cleaning"} ${i + 1}`, town: "Tigard" }, new Date(t0).toISOString());
  return s;
}
type Client = Awaited<ReturnType<typeof seoClient>>;

const points = (okCount: number) => Array.from({ length: 9 }, (_, i) => ({ lat: 45 + i / 100, lng: -122, pos: i < okCount ? 2 : null, ok: i < okCount }));
/** A stored rank check for every active keyword of the client on a local day. */
async function check(s: Client, takenOn: string, okCount = 9) {
  const kws = (await env.DB.prepare(`SELECT id FROM seo_keywords WHERE business_id = ? ORDER BY created_at, rowid`).bind(s.businessId).all<{ id: string }>()).results;
  for (const k of kws) await upsertRankCheck(env.DB, { businessId: s.businessId, keywordId: k.id, takenOn, points: points(okCount), now: `${takenOn}T12:00:00.000Z` });
}
const reports = () => listSeoReports(env.DB, {});
const jobs = (kind: string) => env.DB.prepare(`SELECT kind, target_id, status FROM claude_tasks WHERE kind = ? ORDER BY created_at, id`).bind(kind).all<{ kind: string; target_id: string; status: string }>().then((r) => r.results);
const seo1 = async (s: Client, period: string) => (await listTasks(env.DB, s.project!.id)).find((t) => t.cadenceKey === "SEO-1" && t.periodKey === period)!;
/** Everything the sweep writes, as numbers and ticks, so a second run can be shown to change nothing. */
async function state() {
  const count = async (t: string) => (await env.DB.prepare(`SELECT COUNT(*) AS n FROM ${t}`).first<{ n: number }>())!.n;
  const ticks = (await env.DB.prepare(`SELECT checklist FROM tasks WHERE cadence_key = 'SEO-1' ORDER BY id`).all<{ checklist: string }>()).results.map((r) => r.checklist);
  return JSON.stringify({
    rank: await count("seo_rank_checks"), content: await count("seo_content"), claude: await count("claude_tasks"), usage: await count("usage"), reports: await count("seo_reports"),
    snaps: await count("seo_gbp_snapshots"), tasks: await count("tasks"), ticks,
  });
}

describe("sweepSeo", () => {
  it("watches, pulls the month's ranks and slots, ticks 1.1 and starts the report, once, and the next days change nothing", async () => {
    const a = await seoClient({ keywords: 2 });
    const b = await seoClient({ plan: "local_seo_growth", keywords: 3 });
    expect(await generateRecurring(e, NOW)).toBe(2);

    expect(await sweepSeo(e, NOW)).toEqual({ clients: 2, watched: 2, ranked: 2, reports: 2, blocked: false });

    for (const [s, n] of [[a, 2], [b, 3]] as const) {
      expect((await rankChecksFor(env.DB, s.businessId, {})).map((r) => r.takenOn)).toEqual(Array(n).fill("2026-12-01"));
      expect((await getProfile(env.DB, s.businessId))!.lastWatchOn).toBe("2026-12-01");
      expect((await snapshotsFor(env.DB, s.businessId, {})).map((x) => x.takenOn)).toEqual(["2026-12-01"]);
    }
    // The month's slots: Local SEO 2 + 1, Growth 4 + 2, each with Claude's draft queued.
    expect((await listContent(env.DB, { businessId: a.businessId, period: "2026-12" })).map((i) => i.status)).toEqual(Array(3).fill("drafting"));
    expect((await listContent(env.DB, { businessId: b.businessId, period: "2026-12" })).map((i) => i.status)).toEqual(Array(6).fill("drafting"));
    expect(await jobs("seo.content")).toHaveLength(9);
    // 1.1 (the data pull) of the month's SEO-1 task, only that one.
    for (const s of [a, b]) expect((await seo1(s, "2026-12")).checklist.map((c) => c.done)).toEqual([true, false, false, false, false, false, false]);
    // November's report: frozen facts from the first check of December, a token, no words yet, and Claude's job queued.
    for (const s of [a, b]) {
      const r = (await getSeoReportFor(env.DB, s.businessId, "2026-11"))!;
      expect(r).toMatchObject({ businessId: s.businessId, period: "2026-11", status: "collecting", test: false, summary: "", approvalId: null });
      expect(r.token).toMatch(/^[A-Za-z0-9_-]{43}$/);
      expect(r.facts).toMatchObject({ version: 1, period: "2026-11", label: "November 2026", rankAsOf: "2026-12-01", previousRankAsOf: null });
      expect(r.claudeTaskId).not.toBeNull();
      expect(await jobs("seo.report")).toContainEqual({ kind: "seo.report", target_id: r.id, status: "pending" });
    }
    expect(await jobs("seo.report")).toHaveLength(2);
    expect(placesCalls()).toBe(2 + 9 * 5); // a details call per client, and 9 points for each of the 5 keywords

    const before = await state();
    const calls = placesCalls();
    expect(await sweepSeo(e, NOW)).toEqual({ clients: 0, watched: 0, ranked: 0, reports: 0, blocked: false });
    expect(await sweepSeo(e, at(NOW, 1))).toEqual({ clients: 0, watched: 0, ranked: 0, reports: 0, blocked: false });
    expect(await state()).toBe(before);
    expect(placesCalls()).toBe(calls);
  });

  it("gives a test client, a client on billing hold, a profile still in setup or paused, and a client with no SEO-1 cadence nothing", async () => {
    const test = await seoClient({ test: true });
    const held = await seedClient({ subs: [{ key: "local_seo", monthlyCents: 60_000 }], invoice: { cents: 5000 } });
    await addCadence(env.DB, held.project!.id, "SEO-1");
    await upsertProfile(env.DB, held.businessId, { placeId: "ChIJace", lat: 45.43, lng: -122.77, status: "active" }, "2026-10-01T00:00:00.000Z");
    await addKeyword(env.DB, held.businessId, { term: "drain cleaning", town: "" }, "2026-10-01T00:00:00.000Z");
    await placeHold(env.DB, { businessId: held.businessId, invoiceId: held.invoice!.id, now: NOW.toISOString() });
    const setup = await seoClient({ status: "setup" });
    const paused = await seoClient({ status: "paused" });
    const noCadence = await seoClient({ cadence: false });
    const good = await seoClient();
    for (const s of [test, held, setup, paused, noCadence, good]) expect(s.businessId).toBeTruthy();
    await generateRecurring(e, NOW);

    expect(await sweepSeo(e, NOW)).toEqual({ clients: 1, watched: 1, ranked: 1, reports: 1, blocked: false });
    expect((await rankChecksFor(env.DB, good.businessId, {})).length).toBeGreaterThan(0);
    for (const s of [test, held, setup, paused, noCadence]) {
      expect(await rankChecksFor(env.DB, s.businessId, {}), s.businessId).toEqual([]);
      expect((await getProfile(env.DB, s.businessId))!.lastWatchOn).toBeNull();
    }
    expect((await reports()).map((r) => r.businessId)).toEqual([good.businessId]);
    expect(detailsCalls()).toBe(1);
  });

  it("makes no Places call when the places sub-cap is reached, says so once, and still builds the report from the checks it already has", async () => {
    const withCheck = await seoClient({ keywords: 2 });
    const without = await seoClient({ keywords: 2 });
    await check(withCheck, "2026-12-01");
    await generateRecurring(e, NOW);
    await setSpendCap(env.DB, "places", 1);
    await env.DB.prepare(`INSERT INTO usage (id, month, service, units, est_cost_usd, created_at) VALUES ('u1', '2026-12', 'places', 300, 1.5, ?)`).bind(NOW.toISOString()).run();

    expect(await sweepSeo(e, NOW)).toEqual({ clients: 1, watched: 0, ranked: 0, reports: 1, blocked: true });
    expect(placesCalls()).toBe(0);
    expect(errors.mock.calls.filter((c: unknown[]) => String(c[0]).includes("seo sweep"))).toHaveLength(1);
    expect((await reports()).map((r) => r.businessId)).toEqual([withCheck.businessId]);
    expect(await jobs("seo.report")).toHaveLength(1);
    // The client with no check got nothing: no check, no watch, no slots, nothing ticked, no report.
    expect(await rankChecksFor(env.DB, without.businessId, {})).toEqual([]);
    expect(await listContent(env.DB, { businessId: without.businessId })).toEqual([]);
    expect((await seo1(without, "2026-12")).checklist.every((c) => !c.done)).toBe(true);
    expect((await getProfile(env.DB, without.businessId))!.lastWatchOn).toBeNull();

    // Once the cap is lifted the next run catches up.
    await setSpendCap(env.DB, "places", null);
    expect(await sweepSeo(e, at(NOW, 1))).toMatchObject({ clients: 2, blocked: false });
    expect((await rankChecksFor(env.DB, without.businessId, {})).length).toBe(2);
  });

  it("stops everything for the run when the cap is reached part way through", async () => {
    await seoClient({ keywords: 1 });
    await seoClient({ keywords: 1 });
    await generateRecurring(e, NOW);
    // The first client's Places calls push the places spend over its cap: the second client's must not start.
    await setSpendCap(env.DB, "places", 0.001);
    const real = globalThis.fetch;
    vi.stubGlobal("fetch", vi.fn(async (...a: Parameters<typeof fetch>) => {
      const r = await real(...a);
      await env.DB.prepare(`INSERT INTO usage (id, month, service, units, est_cost_usd, created_at) VALUES (?, '2026-12', 'places', 1, 0.5, ?)`).bind(crypto.randomUUID(), NOW.toISOString()).run();
      return r;
    }));
    expect(await sweepSeo(e, NOW)).toMatchObject({ clients: 1, blocked: true });
    expect((await env.DB.prepare(`SELECT COUNT(DISTINCT business_id) AS n FROM seo_rank_checks`).first<{ n: number }>())!.n).toBe(1);
  });

  it("makes no Places call and logs once when the Places key is not set, but still starts a report from existing checks", async () => {
    const s = await seoClient({ keywords: 1 });
    await seoClient({ keywords: 1 });
    await check(s, "2026-12-01");
    expect(await sweepSeo({ ...E } as Env, NOW)).toEqual({ clients: 1, watched: 0, ranked: 0, reports: 1, blocked: false });
    expect(placesCalls()).toBe(0);
    expect(errors.mock.calls.filter((c: unknown[]) => String(c[0]).includes("Places key"))).toHaveLength(1);
  });

  it("watches again only after more than 6 days: not at 3 days, yes at 7", async () => {
    expect(WATCH_EVERY_DAYS).toBe(6);
    const recent = await seoClient({ lastWatchOn: "2026-11-28", placeId: "ChIJrecent" });
    const old = await seoClient({ lastWatchOn: "2026-11-24", placeId: "ChIJold" });
    const six = await seoClient({ lastWatchOn: "2026-11-25", placeId: "ChIJsix" });
    expect(await sweepSeo(e, NOW)).toMatchObject({ clients: 3, watched: 1, ranked: 3 });
    expect(urls.filter((u) => u.includes("/places/ChIJ"))).toEqual(["https://places.googleapis.com/v1/places/ChIJold"]);
    expect((await getProfile(env.DB, recent.businessId))!.lastWatchOn).toBe("2026-11-28");
    expect((await getProfile(env.DB, old.businessId))!.lastWatchOn).toBe("2026-12-01");
    expect((await getProfile(env.DB, six.businessId))!.lastWatchOn).toBe("2026-11-25");
  });

  it("a client whose parts throw is logged and does not stop the next one", async () => {
    const bad = await seoClient({ placeId: "ChIJbad", keywords: 1 });
    const ok = await seoClient({ keywords: 1 });
    await generateRecurring(e, NOW);
    details = (id) => { if (id === "ChIJbad") throw new Error("network down"); return jsonRes(place(id)); };
    const real = contentMod.ensureSlots;
    let broken = true;
    const spy = vi.spyOn(contentMod, "ensureSlots").mockImplementation((en, id, ...rest) => (broken && id === bad.businessId ? Promise.reject(new Error("slots exploded")) : real(en, id, ...rest)));

    expect(await sweepSeo(e, NOW)).toEqual({ clients: 2, watched: 1, ranked: 2, reports: 2, blocked: false });
    expect((await getProfile(env.DB, bad.businessId))!.lastWatchOn).toBeNull();
    expect(errors).toHaveBeenCalledWith("seo sweep: could not watch a client's reviews", expect.stringContaining("Google could not be reached"));
    expect(errors).toHaveBeenCalledWith("seo sweep: could not plan a client's content", "slots exploded");
    // The failing client's other parts ran (its grid, the tick and its report), and the good one is whole.
    expect((await rankChecksFor(env.DB, bad.businessId, {})).length).toBe(1);
    expect(await listContent(env.DB, { businessId: bad.businessId })).toEqual([]);
    expect((await seo1(bad, "2026-12")).checklist[0].done).toBe(true);
    expect((await seo1(ok, "2026-12")).checklist[0].done).toBe(true);
    expect((await listContent(env.DB, { businessId: ok.businessId, period: "2026-12" })).length).toBe(3);

    // The next day the month's slots are made (the month has a check and no slots), and only for the client that lacked them.
    broken = false;
    details = (id) => jsonRes(place(id));
    spy.mockClear();
    expect(await sweepSeo(e, at(NOW, 1))).toMatchObject({ clients: 1 });
    expect((await listContent(env.DB, { businessId: bad.businessId, period: "2026-12" })).length).toBe(3);
    expect(spy.mock.calls.map((c) => c[1])).toEqual([bad.businessId]);
    // With the slots complete a second run the same day does not call it at all.
    spy.mockClear();
    expect(await sweepSeo(e, at(NOW, 1))).toMatchObject({ clients: 0 });
    expect(spy).not.toHaveBeenCalled();
  });

  it("makes the month's slots and the 1.1 tick when the month's first check came from the baseline or the owner's rank check, and not again", async () => {
    const s = await seoClient({ keywords: 2 });
    await generateRecurring(e, NOW);
    await check(s, "2026-12-01"); // taken by hand (the manual route and the baseline store checks the same way)
    const spy = vi.spyOn(contentMod, "ensureSlots");
    expect(await sweepSeo(e, NOW)).toMatchObject({ clients: 1, ranked: 0, reports: 1 });
    expect(spy).toHaveBeenCalledTimes(1);
    expect((await listContent(env.DB, { businessId: s.businessId, period: "2026-12" })).length).toBe(3);
    expect((await seo1(s, "2026-12")).checklist.map((c) => c.done)).toEqual([true, false, false, false, false, false, false]);
    spy.mockClear();
    expect(await sweepSeo(e, NOW)).toMatchObject({ clients: 0 });
    expect(spy).not.toHaveBeenCalled();
  });

  it("queues the draft of a slot again when its task expired and put it back to planned, once, and leaves a slot that has its draft or a task alone", async () => {
    const s = await seoClient({ keywords: 2 });
    await generateRecurring(e, NOW);
    await check(s, "2026-12-01");
    await sweepSeo(e, NOW);
    const first = await listContent(env.DB, { businessId: s.businessId, period: "2026-12" });
    expect(first.map((i) => i.status)).toEqual(["drafting", "drafting", "drafting"]);
    expect(await jobs("seo.content")).toHaveLength(3);
    // Claude writes one of the three; nobody picks up the other two, and 15 days on the queue's expiry puts those slots back to planned with no task.
    expect(await setContent(env.DB, first[0].id, ["drafting"], { title: "A title", body: "A body", status: "drafted" }, NOW.toISOString())).toBe(true);
    expect(await expireOldTasks(e, at(NOW, 15))).toBeGreaterThanOrEqual(3);
    expect((await listContent(env.DB, { businessId: s.businessId, period: "2026-12" })).map((i) => [i.status, i.claudeTaskId === null])).toEqual([["drafted", false], ["planned", true], ["planned", true]]);
    // The next daily run hands the two slots to Claude again, and the one after it hands out nothing more.
    await sweepSeo(e, at(NOW, 15));
    const again = await listContent(env.DB, { businessId: s.businessId, period: "2026-12" });
    expect(again.map((i) => i.status)).toEqual(["drafted", "drafting", "drafting"]);
    expect(again[1].claudeTaskId).not.toBeNull();
    expect(again[1].claudeTaskId).not.toBe(first[1].claudeTaskId);
    expect((await jobs("seo.content")).filter((j) => j.status === "pending")).toHaveLength(2);
    expect(await jobs("seo.content")).toHaveLength(5);
    await sweepSeo(e, at(NOW, 16));
    expect(await jobs("seo.content")).toHaveLength(5);
  });

  it("says on the client's timeline when the listing gained reviews that Google did not show us, once for each watch", async () => {
    const s = await seoClient({ keywords: 1 });
    await generateRecurring(e, NOW);
    const notes = async () => (await listActivity(env.DB, s.businessId)).filter((a) => a.kind === "note").map((a) => a.detail);
    await sweepSeo(e, NOW); // the first watch has nothing earlier to compare with
    expect(await notes()).toEqual([]);
    details = (id) => jsonRes({ ...place(id), userRatingCount: 83 }); // 3 more reviews, none of them shown
    await sweepSeo(e, at(NOW, 7));
    expect(await notes()).toEqual(["Local SEO watch 2026-12-08: the Google listing has 3 more reviews than Google shows us. Check the profile."]);
    await sweepSeo(e, at(NOW, 7)); // the same day again: no watch, no second line
    expect(await notes()).toHaveLength(1);
    details = (id) => jsonRes({ ...place(id), userRatingCount: 84 });
    await sweepSeo(e, at(NOW, 14));
    expect((await notes()).at(0)).toBe("Local SEO watch 2026-12-15: the Google listing has 1 more review than Google shows us. Check the profile.");
  });

  it("pauses a client whose Google place is gone or changed: nothing more is pulled, watched or reported for it, and picking the place again and taking the baseline switches it back on", async () => {
    for (const [name, answer] of [["gone", () => jsonRes({ error: { message: "not found" } }, 404)], ["moved", () => jsonRes({ ...place("ChIJace"), id: "ChIJ-NEW" })]] as const) {
      const s = await seoClient({ keywords: 2 });
      await generateRecurring(e, NOW);
      await check(s, "2026-12-01"); // a usable check is there, so a report would start
      details = answer;
      urls = [];
      expect(await sweepSeo(e, NOW), name).toMatchObject({ clients: 1, watched: 0, ranked: 0, reports: 0 });
      expect(await getProfile(env.DB, s.businessId), name).toMatchObject({ status: "paused", lastWatchOn: "2026-12-01" });
      expect(searchCalls(), name).toBe(0);
      expect(await reports(), name).toEqual([]);
      expect(detailsCalls(), name).toBe(1);
      // The next days: nothing, and no more paid calls.
      expect(await sweepSeo(e, at(NOW, 1)), name).toMatchObject({ clients: 0 });
      expect(detailsCalls(), name).toBe(1);
      // Picked again and taken a baseline of, the client is active again.
      details = (id) => jsonRes(place(id));
      await setupProfile(e, s.businessId, { placeId: "ChIJace", trade: "plumber", towns: ["Tigard"], gridKm: 3 }, at(NOW, 2).toISOString());
      expect((await getProfile(env.DB, s.businessId))!.status, name).toBe("paused");
      await runBaseline(e, s.businessId, at(NOW, 2));
      expect((await getProfile(env.DB, s.businessId))!.status, name).toBe("active");
      await env.DB.prepare(`DELETE FROM seo_profiles WHERE business_id = ?`).bind(s.businessId).run(); // the next case starts from its own client
    }
  });

  it("does not try a client again the same day when Google refuses the key: one rank call, and the next run that day makes none", async () => {
    const s = await seoClient({ keywords: 3 });
    await generateRecurring(e, NOW);
    search = () => jsonRes({ error: { message: "API key not valid" } }, 403);
    await sweepSeo(e, NOW);
    expect(searchCalls()).toBe(1);
    expect(await rankChecksFor(env.DB, s.businessId, {})).toHaveLength(1);
    await sweepSeo(e, NOW);
    expect(searchCalls()).toBe(1);
  });

  it("ticks 1.1 when a usable check arrives after the slots were made", async () => {
    const s = await seoClient({ keywords: 1 });
    await generateRecurring(e, NOW);
    await check(s, "2026-12-01", 5); // not usable: slots are made, nothing is ticked
    await sweepSeo(e, NOW);
    expect((await seo1(s, "2026-12")).checklist[0].done).toBe(false);
    expect((await listContent(env.DB, { businessId: s.businessId, period: "2026-12" })).length).toBe(3);
    await check(s, "2026-12-01", 9); // the owner's check replaces it the same day
    expect(await sweepSeo(e, NOW)).toMatchObject({ clients: 1, reports: 1 });
    expect((await seo1(s, "2026-12")).checklist[0].done).toBe(true);
  });

  it("retries a pull that left an unusable check on a later day, builds the report from the good one, and does not pull again once every keyword is usable", async () => {
    expect(MAX_PULL_DAYS_PER_MONTH).toBe(4);
    const s = await seoClient({ keywords: 2 });
    const fine = await seoClient({ keywords: 2, placeId: "ChIJfine" });
    await generateRecurring(e, NOW);
    // 1 December: Google throttles during the first client's grid: 5 of 9 points, three errors in a row, and the run gives up (its second keyword is never reached).
    let throttle = true;
    let n = 0;
    search = () => { n++; return throttle && n >= 6 && n <= 8 ? new Response("", { status: 500 }) : jsonRes({ places: [{ id: "other" }, { id: "ChIJace" }] }); };
    expect(await sweepSeo(e, NOW)).toMatchObject({ clients: 2 });
    const first = await rankChecksFor(env.DB, s.businessId, {});
    expect(first.length).toBe(1);
    expect(first[0].points.filter((p) => p.ok).length).toBe(5);
    expect(await getSeoReportFor(env.DB, s.businessId, "2026-11")).toBeNull();
    expect((await seo1(s, "2026-12")).checklist[0].done).toBe(false);

    // 2 December: Google is fine. The grid is run again for the client with no usable check, the report is built from that check (not the day before), and the client that was fine is left alone.
    throttle = false;
    urls = [];
    await sweepSeo(e, at(NOW, 1));
    const days = (await rankChecksFor(env.DB, s.businessId, {})).map((c) => c.takenOn);
    expect(days).toEqual(["2026-12-01", "2026-12-02", "2026-12-02"]); // the unusable check of the 1st stays, and is never used
    expect((await getSeoReportFor(env.DB, s.businessId, "2026-11"))!.facts).toMatchObject({ rankAsOf: "2026-12-02", previousRankAsOf: null });
    expect((await seo1(s, "2026-12")).checklist[0].done).toBe(true);
    expect((await rankChecksFor(env.DB, fine.businessId, {})).map((c) => c.takenOn)).toEqual(["2026-12-01", "2026-12-01"]);
    expect(searchCalls()).toBe(18); // one client's grid of 2 keywords x 9 points
    urls = [];
    await sweepSeo(e, at(NOW, 2));
    expect(searchCalls()).toBe(0);
  });

  it("gives up on a client whose pulls have failed on 4 different days of the month", async () => {
    const s = await seoClient({ keywords: 1 });
    search = () => new Response("", { status: 500 }); // every point fails
    for (let d = 0; d < 6; d++) await sweepSeo(e, at(NOW, d));
    expect([...new Set((await rankChecksFor(env.DB, s.businessId, {})).map((c) => c.takenOn))]).toEqual(["2026-12-01", "2026-12-02", "2026-12-03", "2026-12-04"]);
    expect(await reports()).toEqual([]);
    // A call the first four days made only, nothing on the 5th and 6th.
    urls = [];
    await sweepSeo(e, at(NOW, 6));
    expect(searchCalls()).toBe(0);
  });

  it("handles 25 clients a run, and the 26th goes first the next day", async () => {
    expect(MAX_CLIENTS_PER_RUN).toBe(25);
    const all: Client[] = [];
    for (let i = 0; i < 26; i++) all.push(await seoClient({ keywords: 1, placeId: `ChIJ${i}` }));
    expect(await sweepSeo(e, NOW)).toMatchObject({ clients: 25, ranked: 25, reports: 25 });
    expect(await rankChecksFor(env.DB, all[25].businessId, {})).toEqual([]);
    urls = [];
    expect(await sweepSeo(e, at(NOW, 1))).toMatchObject({ clients: 1, watched: 1, ranked: 1, reports: 1 });
    expect(urls[0]).toBe("https://places.googleapis.com/v1/places/ChIJ25");
    expect((await rankChecksFor(env.DB, all[25].businessId, {})).map((r) => r.takenOn)).toEqual(["2026-12-02"]);
    expect(await reports()).toHaveLength(26);
  }, 60_000);

  it("takes the least recently handled client first, also when every client has work again", async () => {
    // Nobody is watched in December (a watch just before), so a client's turn is only marked by the sweep itself, not by the watch writing its profile.
    const all: Client[] = [];
    for (let i = 0; i < 26; i++) all.push(await seoClient({ keywords: 1, placeId: `ChIJ${i}`, lastWatchOn: "2026-11-30" }));
    expect(await sweepSeo(e, NOW)).toMatchObject({ clients: 25, watched: 0, ranked: 25, reports: 25 });
    expect(await rankChecksFor(env.DB, all[25].businessId, {})).toEqual([]);

    // On 1 January every client has work again (a new month): the one left out in December is the first of the 25.
    urls = [];
    const jan = new Date("2027-01-01T17:00:00.000Z");
    expect(await sweepSeo(e, jan)).toMatchObject({ clients: 25, watched: 25, ranked: 25 });
    expect(urls[0]).toBe("https://places.googleapis.com/v1/places/ChIJ25");
    expect((await rankChecksFor(env.DB, all[25].businessId, {})).map((r) => r.takenOn)).toEqual(["2027-01-01"]);
    expect((await rankChecksFor(env.DB, all[24].businessId, {})).map((r) => r.takenOn)).toEqual(["2026-12-01"]); // the one that did not fit now
  }, 60_000);

  it("keeps within the Places budget: the 5th of 20 clients with 10 keywords waits for the next run, which starts with it", async () => {
    expect(MAX_PLACES_CALLS_PER_RUN).toBe(400);
    const all: Client[] = [];
    for (let i = 0; i < 20; i++) all.push(await seoClient({ keywords: 10, placeId: `ChIJ${i}` }));
    const done = async () => (await Promise.all(all.map(async (s) => (await rankChecksFor(env.DB, s.businessId, {})).length))).map((n) => n > 0);

    const first = await sweepSeo(e, NOW);
    expect(first).toMatchObject({ clients: 4, watched: 4, ranked: 4, blocked: false });
    expect(placesCalls()).toBe(4 * 91);
    expect(placesCalls()).toBeLessThanOrEqual(MAX_PLACES_CALLS_PER_RUN);
    expect(await done()).toEqual([...Array(4).fill(true), ...Array(16).fill(false)]);
    expect(logs).toHaveBeenCalledWith(expect.stringContaining("seo sweep"));

    urls = [];
    expect(await sweepSeo(e, at(NOW, 1))).toMatchObject({ clients: 4, ranked: 4 });
    expect(urls[0]).toBe("https://places.googleapis.com/v1/places/ChIJ4"); // the client that was skipped goes first
    expect(placesCalls()).toBe(4 * 91);
    expect(await done()).toEqual([...Array(8).fill(true), ...Array(12).fill(false)]);

    for (const d of [2, 3, 4]) await sweepSeo(e, at(NOW, d));
    expect((await done()).every(Boolean)).toBe(true);
  }, 120_000);

  it("starts no more Places work 6 minutes into the run, still makes the reports, slots and ticks, and the next run starts with the clients it did not reach", async () => {
    expect(MAX_PLACES_WALL_MS).toBe(6 * 60_000);
    const all: Client[] = [];
    for (let i = 0; i < 3; i++) all.push(await seoClient({ keywords: 1, placeId: `ChIJ${i}` }));
    await generateRecurring(e, NOW);
    // The clock moves 4 minutes on every look: the first client starts at 4 minutes, the second at 8, which is past the guard.
    let t = 0;
    const real = seoClock.now;
    seoClock.now = () => (t += 4 * 60_000);
    try {
      const out = await sweepSeo(e, NOW);
      expect(out).toMatchObject({ clients: 1, watched: 1, ranked: 1, reports: 1 });
    } finally { seoClock.now = real; }
    expect(await rankChecksFor(env.DB, all[0].businessId, {})).toHaveLength(1);
    for (const s of all.slice(1)) expect(await rankChecksFor(env.DB, s.businessId, {})).toEqual([]);
    expect(logs).toHaveBeenCalledWith(expect.stringContaining("used its time for Places work"));
    // Not touched, so first in line next time; a client with a usable check but out of time still gets its report and slots.
    await check(all[2], "2026-12-01");
    urls = [];
    t = 0;
    seoClock.now = () => (t += 4 * 60_000);
    try { await sweepSeo(e, at(NOW, 1)); } finally { seoClock.now = real; }
    expect(urls[0]).toBe("https://places.googleapis.com/v1/places/ChIJ1");
    expect((await reports()).map((r) => r.businessId)).toContain(all[2].businessId);
    expect((await listContent(env.DB, { businessId: all[2].businessId, period: "2026-12" })).length).toBeGreaterThan(0);
  });

  it("a report start is never held back by the budget: a client with a usable check still gets its report when the run's Places budget is used", async () => {
    const heavy: Client[] = [];
    for (let i = 0; i < 8; i++) heavy.push(await seoClient({ keywords: 10, placeId: `ChIJ${i}` }));
    const late = await seoClient({ keywords: 1 });
    await check(late, "2026-12-01"); // pulled by hand earlier today, but its report is not made yet
    expect(await sweepSeo(e, NOW)).toMatchObject({ clients: 4 + 1, ranked: 4, reports: 4 + 1 });
    expect(await getSeoReportFor(env.DB, late.businessId, "2026-11")).not.toBeNull();
    expect(await getSeoReportFor(env.DB, heavy[7].businessId, "2026-11")).toBeNull(); // waited for Places, so it has no check to report from
  }, 120_000);

  it("builds nothing for a report whose month's usable check does not exist yet: a check from the last evening of November belongs to November", async () => {
    const s = await seoClient({ keywords: 1 });
    const lastEvening = new Date("2026-12-01T07:30:00.000Z"); // 23:30 on 30 November in Los Angeles
    expect(localDay(lastEvening.toISOString(), LA)).toBe("2026-11-30");

    // Run then, the month is November: the check is November's, and the report is October's (made from the first check after October).
    expect(await sweepSeo(e, lastEvening)).toMatchObject({ clients: 1, ranked: 1, reports: 1 });
    expect((await rankChecksFor(env.DB, s.businessId, {})).map((r) => r.takenOn)).toEqual(["2026-11-30"]);
    expect((await getSeoReportFor(env.DB, s.businessId, "2026-10"))!.facts).toMatchObject({ period: "2026-10", rankAsOf: "2026-11-30" });
    expect(await getSeoReportFor(env.DB, s.businessId, "2026-11")).toBeNull();

    // Block Places the next morning: November's report must not be made from the 30 November check.
    await setSpendCap(env.DB, "places", 1);
    await env.DB.prepare(`INSERT INTO usage (id, month, service, units, est_cost_usd, created_at) VALUES ('u1', '2026-12', 'places', 300, 1.5, ?)`).bind(NOW.toISOString()).run();
    expect(await sweepSeo(e, NOW)).toMatchObject({ clients: 0, reports: 0, blocked: true });
    expect(await getSeoReportFor(env.DB, s.businessId, "2026-11")).toBeNull();

    // With Places back, December's own check is taken first and November's report is made from it, with the 30 November check as the one before.
    await setSpendCap(env.DB, "places", null);
    expect(await sweepSeo(e, NOW)).toMatchObject({ clients: 1, ranked: 1, reports: 1 });
    expect((await getSeoReportFor(env.DB, s.businessId, "2026-11"))!.facts).toMatchObject({ period: "2026-11", rankAsOf: "2026-12-01", previousRankAsOf: "2026-11-30" });
  });

  it("on 1 January it builds December of the year before, with January's slots", async () => {
    const s = await seoClient({ keywords: 1 });
    const jan = new Date("2026-01-01T17:00:00.000Z");
    expect(await sweepSeo(e, jan)).toMatchObject({ clients: 1, ranked: 1, reports: 1 });
    expect((await getSeoReportFor(env.DB, s.businessId, "2025-12"))!.facts).toMatchObject({ period: "2025-12", label: "December 2025", rankAsOf: "2026-01-01" });
    expect((await listContent(env.DB, { businessId: s.businessId })).map((i) => i.period)).toEqual(Array(3).fill("2026-01"));
  });

  it("a report for a client whose only check is the baseline of the same day says it is the first check", async () => {
    const s = await seoClient({ keywords: 2 });
    await check(s, "2026-12-01"); // the baseline, taken today
    expect(await sweepSeo(e, NOW)).toMatchObject({ clients: 1, ranked: 0, reports: 1 });
    expect(placesCalls()).toBe(1); // only the watch: the month already has its check
    const facts = (await getSeoReportFor(env.DB, s.businessId, "2026-11"))!.facts as SeoReportFacts;
    expect(facts).toMatchObject({ rankAsOf: "2026-12-01", previousRankAsOf: null });
    expect(plainSeoSummary(facts)).toContain("This is the first check");
  });

  it("does not start a report from a check with too few measured points, and does when a later check is good", async () => {
    const s = await seoClient({ keywords: 1 });
    await check(s, "2026-12-01", 6); // 6 of 9 measured: not usable
    expect(await sweepSeo(e, NOW)).toMatchObject({ clients: 1, reports: 0 });
    expect(await reports()).toEqual([]);
    expect(errors).not.toHaveBeenCalled(); // not having a report yet is not a fault
    await check(s, "2026-12-02", 9);
    expect(await sweepSeo(e, at(NOW, 1))).toMatchObject({ clients: 1, reports: 1 });
    expect((await getSeoReportFor(env.DB, s.businessId, "2026-11"))!.facts).toMatchObject({ rankAsOf: "2026-12-02" });
  });

  it("finishes a report left without its words job (a crash between the two writes), and leaves a report that has one", async () => {
    const s = await seoClient({ keywords: 1 });
    await check(s, "2026-12-01");
    await startSeoReport(e, s.businessId, "2026-11", { test: false, now: NOW });
    expect(await jobs("seo.report")).toHaveLength(1);
    await env.DB.prepare(`DELETE FROM claude_tasks WHERE kind = 'seo.report'`).run();
    await env.DB.prepare(`UPDATE seo_reports SET claude_task_id = NULL`).run();
    expect(await sweepSeo(e, NOW)).toMatchObject({ reports: 0 });
    expect(await jobs("seo.report")).toHaveLength(1);
    expect((await getSeoReportFor(env.DB, s.businessId, "2026-11"))!.claudeTaskId).not.toBeNull();
    expect(await sweepSeo(e, NOW)).toEqual({ clients: 0, watched: 0, ranked: 0, reports: 0, blocked: false });
  });
});

describe("startSeoReport", () => {
  it("refuses with a plain sentence when there is no usable check on or after the 1st of the next month", async () => {
    const s = await seoClient({ keywords: 1 });
    const refusal = (p: Promise<unknown>) => p.then(() => null, (x: unknown) => x);
    let err = await refusal(startSeoReport(e, s.businessId, "2026-11", { test: false, now: NOW }));
    expect(err).toBeInstanceOf(SeoReportRefused);
    expect((err as Error).message).toMatch(/^[A-Z][^<>{}]*\.$/);
    await check(s, "2026-11-30"); // November's own last day: not after the month
    err = await refusal(startSeoReport(e, s.businessId, "2026-11", { test: false, now: NOW }));
    expect(err).toBeInstanceOf(SeoReportRefused);
    await check(s, "2026-12-01", 6); // too few points
    err = await refusal(startSeoReport(e, s.businessId, "2026-11", { test: false, now: NOW }));
    expect(err).toBeInstanceOf(SeoReportRefused);
    expect(await reports()).toEqual([]);
    expect(await jobs("seo.report")).toEqual([]);
  });

  it("makes the report for a rehearsal client flagged test, and a second call returns the same one", async () => {
    const s = await seoClient({ test: true, keywords: 1 });
    await check(s, "2026-12-01");
    const first = await startSeoReport(e, s.businessId, "2026-11", { test: true, now: NOW });
    expect(first.created).toBe(true);
    expect(first.report).toMatchObject({ businessId: s.businessId, period: "2026-11", test: true, status: "collecting" });
    expect(await jobs("seo.report")).toEqual([{ kind: "seo.report", target_id: first.report.id, status: "pending" }]);
    const again = await startSeoReport(e, s.businessId, "2026-11", { test: true, now: NOW });
    expect(again).toMatchObject({ created: false });
    expect(again.report.id).toBe(first.report.id);
    expect(await jobs("seo.report")).toHaveLength(1);
  });
});

describe("POST /clients/:id/seo/report", () => {
  let cookie = "";
  const ctx = () => createExecutionContext();
  async function call(id: string, status: number) {
    if (!cookie) {
      const login = await worker.fetch(new Request("https://x/api/login", { method: "POST", body: JSON.stringify({ password: "test-pass" }), headers: { "content-type": "application/json" } }), E, ctx());
      cookie = login.headers.get("set-cookie")!.split(";")[0];
    }
    const r = await worker.fetch(new Request(`https://x/api/clients/${id}/seo/report`, { method: "POST", headers: { cookie, "content-type": "application/json" } }), e, ctx());
    const text = await r.text();
    expect(r.status, text).toBe(status);
    return JSON.parse(text) as { report?: { id: string; status: string; period: string }; error?: string };
  }

  it("builds last month's report by hand for a test client, answers 200 with the same one, and 409 with a sentence when there is no usable check", async () => {
    const s = await seoClient({ test: true, keywords: 1 });
    const refused = await call(s.businessId, 409);
    expect(refused.error).toMatch(/\.$/);
    expect(JSON.stringify(refused)).not.toContain(KEY);

    const tz = zoneOf(await getSettings(env.DB));
    const now = new Date();
    await check(s, localDay(now.toISOString(), tz)); // today's check is on or after the 1st of this month
    const made = await call(s.businessId, 201);
    expect(made.report).toMatchObject({ status: "collecting", period: previousMonth(now, tz) });
    expect((await call(s.businessId, 200)).report!.id).toBe(made.report!.id);
    expect((await getSeoReportFor(env.DB, s.businessId, made.report!.period))!.test).toBe(true);
    expect(await jobs("seo.report")).toHaveLength(1);
  });

  it("404s for something that is not a client", async () => {
    await call("nobody", 404);
  });
});

describe("the daily run", () => {
  it("runs the local SEO sweep after the care reports", async () => {
    const s = await seoClient({ keywords: 1 });
    await runScheduled(e, DAILY_CRON, NOW);
    const names = logs.mock.calls.map((c: unknown[]) => String(c[0]));
    expect(names.indexOf("seo")).toBeGreaterThan(names.indexOf("care reports"));
    expect(names.indexOf("care reports")).toBeGreaterThanOrEqual(0);
    expect(logs).toHaveBeenCalledWith("seo", JSON.stringify({ clients: 1, watched: 1, ranked: 1, reports: 1, blocked: false }));
    expect(await getSeoReportFor(env.DB, s.businessId, "2026-11")).not.toBeNull();
  });

  it("a failing SEO sweep is logged and does not fail the run", async () => {
    await seoClient({ keywords: 1 });
    const broken = { ...e, DB: new Proxy(env.DB, { get(t, p) {
      if (p === "prepare") return (sql: string) => { if (/FROM seo_profiles/.test(sql)) throw new Error("db down"); return t.prepare(sql); };
      const v = (t as any)[p];
      return typeof v === "function" ? v.bind(t) : v;
    } }) } as Env;
    await expect(runScheduled(broken, DAILY_CRON, NOW)).resolves.toBeUndefined();
    expect(errors).toHaveBeenCalledWith("seo failed", expect.any(Error));
  });
});
