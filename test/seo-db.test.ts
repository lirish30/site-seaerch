import { env } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { describeActivity } from "../src/client/activityView";
import {
  addKeyword, ensureCitations, getContent, getProfile, insertContentSlots, listActiveProfiles, listCitations, listContent, listKeywords, listReviews, rankChecksFor, setCitation, setContent,
  setKeywordActive, setReviewDraft, snapshotsFor, upsertProfile, upsertRankCheck, upsertReviews, upsertSnapshot, type ContentItem, type RankPoint,
} from "../src/worker/db/seo";
import { seedClient } from "./fixtures/clients";

const T0 = "2026-12-01T10:00:00.000Z";
const T1 = "2026-12-01T11:00:00.000Z";
const P = "2026-12";

const grid = (pos: number | null): RankPoint[] => Array.from({ length: 9 }, (_, i) => ({ lat: 45 + i / 100, lng: -122 - i / 100, pos, ok: pos !== null }));
const slot = (businessId: string, o: Partial<Omit<ContentItem, "id" | "updatedAt">> = {}): Omit<ContentItem, "id" | "updatedAt"> => ({
  businessId, period: P, kind: "page", slot: 1, keywordId: null, brief: "A page about drains", title: "", metaTitle: "", metaDescription: "", body: "", status: "planned", claudeTaskId: null, url: null, ...o,
});

describe("seo profiles", () => {
  it("upserts one row per business and merges a later patch into it", async () => {
    const s = await seedClient();
    expect(await getProfile(env.DB, s.businessId)).toBeNull();
    const first = await upsertProfile(env.DB, s.businessId, { napName: "Ace Plumbing", trade: "plumber", towns: ["Vancouver", "Camas"], lat: 45.6, lng: -122.6 }, T0);
    expect(first).toMatchObject({
      businessId: s.businessId, siteId: null, placeId: null, mapsUrl: null, napName: "Ace Plumbing", napAddress: "", napPhone: "", lat: 45.6, lng: -122.6, trade: "plumber",
      towns: ["Vancouver", "Camas"], gridKm: 3, status: "setup", lastWatchOn: null, napResult: null, createdAt: T0, updatedAt: T0,
    });
    const second = await upsertProfile(env.DB, s.businessId, { status: "active", placeId: "ChIJ1", napPhone: "555-0100", lastWatchOn: "2026-12-01" }, T1);
    expect(second).toMatchObject({ napName: "Ace Plumbing", trade: "plumber", towns: ["Vancouver", "Camas"], status: "active", placeId: "ChIJ1", napPhone: "555-0100", lastWatchOn: "2026-12-01", createdAt: T0, updatedAt: T1 });
    expect(await getProfile(env.DB, s.businessId)).toEqual(second);
    expect((await env.DB.prepare(`SELECT COUNT(*) AS n FROM seo_profiles WHERE business_id = ?`).bind(s.businessId).first<{ n: number }>())!.n).toBe(1);
    // A field set to null is cleared; a field left out is not touched.
    expect(await upsertProfile(env.DB, s.businessId, { placeId: null }, T1)).toMatchObject({ placeId: null, status: "active", napName: "Ace Plumbing" });
  });

  it("lists only active profiles", async () => {
    const a = await seedClient();
    const b = await seedClient();
    await upsertProfile(env.DB, a.businessId, { status: "active" }, T0);
    await upsertProfile(env.DB, b.businessId, { status: "paused" }, T0);
    const ids = (await listActiveProfiles(env.DB)).map((p) => p.businessId);
    expect(ids).toContain(a.businessId);
    expect(ids).not.toContain(b.businessId);
  });
});

describe("keywords and rank checks", () => {
  it("adds a (term, town) once: created true then false, with the first row returned both times", async () => {
    const s = await seedClient();
    const first = await addKeyword(env.DB, s.businessId, { term: "plumber", town: "Camas" }, T0);
    const again = await addKeyword(env.DB, s.businessId, { term: "plumber", town: "Camas" }, T1);
    expect(first.created).toBe(true);
    expect(again.created).toBe(false);
    expect(again.keyword).toEqual(first.keyword);
    expect(first.keyword).toMatchObject({ businessId: s.businessId, term: "plumber", town: "Camas", active: true, createdAt: T0 });
    expect((await addKeyword(env.DB, s.businessId, { term: "plumber", town: "" }, T0)).created).toBe(true);
    expect(await listKeywords(env.DB, s.businessId)).toHaveLength(2);
  });

  it("switches a keyword off and on, and lists only the active ones on request", async () => {
    const s = await seedClient();
    const { keyword } = await addKeyword(env.DB, s.businessId, { term: "drain cleaning", town: "" }, T0);
    await addKeyword(env.DB, s.businessId, { term: "water heater", town: "" }, T0);
    expect(await setKeywordActive(env.DB, keyword.id, false)).toBe(true);
    expect((await listKeywords(env.DB, s.businessId, { activeOnly: true })).map((k) => k.term)).toEqual(["water heater"]);
    expect(await listKeywords(env.DB, s.businessId)).toHaveLength(2);
    expect(await setKeywordActive(env.DB, keyword.id, true)).toBe(true);
    expect(await listKeywords(env.DB, s.businessId, { activeOnly: true })).toHaveLength(2);
    expect(await setKeywordActive(env.DB, "nope", true)).toBe(false);
  });

  it("keeps one check per (keyword, day) with the latest points, and reads oldest first within from/to", async () => {
    const s = await seedClient();
    const { keyword } = await addKeyword(env.DB, s.businessId, { term: "plumber", town: "" }, T0);
    await upsertRankCheck(env.DB, { businessId: s.businessId, keywordId: keyword.id, takenOn: "2026-12-08", points: grid(5), now: T0 });
    await upsertRankCheck(env.DB, { businessId: s.businessId, keywordId: keyword.id, takenOn: "2026-12-01", points: grid(9), now: T0 });
    await upsertRankCheck(env.DB, { businessId: s.businessId, keywordId: keyword.id, takenOn: "2026-12-15", points: grid(null), now: T0 });
    await upsertRankCheck(env.DB, { businessId: s.businessId, keywordId: keyword.id, takenOn: "2026-12-08", points: grid(2), now: T1 });
    const all = await rankChecksFor(env.DB, s.businessId, {});
    expect(all.map((c) => c.takenOn)).toEqual(["2026-12-01", "2026-12-08", "2026-12-15"]);
    expect(all[1]).toMatchObject({ businessId: s.businessId, keywordId: keyword.id, points: grid(2) });
    expect(all[1].points).toHaveLength(9);
    expect(all[2].points[0]).toEqual({ lat: 45, lng: -122, pos: null, ok: false });
    expect((await rankChecksFor(env.DB, s.businessId, { from: "2026-12-05" })).map((c) => c.takenOn)).toEqual(["2026-12-08", "2026-12-15"]);
    expect((await rankChecksFor(env.DB, s.businessId, { to: "2026-12-08" })).map((c) => c.takenOn)).toEqual(["2026-12-01", "2026-12-08"]);
    expect((await rankChecksFor(env.DB, s.businessId, { from: "2026-12-08", to: "2026-12-08" })).map((c) => c.takenOn)).toEqual(["2026-12-08"]);
    expect(await rankChecksFor(env.DB, (await seedClient()).businessId, {})).toEqual([]);
  });
});

describe("gbp snapshots", () => {
  it("keeps one snapshot per day with the latest numbers, oldest first within from/to", async () => {
    const s = await seedClient();
    await upsertSnapshot(env.DB, { businessId: s.businessId, takenOn: "2026-12-02", rating: 4.5, reviewCount: 10, category: "Plumber", photoCount: 3, hasHours: true, now: T0 });
    await upsertSnapshot(env.DB, { businessId: s.businessId, takenOn: "2026-12-01", rating: 4.4, reviewCount: 9, category: "Plumber", photoCount: 2, hasHours: false, now: T0 });
    await upsertSnapshot(env.DB, { businessId: s.businessId, takenOn: "2026-12-02", rating: 4.6, reviewCount: 11, category: null, photoCount: null, hasHours: null, now: T1 });
    const all = await snapshotsFor(env.DB, s.businessId, {});
    expect(all).toEqual([
      { businessId: s.businessId, takenOn: "2026-12-01", rating: 4.4, reviewCount: 9, category: "Plumber", photoCount: 2, hasHours: false },
      { businessId: s.businessId, takenOn: "2026-12-02", rating: 4.6, reviewCount: 11, category: null, photoCount: null, hasHours: null },
    ]);
    expect((await snapshotsFor(env.DB, s.businessId, { from: "2026-12-02" })).map((x) => x.takenOn)).toEqual(["2026-12-02"]);
    expect((await snapshotsFor(env.DB, s.businessId, { to: "2026-12-01" })).map((x) => x.takenOn)).toEqual(["2026-12-01"]);
  });
});

describe("reviews", () => {
  const rev = (externalId: string, rating: number, body = "Fine") => ({ externalId, rating, author: "Pat", body, publishedAt: "2026-11-30T00:00:00.000Z" });

  it("inserts new reviews (flagged at three stars or fewer) and leaves a known one untouched", async () => {
    const s = await seedClient();
    const first = await upsertReviews(env.DB, s.businessId, [rev("r1", 5), rev("r2", 2), { ...rev("r3", 3), publishedAt: null }], { takenOn: "2026-12-01", now: T0 });
    expect(first.inserted.map((r) => [r.externalId, r.rating, r.flagged])).toEqual([["r1", 5, false], ["r2", 2, true], ["r3", 3, true]]);
    expect(first.inserted[0]).toMatchObject({ businessId: s.businessId, author: "Pat", body: "Fine", firstSeenOn: "2026-12-01", replyStatus: "new", replyDraft: "", claudeTaskId: null, publishedAt: "2026-11-30T00:00:00.000Z" });
    expect(first.inserted[2].publishedAt).toBeNull();
    const before = await listReviews(env.DB, s.businessId);
    const again = await upsertReviews(env.DB, s.businessId, [rev("r1", 1, "Changed"), rev("r4", 4)], { takenOn: "2026-12-02", now: T1 });
    expect(again.inserted.map((r) => r.externalId)).toEqual(["r4"]);
    const after = await listReviews(env.DB, s.businessId);
    expect(after).toHaveLength(4);
    expect(after.slice(0, 3)).toEqual(before);
    expect(after.find((r) => r.externalId === "r1")).toMatchObject({ rating: 5, body: "Fine", flagged: false, firstSeenOn: "2026-12-01" });
  });

  it("sets a draft only from the given statuses, and lists by status", async () => {
    const s = await seedClient();
    const { inserted } = await upsertReviews(env.DB, s.businessId, [rev("r1", 2), rev("r2", 5)], { takenOn: "2026-12-01", now: T0 });
    const [low, high] = inserted;
    expect(await setReviewDraft(env.DB, low.id, ["drafting"], { draft: "x", status: "drafted" })).toBe(false);
    expect(await setReviewDraft(env.DB, low.id, [], { draft: "x", status: "drafted" })).toBe(false);
    expect(await setReviewDraft(env.DB, low.id, ["new"], { draft: "", status: "drafting", taskId: "task-1" })).toBe(true);
    expect(await setReviewDraft(env.DB, low.id, ["new"], { draft: "again", status: "drafting" })).toBe(false);
    expect(await setReviewDraft(env.DB, low.id, ["drafting", "drafted"], { draft: "Thank you, Pat.", status: "drafted" })).toBe(true);
    // A task id that is not given is not touched.
    expect((await listReviews(env.DB, s.businessId, { status: ["drafted"] }))[0]).toMatchObject({ id: low.id, replyDraft: "Thank you, Pat.", replyStatus: "drafted", claudeTaskId: "task-1" });
    expect((await listReviews(env.DB, s.businessId, { status: ["new"] })).map((r) => r.id)).toEqual([high.id]);
    expect(await listReviews(env.DB, s.businessId, { status: [] })).toEqual([]);
    expect(await setReviewDraft(env.DB, "nope", ["new"], { draft: "x", status: "drafted" })).toBe(false);
  });
});

describe("content", () => {
  it("makes each (business, period, kind, slot) once and returns the row that is there", async () => {
    const s = await seedClient();
    const first = await insertContentSlots(env.DB, [slot(s.businessId), slot(s.businessId, { kind: "post", slot: 1, brief: "A post" })], T0);
    expect(first).toHaveLength(2);
    expect(first[0]).toMatchObject({ businessId: s.businessId, period: P, kind: "page", slot: 1, brief: "A page about drains", status: "planned", updatedAt: T0, claudeTaskId: null, url: null });
    const again = await insertContentSlots(env.DB, [slot(s.businessId, { brief: "Different brief" }), slot(s.businessId, { slot: 2 })], T1);
    expect(again[0]).toEqual(first[0]);
    expect(again[1].slot).toBe(2);
    expect(await listContent(env.DB, { businessId: s.businessId, period: P })).toHaveLength(3);
    expect(await insertContentSlots(env.DB, [], T1)).toEqual([]);
  });

  it("changes a row only while it is in one of the given statuses, and stamps updated_at", async () => {
    const s = await seedClient();
    const [item] = await insertContentSlots(env.DB, [slot(s.businessId)], T0);
    expect(await setContent(env.DB, item.id, ["drafting"], { status: "drafted", body: "x" }, T1)).toBe(false);
    expect(await getContent(env.DB, item.id)).toEqual(item);
    expect(await setContent(env.DB, item.id, [], { status: "drafted" }, T1)).toBe(false);
    expect(await setContent(env.DB, item.id, ["planned"], { status: "drafting", claudeTaskId: "task-9" }, T1)).toBe(true);
    expect(await setContent(env.DB, item.id, ["drafting"], { status: "drafted", title: "T", metaTitle: "MT", metaDescription: "MD", body: "Body" }, T1)).toBe(true);
    expect(await getContent(env.DB, item.id)).toMatchObject({ status: "drafted", title: "T", metaTitle: "MT", metaDescription: "MD", body: "Body", claudeTaskId: "task-9", url: null, updatedAt: T1 });
    expect(await setContent(env.DB, item.id, ["drafted"], { status: "published", url: "https://example.test/drains" }, T1)).toBe(true);
    expect(await getContent(env.DB, item.id)).toMatchObject({ status: "published", url: "https://example.test/drains", title: "T" });
    expect(await getContent(env.DB, "nope")).toBeNull();
  });

  it("lists by business, period and status", async () => {
    const a = await seedClient();
    const b = await seedClient();
    const [a1] = await insertContentSlots(env.DB, [slot(a.businessId), slot(a.businessId, { period: "2027-01" })], T0);
    await insertContentSlots(env.DB, [slot(b.businessId)], T0);
    await setContent(env.DB, a1.id, ["planned"], { status: "approved" }, T1);
    expect(await listContent(env.DB, { businessId: a.businessId })).toHaveLength(2);
    expect((await listContent(env.DB, { businessId: a.businessId, period: P })).map((c) => c.id)).toEqual([a1.id]);
    expect((await listContent(env.DB, { businessId: a.businessId, status: ["approved"] })).map((c) => c.id)).toEqual([a1.id]);
    expect(await listContent(env.DB, { businessId: a.businessId, status: ["published"] })).toEqual([]);
    expect(await listContent(env.DB, { businessId: a.businessId, status: [] })).toEqual([]);
    expect((await listContent(env.DB, { period: P })).map((c) => c.businessId)).toEqual(expect.arrayContaining([a.businessId, b.businessId]));
  });
});

describe("citations", () => {
  const DIRS = ["Google Business Profile", "Bing Places", "Apple Business Connect", "Yelp", "Facebook", "BBB", "Angi", "HomeAdvisor", "Thumbtack", "Nextdoor", "Yellow Pages", "Foursquare"];

  it("makes a todo row per directory once and lists them in the order given", async () => {
    const s = await seedClient();
    const first = await ensureCitations(env.DB, s.businessId, DIRS, T0);
    const again = await ensureCitations(env.DB, s.businessId, DIRS, T1);
    expect(first).toHaveLength(12);
    expect(again).toEqual(first);
    expect(first.map((c) => c.directory)).toEqual(DIRS);
    expect(first[0]).toMatchObject({ businessId: s.businessId, status: "todo", url: null, note: "", checkedOn: null, createdAt: T0 });
    expect(await listCitations(env.DB, s.businessId)).toHaveLength(12);
    expect(await listCitations(env.DB, (await seedClient()).businessId)).toEqual([]);
  });

  it("sets the status of a known directory only, leaving url and note alone when not given", async () => {
    const s = await seedClient();
    await ensureCitations(env.DB, s.businessId, DIRS, T0);
    expect(await setCitation(env.DB, s.businessId, "Yelp", { status: "listed", url: "https://yelp.test/ace", note: "claimed" }, "2026-12-02")).toBe(true);
    expect(await setCitation(env.DB, s.businessId, "Yelp", { status: "needs_fix" }, "2026-12-09")).toBe(true);
    expect((await listCitations(env.DB, s.businessId)).find((c) => c.directory === "Yelp")).toMatchObject({ status: "needs_fix", url: "https://yelp.test/ace", note: "claimed", checkedOn: "2026-12-09" });
    expect(await setCitation(env.DB, s.businessId, "Not a directory", { status: "listed" }, "2026-12-02")).toBe(false);
  });
});

describe("activity kinds", () => {
  it("labels the two local SEO kinds", () => {
    expect(describeActivity({ kind: "seo_report_sent", detail: "December 2026 report sent" })).toMatchObject({ title: "Local SEO report sent", detail: "December 2026 report sent" });
    expect(describeActivity({ kind: "seo_baseline", detail: null }).title).toBe("Local SEO baseline taken");
  });
});

describe("seo_reports table", () => {
  it("matches care_reports plus priorities, with one report per business and period", async () => {
    const cols = async (t: string) => (await env.DB.prepare(`SELECT name, type, "notnull", dflt_value, pk FROM pragma_table_info(?) ORDER BY name`).bind(t).all()).results;
    const care = (await cols("care_reports")) as { name: string }[];
    const seo = (await cols("seo_reports")) as { name: string }[];
    expect(seo.filter((c) => c.name !== "priorities")).toEqual(care);
    expect(seo.find((c) => c.name === "priorities")).toMatchObject({ type: "TEXT", notnull: 1, dflt_value: "'[]'" });
    const s = await seedClient();
    const ins = (token: string, period: string) => env.DB.prepare(`INSERT INTO seo_reports (id, business_id, period, status, token, facts, created_at) VALUES (?, ?, ?, 'collecting', ?, '{}', ?)`).bind(crypto.randomUUID(), s.businessId, period, token, T0).run();
    await ins("seo-tok-1", P);
    await expect(ins("seo-tok-2", P)).rejects.toThrow();
    await ins("seo-tok-3", "2027-01");
    expect((await env.DB.prepare(`SELECT priorities FROM seo_reports WHERE token = 'seo-tok-1'`).first<{ priorities: string }>())!.priorities).toBe("[]");
    await expect(env.DB.prepare(`INSERT INTO seo_reports (id, business_id, period, status, token, facts, created_at) VALUES ('x', ?, '2027-02', 'bogus', 'seo-tok-4', '{}', ?)`).bind(s.businessId, T0).run()).rejects.toThrow();
  });
});
