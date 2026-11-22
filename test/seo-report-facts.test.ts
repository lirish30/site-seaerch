import { env } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import {
  addKeyword, ensureCitations, insertContentSlots, setCitation, setKeywordActive, setReviewStatus, upsertProfile, upsertRankCheck, upsertReviews, upsertSnapshot, listReviews,
  type ContentItem, type ContentKind, type ContentStatus, type RankPoint,
} from "../src/worker/db/seo";
import { buildSeoFacts, plainSeoSummary, SeoReportFacts } from "../src/worker/seo/reportFacts";
import { CITATION_DIRECTORIES } from "../src/worker/seo/nap";
import { seedClient } from "./fixtures/clients";

/** Tuesday 1 December 2026, 09:00 in Los Angeles: the day the report of November is made. */
const NOW = new Date("2026-12-01T17:00:00.000Z");
const STAMP = "2026-12-01T17:00:00.000Z";
const PERIOD = "2026-11";

/** A point for each entry: a position, null for "not in the top 20", or "x" for a point that was not checked. */
type Spot = number | null | "x";
const pts = (spots: Spot[]): RankPoint[] => spots.map((s, i) => ({ lat: 45.123456 + i / 1000, lng: -122.654321 - i / 1000, pos: s === "x" ? null : s, ok: s !== "x" }));
/** Nine points of which `top` are at position 2 and the rest at 9. */
const nine = (top: number): number[] => Array.from({ length: 9 }, (_, i) => (i < top ? 2 : 9));

async function client() {
  const s = await seedClient();
  await upsertProfile(env.DB, s.businessId, { napName: "Ace Plumbing", trade: "plumber", status: "active" }, STAMP);
  return s;
}
async function term(businessId: string, t: string, town = "") {
  return (await addKeyword(env.DB, businessId, { term: t, town }, STAMP)).keyword;
}
const check = (businessId: string, keywordId: string, takenOn: string, spots: Spot[]) => upsertRankCheck(env.DB, { businessId, keywordId, takenOn, points: pts(spots), now: STAMP });
const snap = (businessId: string, takenOn: string, reviewCount: number | null, rating: number | null = 4.6) =>
  upsertSnapshot(env.DB, { businessId, takenOn, rating, reviewCount, category: "Plumber", photoCount: 12, hasHours: true, now: STAMP });
/** One term with a usable check on each side of the month's end, so the report has an earlier check to compare with. */
async function withPreviousCheck(businessId: string) {
  const k = await term(businessId, "drain cleaning");
  await check(businessId, k.id, "2026-11-01", nine(5));
  await check(businessId, k.id, "2026-12-01", nine(2));
}
const build = (businessId: string, period = PERIOD, now = NOW) => buildSeoFacts(env, businessId, period, now);

describe("buildSeoFacts: the rank grid", () => {
  it("reads the check after the month end and the one before it, with the points as { pos, ok } only", async () => {
    const s = await client();
    const k = await term(s.businessId, "drain cleaning", "Tigard");
    await check(s.businessId, k.id, "2026-11-01", nine(5));
    await check(s.businessId, k.id, "2026-12-01", nine(2));
    const f = await build(s.businessId);
    expect(f).toMatchObject({ version: 1, period: PERIOD, label: "November 2026", rankAsOf: "2026-12-01", previousRankAsOf: "2026-11-01", generatedAt: STAMP });
    expect(f.terms).toEqual([{
      term: "drain cleaning", town: "Tigard", points: nine(2).map((pos) => ({ pos, ok: true })), measured: 9, visible: 2, previousVisible: 5,
    }]);
    expect(SeoReportFacts.parse(f)).toEqual(f);
  });

  it("takes the first usable check on or after the 1st of next month, not a later one, and the usable check before that as the previous", async () => {
    const s = await client();
    const k = await term(s.businessId, "plumber");
    await check(s.businessId, k.id, "2026-10-20", nine(9));
    await check(s.businessId, k.id, "2026-11-30", nine(4));
    await check(s.businessId, k.id, "2026-12-02", nine(3));
    await check(s.businessId, k.id, "2026-12-09", nine(1));
    const f = await build(s.businessId);
    expect(f).toMatchObject({ rankAsOf: "2026-12-02", previousRankAsOf: "2026-11-30" });
    expect(f.terms[0]).toMatchObject({ visible: 3, previousVisible: 4 });
  });

  it("puts a check taken on the last evening of the month in the month, by the booking-zone date it was stored under", async () => {
    const s = await client();
    const k = await term(s.businessId, "plumber");
    // 23:30 on 2026-11-30 in Los Angeles is 07:30 UTC on the 1st: the stored local date is the 30th, so it is November's, not the one after it.
    await check(s.businessId, k.id, "2026-11-30", nine(6));
    expect((await build(s.businessId)).rankAsOf).toBeNull();
    await check(s.businessId, k.id, "2026-12-01", nine(1));
    expect(await build(s.businessId)).toMatchObject({ rankAsOf: "2026-12-01", previousRankAsOf: "2026-11-30" });
  });

  it("with one check there is nothing to compare: previousVisible and previousRankAsOf are null, and the plain summary says first check without improved, up or down", async () => {
    const s = await client();
    const k = await term(s.businessId, "drain cleaning", "Tigard");
    await check(s.businessId, k.id, "2026-12-01", nine(3));
    const f = await build(s.businessId);
    expect(f).toMatchObject({ rankAsOf: "2026-12-01", previousRankAsOf: null });
    expect(f.terms[0]).toMatchObject({ visible: 3, previousVisible: null });
    const text = plainSeoSummary(f);
    expect(text).toContain("first check, so nothing to compare yet");
    expect(text).not.toMatch(/\b(improved|up|down)\b/i);
  });

  it("a check with 6 measured points is not usable: its visible is null and it is not the as-of check, and a usable one after it is", async () => {
    const s = await client();
    const k = await term(s.businessId, "plumber");
    await check(s.businessId, k.id, "2026-12-01", [1, 2, 3, 1, 2, 3, "x", "x", "x"]);
    const weak = await build(s.businessId);
    expect(weak.rankAsOf).toBeNull();
    expect(weak.terms[0]).toMatchObject({ measured: 6, visible: null, previousVisible: null });
    expect(weak.terms[0].points).toHaveLength(9);
    await check(s.businessId, k.id, "2026-12-03", [1, 2, 3, 1, 2, 3, 1, "x", "x"]);
    const better = await build(s.businessId);
    expect(better.rankAsOf).toBe("2026-12-03");
    expect(better.terms[0]).toMatchObject({ measured: 7, visible: 7 });
  });

  it("a point that errored is ok false and is counted out of measured, and not found is ok true with pos null", async () => {
    const s = await client();
    const k = await term(s.businessId, "plumber");
    await check(s.businessId, k.id, "2026-12-01", [1, 2, null, 3, null, "x", 12, 3, 4]);
    const t = (await build(s.businessId)).terms[0];
    expect(t.measured).toBe(8);
    expect(t.points[5]).toEqual({ pos: null, ok: false });
    expect(t.points[2]).toEqual({ pos: null, ok: true });
    expect(t.visible).toBe(4);
  });

  it("counts position 3 as visible and 4 as not, and never counts an unmeasured point", async () => {
    const s = await client();
    const k = await term(s.businessId, "plumber");
    await check(s.businessId, k.id, "2026-12-01", [1, 3, 4, 20, null, null, 2, 2, "x"]);
    expect((await build(s.businessId)).terms[0]).toMatchObject({ measured: 8, visible: 4 });
  });

  it("treats a stored point it cannot read as not checked, never as not found", async () => {
    const s = await client();
    const k = await term(s.businessId, "plumber");
    const bad = [...pts(nine(2)).slice(0, 7), { lat: 1, lng: 1, pos: 0, ok: true }, { lat: 1, lng: 1, pos: "3", ok: true }] as unknown as RankPoint[];
    await upsertRankCheck(env.DB, { businessId: s.businessId, keywordId: k.id, takenOn: "2026-12-01", points: bad, now: STAMP });
    const t = (await build(s.businessId)).terms[0];
    expect(t.points.slice(7)).toEqual([{ pos: null, ok: false }, { pos: null, ok: false }]);
    expect(t).toMatchObject({ measured: 7, visible: 2 });
  });

  it("lists the active terms only, a term with no check as nine points not checked, and a term without a town as town null", async () => {
    const s = await client();
    const a = await term(s.businessId, "plumber");
    const b = await term(s.businessId, "water heater", "Camas");
    const off = await term(s.businessId, "old term");
    await check(s.businessId, a.id, "2026-12-01", nine(4));
    await setKeywordActive(env.DB, off.id, false);
    const f = await build(s.businessId);
    expect(f.terms.map((t) => t.term)).toEqual(["plumber", "water heater"]);
    expect(f.terms[0].town).toBeNull();
    expect(f.terms[1]).toEqual({ term: "water heater", town: "Camas", points: Array.from({ length: 9 }, () => ({ pos: null, ok: false })), measured: 0, visible: null, previousVisible: null });
    expect(b.id).not.toBe(a.id);
  });

  it("reads each term on its own, and a term with a previous check only compares with that", async () => {
    const s = await client();
    const a = await term(s.businessId, "plumber");
    const b = await term(s.businessId, "drains");
    await check(s.businessId, a.id, "2026-11-01", nine(1));
    await check(s.businessId, a.id, "2026-12-01", nine(4));
    await check(s.businessId, b.id, "2026-12-01", nine(7));
    const f = await build(s.businessId);
    expect(f.terms.map((t) => [t.visible, t.previousVisible])).toEqual([[4, 1], [7, null]]);
    expect(f).toMatchObject({ rankAsOf: "2026-12-01", previousRankAsOf: "2026-11-01" });
  });

  it("skips an earlier check that is not usable when it looks for the previous one", async () => {
    const s = await client();
    const k = await term(s.businessId, "plumber");
    await check(s.businessId, k.id, "2026-10-15", nine(5));
    await check(s.businessId, k.id, "2026-11-15", [1, 1, "x", "x", "x", "x", "x", "x", "x"]);
    await check(s.businessId, k.id, "2026-12-01", nine(2));
    expect(await build(s.businessId)).toMatchObject({ previousRankAsOf: "2026-10-15" });
  });

  it("does not read another client's checks, and a December report rolls over to January", async () => {
    const s = await client();
    const other = await client();
    const k = await term(s.businessId, "plumber");
    const o = await term(other.businessId, "plumber");
    await check(other.businessId, o.id, "2027-01-02", nine(9));
    await check(s.businessId, k.id, "2026-12-15", nine(3));
    await check(s.businessId, k.id, "2027-01-02", nine(5));
    const f = await build(s.businessId, "2026-12", new Date("2027-01-02T20:00:00.000Z"));
    expect(f).toMatchObject({ period: "2026-12", label: "December 2026", rankAsOf: "2027-01-02", previousRankAsOf: "2026-12-15" });
    expect(f.terms[0]).toMatchObject({ visible: 5, previousVisible: 3 });
  });

  it("has no as-of date and no terms with a check when nothing was measured", async () => {
    const s = await client();
    await term(s.businessId, "plumber");
    const f = await build(s.businessId);
    expect(f).toMatchObject({ rankAsOf: null, previousRankAsOf: null });
    expect(f.terms[0]).toMatchObject({ measured: 0, visible: null });
    expect(plainSeoSummary(f)).toMatch(/no rank check/i);
  });
});

describe("buildSeoFacts: the Google profile", () => {
  it("gives the review count and rating, and the rise between the two snapshots", async () => {
    const s = await client();
    await withPreviousCheck(s.businessId);
    await snap(s.businessId, "2026-11-01", 40, 4.5);
    await snap(s.businessId, "2026-12-01", 43, 4.7);
    expect((await build(s.businessId)).gbp).toEqual({ rating: 4.7, reviewCount: 43, reviewsGained: 3, ratingChange: 0.2 });
  });

  it("claims no gain in a first report (no earlier rank check), even when an earlier snapshot makes one possible", async () => {
    const s = await client();
    const k = await term(s.businessId, "drain cleaning");
    await check(s.businessId, k.id, "2026-12-01", nine(2)); // the first check there is
    await snap(s.businessId, "2026-11-01", 40, 4.5);
    await snap(s.businessId, "2026-12-01", 43, 4.7);
    const f = await build(s.businessId);
    expect(f.previousRankAsOf).toBeNull();
    expect(f.gbp).toEqual({ rating: 4.7, reviewCount: 43, reviewsGained: null, ratingChange: 0.2 });
    const text = plainSeoSummary(f);
    expect(text).toContain("first check, so nothing to compare yet");
    expect(text).not.toMatch(/gained|since the previous check/);
  });

  it("gives null for the rise when the count fell, and when there is no earlier snapshot", async () => {
    const fell = await client();
    await withPreviousCheck(fell.businessId);
    await snap(fell.businessId, "2026-11-01", 43);
    await snap(fell.businessId, "2026-12-01", 41);
    expect((await build(fell.businessId)).gbp).toMatchObject({ reviewCount: 41, reviewsGained: null });
    const first = await client();
    await snap(first.businessId, "2026-12-01", 43, 4.2);
    expect((await build(first.businessId)).gbp).toEqual({ rating: 4.2, reviewCount: 43, reviewsGained: null, ratingChange: null });
    const same = await client();
    await withPreviousCheck(same.businessId);
    await snap(same.businessId, "2026-11-01", 43);
    await snap(same.businessId, "2026-12-01", 43);
    expect((await build(same.businessId)).gbp.reviewsGained).toBe(0);
  });

  it("uses the last snapshot of the month when none was taken after it, and says nothing when there is none at all or a count is missing", async () => {
    const s = await client();
    await withPreviousCheck(s.businessId);
    await snap(s.businessId, "2026-11-02", 40);
    await snap(s.businessId, "2026-11-30", 43);
    expect((await build(s.businessId)).gbp).toMatchObject({ reviewCount: 43, reviewsGained: 3 });
    const none = await client();
    expect((await build(none.businessId)).gbp).toEqual({ rating: null, reviewCount: null, reviewsGained: null, ratingChange: null });
    const missing = await client();
    await snap(missing.businessId, "2026-11-01", 40, null);
    await snap(missing.businessId, "2026-12-01", null, null);
    expect((await build(missing.businessId)).gbp).toEqual({ rating: null, reviewCount: null, reviewsGained: null, ratingChange: null });
  });
});

describe("buildSeoFacts: reviews, content, citations and the name check", () => {
  it("counts the month's reviews, the replies posted and the low ones still waiting, and reads no text", async () => {
    const s = await client();
    await upsertReviews(env.DB, s.businessId, [
      { externalId: "r1", rating: 5, author: "Zed Reviewer", body: "SECRET-REVIEW-BODY lovely work", publishedAt: null },
      { externalId: "r2", rating: 2, author: "Quinn Unhappy", body: "SECRET-LOW-BODY the drain still leaks", publishedAt: null },
      { externalId: "r3", rating: 1, author: "Robin Angry", body: "SECRET-ONE-STAR", publishedAt: null },
      { externalId: "r4", rating: 4, author: "Sam Fine", body: "SECRET-OLD", publishedAt: null },
    ], { takenOn: "2026-11-10", now: STAMP });
    const all = await listReviews(env.DB, s.businessId);
    const byExt = (id: string) => all.find((r) => r.externalId === id)!;
    await setReviewStatus(env.DB, byExt("r1").id, ["new"], "posted");
    await setReviewStatus(env.DB, byExt("r3").id, ["new"], "skipped");
    await env.DB.prepare(`UPDATE seo_reviews SET first_seen_on = '2026-10-31' WHERE id = ?`).bind(byExt("r4").id).run();
    await upsertReviews(env.DB, s.businessId, [{ externalId: "r5", rating: 5, author: "Late One", body: "SECRET-DECEMBER", publishedAt: null }], { takenOn: "2026-12-01", now: STAMP });
    expect((await build(s.businessId)).reviews).toEqual({ seen: 3, posted: 1, needsYou: 1 });
  });

  it("lists the month's published titles and counts what is written and what is still to write", async () => {
    const s = await client();
    const rows = (statuses: [ContentKind, ContentStatus, string][], period = PERIOD) => insertContentSlots(env.DB, statuses.map(([kind, status, title], i): Omit<ContentItem, "id" | "updatedAt"> => ({
      businessId: s.businessId, period, kind, slot: i + 1, keywordId: null, brief: "SECRET-BRIEF", title, metaTitle: "", metaDescription: "", body: "SECRET-BODY", status, claudeTaskId: null, url: null,
    })), STAMP);
    const made = await rows([["page", "published", "Drain cleaning in Tigard"], ["post", "published", "Why a drain slows down"], ["gbp_post", "drafted", ""], ["page", "approved", "Water heaters"], ["post", "planned", ""], ["post", "drafting", ""], ["page", "rejected", "Nope"]]);
    for (const [i, status] of (["published", "published", "drafted", "approved", "planned", "drafting", "rejected"] as ContentStatus[]).entries()) {
      await env.DB.prepare(`UPDATE seo_content SET status = ? WHERE id = ?`).bind(status, made[i].id).run();
    }
    await rows([["page", "published", "Next month's page"]], "2026-12");
    expect((await build(s.businessId)).content).toEqual({
      published: [{ kind: "page", title: "Drain cleaning in Tigard" }, { kind: "post", title: "Why a drain slows down" }], drafted: 2, planned: 2,
    });
    expect(JSON.stringify(await build(s.businessId))).not.toContain("SECRET");
  });

  it("counts the citation list, and is null for a client with none", async () => {
    const s = await client();
    expect((await build(s.businessId)).citations).toBeNull();
    await ensureCitations(env.DB, s.businessId, CITATION_DIRECTORIES, STAMP);
    await setCitation(env.DB, s.businessId, CITATION_DIRECTORIES[0], { status: "listed" }, "2026-11-20");
    await setCitation(env.DB, s.businessId, CITATION_DIRECTORIES[1], { status: "listed" }, "2026-11-20");
    await setCitation(env.DB, s.businessId, CITATION_DIRECTORIES[2], { status: "needs_fix" }, "2026-11-20");
    await setCitation(env.DB, s.businessId, CITATION_DIRECTORIES[3], { status: "not_applicable" }, "2026-11-20");
    expect((await build(s.businessId)).citations).toEqual({ listed: 2, needsFix: 1, todo: CITATION_DIRECTORIES.length - 4 });
  });

  it("gives the name, address and phone check of the profile, and null when there is none or it cannot be read", async () => {
    const s = await client();
    expect((await build(s.businessId)).nap).toBeNull();
    await upsertProfile(env.DB, s.businessId, { napResult: JSON.stringify({ phone: "match", address: "mismatch", name: "missing", checkedPages: 4 }) }, STAMP);
    expect((await build(s.businessId)).nap).toEqual({ phone: "match", address: "mismatch", name: "missing" });
    await upsertProfile(env.DB, s.businessId, { napResult: "not a result" }, STAMP);
    expect((await build(s.businessId)).nap).toBeNull();
    const noProfile = await seedClient();
    expect((await build(noProfile.businessId)).nap).toBeNull();
  });

  it("names the client from its record and leaves no review text, reviewer name, place id, token, site text or grid location in what it builds", async () => {
    const s = await client();
    await upsertProfile(env.DB, s.businessId, { placeId: "ChIJ-SECRET-PLACE", mapsUrl: "https://maps.example/SECRET-MAPS", napAddress: "12 SECRET Street", napPhone: "555-0199-SECRET", lat: 45.123456, lng: -122.654321 }, STAMP);
    await env.DB.prepare(`UPDATE businesses SET name = 'Ace Plumbing' WHERE id = ?`).bind(s.businessId).run();
    const k = await term(s.businessId, "plumber", "Camas");
    await check(s.businessId, k.id, "2026-11-01", nine(2));
    await check(s.businessId, k.id, "2026-12-01", nine(3));
    await snap(s.businessId, "2026-11-01", 40);
    await snap(s.businessId, "2026-12-01", 43);
    await upsertReviews(env.DB, s.businessId, [{ externalId: "EXT-SECRET-ID", rating: 2, author: "Zed Reviewer", body: "SECRET-REVIEW-BODY the drain still leaks", publishedAt: "2026-11-05T00:00:00Z" }], { takenOn: "2026-11-05", now: STAMP });
    const f = await build(s.businessId);
    expect(f.clientName).toBe("Ace Plumbing");
    const json = JSON.stringify(f);
    for (const secret of ["SECRET", "Zed", "Reviewer", "ChIJ", "maps.example", "EXT-", "45.123456", "122.654321", "lat", "lng", "token"]) expect(json, secret).not.toContain(secret);
    expect(SeoReportFacts.safeParse(f).success).toBe(true);
  });
});

describe("plainSeoSummary", () => {
  const base = (over: Partial<SeoReportFacts> = {}): SeoReportFacts => ({
    version: 1, period: "2026-11", label: "November 2026", clientName: "Ace Plumbing", rankAsOf: "2026-12-01", previousRankAsOf: "2026-11-01",
    terms: [
      { term: "drain cleaning", town: "Tigard", points: nine(2).map((pos) => ({ pos, ok: true })), measured: 9, visible: 2, previousVisible: 5 },
      { term: "water heater", town: null, points: nine(4).map((pos) => ({ pos, ok: true })), measured: 9, visible: 4, previousVisible: 1 },
    ],
    gbp: { rating: 4.7, reviewCount: 43, reviewsGained: 3, ratingChange: 0.2 }, reviews: { seen: 3, posted: 2, needsYou: 1 },
    content: { published: [{ kind: "page", title: "Drain cleaning in Tigard" }], drafted: 1, planned: 0 }, citations: { listed: 6, needsFix: 2, todo: 4 },
    nap: { phone: "match", address: "mismatch", name: "match" }, generatedAt: STAMP, ...over,
  });
  type SeoReportFacts = import("../src/worker/seo/reportFacts").SeoReportFacts;
  const words = /\b(improved|up|down)\b/i;

  it("with a previous check states both counts, and is short, plain and promise-free", () => {
    const text = plainSeoSummary(base());
    expect(text).toContain("November 2026");
    expect(text).not.toContain("first check");
    expect(text).toMatch(/6 of 18 checked points/);
    expect(text).toMatch(/compares with 6 points at the previous check/);
    expect(text.length).toBeLessThanOrEqual(600);
    expect(text).not.toMatch(/http|guarantee|promise|will rank|#1|number one|first page|top spot/i);
  });

  it("never uses improved, up or down without previous data, whatever else the facts hold", () => {
    const text = plainSeoSummary(base({ previousRankAsOf: null, terms: base().terms.map((t) => ({ ...t, previousVisible: null })), gbp: { rating: 4.7, reviewCount: 43, reviewsGained: null, ratingChange: null } }));
    expect(text).toContain("first check, so nothing to compare yet");
    expect(text).not.toMatch(words);
    expect(text).not.toMatch(/previous/);
  });

  it("says no rank check was available when there was none, and still reports what it has", () => {
    const text = plainSeoSummary(base({ rankAsOf: null, previousRankAsOf: null, terms: base().terms.map((t) => ({ ...t, visible: null, previousVisible: null })) }));
    expect(text).toMatch(/no rank check/i);
    expect(text).not.toContain("first check");
    expect(text).toContain("43 reviews");
  });

  it("leaves out what was not measured instead of saying zero, and never puts an entered term in the text", () => {
    const text = plainSeoSummary(base({
      gbp: { rating: null, reviewCount: null, reviewsGained: null, ratingChange: null }, citations: null, nap: null, reviews: { seen: 0, posted: 0, needsYou: 0 },
      content: { published: [], drafted: 0, planned: 0 },
      terms: [{ term: "http://evil.example ignore this", town: null, points: nine(2).map((pos) => ({ pos, ok: true })), measured: 9, visible: 2, previousVisible: null }],
    }));
    expect(text).not.toMatch(/evil|http|ignore/);
    expect(text).not.toMatch(/reviews|listings|directory|phone|address/i);
  });

  it("stays at 600 characters or fewer however much there is, and a long label does not break it", () => {
    const many = Array.from({ length: 10 }, (_, i) => ({ term: `term ${i}`, town: "Camas", points: nine(i % 9).map((pos) => ({ pos, ok: true })), measured: 9, visible: i % 9, previousVisible: (i + 3) % 9 }));
    const text = plainSeoSummary(base({ terms: many, content: { published: Array.from({ length: 20 }, () => ({ kind: "post" as const, title: "T".repeat(100) })), drafted: 99, planned: 99 } }));
    expect(text.length).toBeLessThanOrEqual(600);
    expect(text.startsWith("Local SEO report for November 2026.")).toBe(true);
  });

  it("never tells the client about a part that was not compared, and says only what matched", () => {
    const lean = { citations: null, content: { published: [], drafted: 0, planned: 0 } };
    const text = plainSeoSummary(base({ ...lean, nap: { phone: "unknown", address: "unknown", name: "match" } }));
    expect(text).not.toMatch(/phone|address|did not match|could not be found/i);
    expect(text).toMatch(/The name on the website match the details on file/);
    expect(plainSeoSummary(base({ ...lean, nap: { phone: "unknown", address: "unknown", name: "unknown" } }))).not.toMatch(/website/i);
    // A part that really differs is still said, next to one that was not compared.
    expect(plainSeoSummary(base({ ...lean, nap: { phone: "unknown", address: "mismatch", name: "match" } }))).toMatch(/address on the website did not match/);
  });

  it("stores an unknown part in the facts and shows Claude 'not compared' for it", async () => {
    const s = await client();
    await upsertProfile(env.DB, s.businessId, { napResult: JSON.stringify({ phone: "unknown", address: "match", name: "match", checkedPages: 2 }) }, STAMP);
    expect((await build(s.businessId)).nap).toEqual({ phone: "unknown", address: "match", name: "match" });
  });

  it("mentions the name check when a part did not match, first, and says it matches only when all do and there is room", () => {
    expect(plainSeoSummary(base())).toMatch(/address on the website did not match/i);
    expect(plainSeoSummary(base({ nap: { phone: "missing", address: "match", name: "mismatch" } }))).toMatch(/name on the website did not match.*phone could not be found/);
    const lean = { citations: null, content: { published: [], drafted: 0, planned: 0 } };
    const clean = plainSeoSummary(base({ ...lean, nap: { phone: "match", address: "match", name: "match" } }));
    expect(clean).toMatch(/match the details on file/);
    expect(clean).not.toMatch(/did not match|could not be found/);
    // The last sentence to go when the 600 characters run out is the clean result.
    expect(plainSeoSummary(base({ nap: { phone: "match", address: "match", name: "match" } }))).not.toMatch(/did not match|could not be found/);
  });
});
