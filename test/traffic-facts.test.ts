import { describe, expect, it } from "vitest";
import { trafficLines } from "../src/worker/traffic/lines";
import {
  TrafficFacts, cleanPath, cleanQuery, mergeTraffic, plainTraffic, shapeSearch, shapeVisits,
} from "../src/worker/traffic/facts";

type Facts = TrafficFacts;
const search = (over: Partial<NonNullable<Facts["search"]>> = {}): NonNullable<Facts["search"]> => ({
  clicks: 10, impressions: 100, position: 5, previousClicks: 8, previousImpressions: 90, queries: [], pages: [], ...over,
});
const visits = (over: Partial<NonNullable<Facts["visits"]>> = {}): NonNullable<Facts["visits"]> => ({
  sessions: 50, users: 40, organic: 20, keyEvents: 3, previousSessions: 45, previousOrganic: 18, channels: [], ...over,
});
const facts = (over: Partial<Facts> = {}): Facts => ({ version: 1, period: "2026-10", search: null, visits: null, profile: null, ...over });

describe("cleanQuery", () => {
  it("cleanQuery drops a query with a link, an email, a $ amount, markdown, a 120-character string and a key shape", () => {
    for (const bad of [
      "visit https://spam.example now", "www.spam.example", "mail me bob@example.com", "win $500 today", "**bold** plumber",
      "[x](y)", "- list item", "# heading", "a".repeat(120), "sk_live_abcdef123456", "password: hunter2", "0123456789abcdef0123456789abcdef", "<script>",
    ]) expect(cleanQuery(bad), bad).toBeNull();
  });
  it('cleanQuery keeps "emergency plumber tigard"', () => {
    expect(cleanQuery("  emergency   plumber\ttigard ")).toBe("emergency plumber tigard");
    expect(cleanQuery("   ")).toBeNull();
  });
});

describe("cleanPath", () => {
  it('cleanPath turns "https://example.com/services/drain?x=1#top" into "/services/drain"', () => {
    expect(cleanPath("https://example.com/services/drain?x=1#top")).toBe("/services/drain");
    expect(cleanPath("https://example.com")).toBe("/");
  });
  it("cleanPath returns null for a data: URL and for a path over 120 characters", () => {
    expect(cleanPath("data:text/html,<b>hi</b>")).toBeNull();
    expect(cleanPath(`https://example.com/${"a".repeat(120)}`)).toBeNull();
    expect(cleanPath("https://example.com/a'b")).toBeNull();
  });
});

describe("shapeSearch and shapeVisits", () => {
  it("shapeSearch rounds position to one decimal and drops queries cleanQuery refuses", () => {
    const s = shapeSearch({
      clicks: 12, impressions: 340, position: 7.349,
      queries: [{ query: "plumber tigard", clicks: 5, impressions: 50 }, { query: "see https://x.example", clicks: 9, impressions: 10 }],
      pages: [{ page: "https://example.com/a?x=1", clicks: 4 }, { page: "https://example.com/a#b", clicks: 2 }, { page: "data:x", clicks: 1 }],
    }, { clicks: 9, impressions: 300 });
    expect(s.position).toBe(7.3);
    expect(s.queries).toEqual([{ query: "plumber tigard", clicks: 5, impressions: 50 }]);
    expect(s.pages).toEqual([{ path: "/a", clicks: 6 }]);
    expect([s.previousClicks, s.previousImpressions]).toEqual([9, 300]);
    expect(TrafficFacts.shape.search.unwrap().safeParse(s).success).toBe(true);
  });
  it("shapeSearch keeps a missing position and a missing previous month as null", () => {
    const s = shapeSearch({ clicks: 0, impressions: 0, position: null, queries: [], pages: [] }, null);
    expect(s).toMatchObject({ clicks: 0, position: null, previousClicks: null, previousImpressions: null });
  });
  it("shapeVisits sums nothing: channels are cut to 6", () => {
    const v = shapeVisits({
      sessions: 100, users: 80, keyEvents: null, organic: 40,
      channels: Array.from({ length: 9 }, (_, i) => ({ channel: `c${i}`, sessions: i })),
      previous: { sessions: 90, organic: 30 },
    });
    expect(v.channels).toHaveLength(6);
    expect(v.channels[0]).toEqual({ channel: "c8", sessions: 8 });
    expect(v).toMatchObject({ sessions: 100, users: 80, organic: 40, keyEvents: null, previousSessions: 90, previousOrganic: 30 });
  });
});

describe("shapeVisits previous figures (I5)", () => {
  const base = { sessions: 100, users: 80, keyEvents: null, organic: 40, channels: [] };
  it("passes a previous month that was never measured through as null, and keeps a measured 0 as 0", () => {
    expect(shapeVisits({ ...base, previous: { sessions: null, organic: null } })).toMatchObject({ previousSessions: null, previousOrganic: null });
    expect(shapeVisits({ ...base, previous: { sessions: 0, organic: 0 } })).toMatchObject({ previousSessions: 0, previousOrganic: 0 });
  });
  it("a null previous shows no comparison in Claude's lines, and a 0 does", () => {
    const line = (previousSessions: number | null) => trafficLines(facts({ visits: visits({ previousSessions, previousOrganic: previousSessions }) }))[1];
    expect(line(null)).not.toContain("last month");
    expect(line(0)).toContain("(last month 0)");
  });
});

describe("mergeTraffic", () => {
  const q = (query: string, clicks: number) => ({ query, clicks, impressions: clicks * 10 });
  it("mergeTraffic of two sites sums clicks, weights position by impressions and keeps the top 5 queries by clicks", () => {
    const a = facts({ search: search({ clicks: 10, impressions: 100, position: 4, queries: [q("a1", 9), q("shared", 3), q("a3", 2), q("a4", 1)] }) });
    const b = facts({ search: search({ clicks: 30, impressions: 300, position: 10, queries: [q("b1", 8), q("shared", 4), q("b3", 6), q("b4", 5)] }) });
    const m = mergeTraffic("2026-10", [a, b])!;
    expect(m.search!.clicks).toBe(40);
    expect(m.search!.impressions).toBe(400);
    expect(m.search!.position).toBe(8.5);
    expect(m.search!.queries.map((x) => x.query)).toEqual(["a1", "b1", "shared", "b3", "b4"]);
    expect(m.search!.queries[2]).toEqual({ query: "shared", clicks: 7, impressions: 70 });
    expect(m.period).toBe("2026-10");
    expect(TrafficFacts.safeParse(m).success).toBe(true);
  });
  it("mergeTraffic previousClicks is null when one site has none", () => {
    const a = facts({ search: search({ previousClicks: 5, previousImpressions: 50 }) });
    const b = facts({ search: search({ previousClicks: null, previousImpressions: 70 }) });
    const m = mergeTraffic("2026-10", [a, b])!;
    expect(m.search!.previousClicks).toBeNull();
    expect(m.search!.previousImpressions).toBe(120);
  });
  it("mergeTraffic ignores a part with no position, and is null when none has one", () => {
    const a = facts({ search: search({ position: null, impressions: 500 }) });
    const b = facts({ search: search({ position: 6, impressions: 100 }) });
    expect(mergeTraffic("2026-10", [a, b])!.search!.position).toBe(6);
    expect(mergeTraffic("2026-10", [a, a])!.search!.position).toBeNull();
  });
  it("mergeTraffic returns null when no part has any block", () => {
    expect(mergeTraffic("2026-10", [facts(), facts()])).toBeNull();
    expect(mergeTraffic("2026-10", [])).toBeNull();
  });
  it("mergeTraffic keeps search null when only visits exist", () => {
    const m = mergeTraffic("2026-10", [facts({ visits: visits({ sessions: 5, channels: [{ channel: "Direct", sessions: 5 }] }) }), facts({ visits: visits({ sessions: 7, channels: [{ channel: "Direct", sessions: 2 }] }) })])!;
    expect(m.search).toBeNull();
    expect(m.profile).toBeNull();
    expect(m.visits).toMatchObject({ sessions: 12, previousSessions: 90, channels: [{ channel: "Direct", sessions: 7 }] });
  });
  it("mergeTraffic keeps a figure null when a part did not measure it", () => {
    const m = mergeTraffic("2026-10", [facts({ visits: visits({ keyEvents: 3 }) }), facts({ visits: visits({ keyEvents: null }) })])!;
    expect(m.visits!.keyEvents).toBeNull();
  });
  it("mergeTraffic sums the profile and clamps to the Count limit", () => {
    const p = (calls: number, previousCalls: number | null) => facts({ profile: { calls, directions: 2, websiteClicks: 3, previousCalls } });
    const m = mergeTraffic("2026-10", [p(900_000, 1), p(900_000, 2)])!;
    expect(m.profile).toMatchObject({ calls: 1_000_000, directions: 4, websiteClicks: 6, previousCalls: 3 });
  });
});

describe("plainTraffic position wording (M6)", () => {
  it("keeps the default words, and says whose position it is when the caller names them (Local SEO has its own rank check)", () => {
    expect(plainTraffic(facts({ search: search({ position: 7.3 }) }))[0]).toContain("at an average position of 7.3.");
    expect(plainTraffic(facts({ search: search({ position: 7.3 }) }), { positionWording: "average position in Google Search" })[0]).toContain("at an average position in Google Search of 7.3.");
    expect(plainTraffic(facts({ search: search({ position: null }) }), { positionWording: "average position in Google Search" })[0]).not.toContain("position");
  });
});

describe("plainTraffic", () => {
  it("plainTraffic says nothing about a null block", () => {
    const only = plainTraffic(facts({ search: search({ queries: [{ query: "plumber tigard", clicks: 1, impressions: 2 }], pages: [{ path: "/secret-page", clicks: 1 }] }) }));
    expect(only).toHaveLength(1);
    expect(only[0]).toContain("counted by Google");
    expect(only.join(" ")).not.toMatch(/visit|session|call|direction|profile|plumber|secret-page/i);
    expect(plainTraffic(facts())).toEqual([]);
  });
  it("plainTraffic gives one sentence per block and never claims leads, sales, money or causes", () => {
    const all = plainTraffic(facts({ search: search(), visits: visits(), profile: { calls: 1, directions: 2, websiteClicks: 3, previousCalls: null } }));
    expect(all).toHaveLength(3);
    for (const s of all) expect(s).toContain("counted by Google");
    expect(all.join(" ")).not.toMatch(/lead|sale|revenue|money|because|caused|due to/i);
  });
});

describe("TrafficFacts", () => {
  it("TrafficFacts rejects a negative count", () => {
    expect(TrafficFacts.safeParse(facts({ search: search({ clicks: -1 }) })).success).toBe(false);
    expect(TrafficFacts.safeParse(facts({ search: search() })).success).toBe(true);
  });
});
