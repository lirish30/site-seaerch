import { env } from "cloudflare:test";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { trafficView } from "../src/client/trafficView";
import { plainSummary, ReportFacts } from "../src/worker/care/reportFacts";
import { saveGoogleAuth } from "../src/worker/db/google";
import { saveSettings } from "../src/worker/db/settings";
import { createSite } from "../src/worker/db/sites";
import { getLink, getTrafficMonth, saveLink, saveTrafficMonth } from "../src/worker/db/traffic";
import type { Env } from "../src/worker/env";
import { gbpMonth } from "../src/worker/google/businessProfile";
import { GoogleApiError } from "../src/worker/google/api";
import { encryptSecret } from "../src/worker/google/crypto";
import { PROFILE_SCOPE, SCOPES, authUrl, hasProfileScope } from "../src/worker/google/oauth";
import { googleRoutes } from "../src/worker/routes/google";
import { instructionsFor as careInstructions } from "../src/worker/queue/careReport";
import { instructionsFor as seoInstructions } from "../src/worker/queue/seoReport";
import { plainSeoSummary, SeoReportFacts } from "../src/worker/seo/reportFacts";
import { TrafficFacts, hasTrafficData, plainTraffic, shapeProfile } from "../src/worker/traffic/facts";
import { trafficLines } from "../src/worker/traffic/lines";
import { LinkRefused, linkSite } from "../src/worker/traffic/link";
import { trafficProblem } from "../src/worker/traffic/problem";
import { hasLinkedSource, pullMonth, sweepTraffic, trafficWait } from "../src/worker/traffic/pull";
import { publicTraffic } from "../src/worker/traffic/public";
import { seedClient } from "./fixtures/clients";
import { E } from "./fixtures/close";

const e = { ...E, GOOGLE_CLIENT_ID: "cid", GOOGLE_CLIENT_SECRET: "sec" } as Env;
const TRAFFIC = "https://www.googleapis.com/auth/webmasters.readonly https://www.googleapis.com/auth/analytics.readonly";
const SCOPE = `openid email ${TRAFFIC}`;
const SCOPE_WITH_PROFILE = `${SCOPE} ${PROFILE_SCOPE}`;
const LOCATION = "locations/1234567890";
const NOW = new Date("2026-12-04T18:00:00.000Z");
const PERIOD = "2026-11";
const OCT = { start: "2026-10-01", end: "2026-10-31" };
const SEP = { start: "2026-09-01", end: "2026-09-30" };
const SENTENCE = "Google has not given this account Business Profile API access yet, or this location is not one it manages.";
const RECONNECT = "Reconnect Google with the Business Profile permission.";

interface Call { url: string; headers: Record<string, string> }
/** A fake Business Profile Performance API: each requested metric answers a few days, a day with no value among them. */
function gbpFake(o: { status?: number; days?: Record<string, (string | null)[]>; only?: string[] } = {}) {
  const calls: Call[] = [];
  const f = async (url: string, init?: RequestInit) => {
    calls.push({ url, headers: (init?.headers ?? {}) as Record<string, string> });
    if (o.status) return Response.json({ error: { message: "SECRET-BODY locations/9" } }, { status: o.status });
    const q = new URL(url).searchParams;
    const month = Number(q.get("dailyRange.start_date.month"));
    const metrics = q.getAll("dailyMetrics").filter((m) => !o.only || o.only.includes(m));
    const values = o.days ?? { CALL_CLICKS: ["3", "4", null], BUSINESS_DIRECTION_REQUESTS: ["2", "5"], WEBSITE_CLICKS: ["7"] };
    return Response.json({
      multiDailyMetricTimeSeries: [{
        dailyMetricTimeSeries: metrics.map((dailyMetric) => ({
          dailyMetric,
          timeSeries: { datedValues: (values[dailyMetric] ?? []).map((v, i) => ({ date: { year: 2026, month, day: i + 1 }, ...(v === null ? {} : { value: v }) })) },
        })),
      }],
    });
  };
  return { f, calls };
}

describe("gbpMonth", () => {
  it("gbpMonth asks for the three metrics with the month's start and end dates and sums the daily values", async () => {
    const g = gbpFake();
    const r = await gbpMonth(g.f, "tok", LOCATION, OCT, SEP);
    expect(r).toEqual({ calls: 7, directions: 7, websiteClicks: 7, previousCalls: 7 });
    const first = new URL(g.calls[0].url);
    expect(`${first.origin}${first.pathname}`).toBe("https://businessprofileperformance.googleapis.com/v1/locations/1234567890:fetchMultiDailyMetricsTimeSeries");
    expect(first.searchParams.getAll("dailyMetrics")).toEqual(["CALL_CLICKS", "BUSINESS_DIRECTION_REQUESTS", "WEBSITE_CLICKS"]);
    const dates = (q: URLSearchParams, which: "start" | "end") => ["year", "month", "day"].map((k) => q.get(`dailyRange.${which}_date.${k}`));
    expect(dates(first.searchParams, "start")).toEqual(["2026", "10", "1"]);
    expect(dates(first.searchParams, "end")).toEqual(["2026", "10", "31"]);
    expect(g.calls[0].headers.authorization).toBe("Bearer tok");
    // The month before is read for the call comparison alone.
    const second = new URL(g.calls[1].url);
    expect(second.searchParams.getAll("dailyMetrics")).toEqual(["CALL_CLICKS"]);
    expect(dates(second.searchParams, "start")).toEqual(["2026", "9", "1"]);
    expect(dates(second.searchParams, "end")).toEqual(["2026", "9", "30"]);
    expect(g.calls).toHaveLength(2);
  });

  it("gbpMonth counts a month with no daily values as a real zero, and the month before as not known when Google sent no call series for it", async () => {
    const empty = await gbpMonth(gbpFake({ days: {} }).f, "tok", LOCATION, OCT, SEP);
    expect(empty).toEqual({ calls: 0, directions: 0, websiteClicks: 0, previousCalls: 0 });
    const none = await gbpMonth(async () => Response.json({}), "tok", LOCATION, OCT, SEP);
    expect(none).toEqual({ calls: 0, directions: 0, websiteClicks: 0, previousCalls: null });
  });

  it("gbpMonth 403 maps to a sentence naming Business Profile API access", async () => {
    const g = gbpFake({ status: 403 });
    const err = await gbpMonth(g.f, "tok", LOCATION, OCT, SEP).catch((x) => x);
    expect(err).toBeInstanceOf(GoogleApiError);
    expect((err as GoogleApiError).status).toBe(403);
    const said = trafficProblem(err, { email: "me@x.test", which: "profile" });
    expect(said).toBe(SENTENCE);
    expect(said).not.toMatch(/SECRET-BODY|locations|me@x\.test/);
    // The other two sources still say what they said.
    expect(trafficProblem(err, { email: "me@x.test" })).toMatch(/can't read this one/);
    expect(trafficProblem(new GoogleApiError(404, "x"), { email: null, which: "profile" })).toMatch(/Business Profile request \(404\).*location id/);
    expect(trafficProblem(new GoogleApiError(401, "x"), { email: null, which: "profile" })).toMatch(/Reconnect Google in Settings/);
  });
});

describe("the Business Profile permission", () => {
  const client = { clientId: "cid", clientSecret: "x", redirectUri: "https://app/api/google/callback" };

  it("authUrl without profile does not include business.manage, with profile does", () => {
    const plain = new URL(authUrl(client, "st")).searchParams.get("scope")!;
    expect(plain).toBe(SCOPES.join(" "));
    expect(plain).not.toContain("business.manage");
    expect(new URL(authUrl(client, "st", {})).searchParams.get("scope")).toBe(plain);
    expect(new URL(authUrl(client, "st", { profile: false })).searchParams.get("scope")).toBe(plain);
    const asked = new URL(authUrl(client, "st", { profile: true })).searchParams.get("scope")!.split(" ");
    expect(asked).toEqual([...SCOPES, "https://www.googleapis.com/auth/business.manage"]);
    expect(PROFILE_SCOPE).toBe("https://www.googleapis.com/auth/business.manage");
    expect(SCOPES).not.toContain(PROFILE_SCOPE);
  });

  it("hasProfileScope is true only when business.manage was granted", () => {
    expect(hasProfileScope(SCOPE_WITH_PROFILE)).toBe(true);
    expect(hasProfileScope(SCOPE)).toBe(false);
    expect(hasProfileScope(null)).toBe(false);
    expect(hasProfileScope(undefined)).toBe(false);
  });

  it("GET /api/google/connect?profile=1 asks for it and the plain connect does not; status says whether it was granted", async () => {
    const scopeOf = async (path: string) => new URL((await googleRoutes.request(path, {}, e)).headers.get("location")!).searchParams.get("scope")!;
    expect(await scopeOf("/connect")).toBe(SCOPES.join(" "));
    expect(await scopeOf("/connect?profile=1")).toBe(`${SCOPES.join(" ")} ${PROFILE_SCOPE}`);
    await env.DB.prepare(`DELETE FROM google_auth`).run();
    await saveGoogleAuth(env.DB, "me@x.test", "sealed", SCOPE);
    expect(await (await googleRoutes.request("/status", {}, e)).json()).toMatchObject({ traffic: true, profile: false });
    await saveGoogleAuth(env.DB, "me@x.test", "sealed", SCOPE_WITH_PROFILE);
    expect(await (await googleRoutes.request("/status", {}, e)).json()).toMatchObject({ traffic: true, profile: true });
    await env.DB.prepare(`DELETE FROM google_auth`).run();
    expect(await (await googleRoutes.request("/status", {}, e)).json()).toMatchObject({ connected: false, profile: false });
  });
});

describe("reconnecting keeps a Business Profile permission already granted (M7)", () => {
  const scopeOf = async (path: string) => new URL((await googleRoutes.request(path, {}, e)).headers.get("location")!).searchParams.get("scope")!;
  it("the plain connect asks for business.manage when the stored connection has it, and not when it does not", async () => {
    await env.DB.prepare(`DELETE FROM google_auth`).run();
    await saveGoogleAuth(env.DB, "me@x.test", "sealed", SCOPE);
    expect(await scopeOf("/connect")).not.toContain("business.manage");
    await saveGoogleAuth(env.DB, "me@x.test", "sealed", SCOPE_WITH_PROFILE);
    expect(await scopeOf("/connect")).toBe(`${SCOPES.join(" ")} ${PROFILE_SCOPE}`);
    await env.DB.prepare(`DELETE FROM google_auth`).run();
  });
});

async function connect(scope: string) {
  await env.DB.prepare(`DELETE FROM google_auth`).run();
  await saveGoogleAuth(env.DB, "me@x.test", await encryptSecret(env.SESSION_SECRET, "refresh-1"), scope);
}

let n = 0;
/** A real client's site on a fresh domain. */
async function siteOn() {
  const domain = `ace${++n}.test`;
  const { businessId } = await seedClient({ site: false });
  const { site } = await createSite(env.DB, { businessId, url: `https://${domain}`, domain });
  return { siteId: site.id, businessId, domain };
}

describe("linkSite with a Business Profile location", () => {
  beforeEach(async () => { await env.DB.prepare(`DELETE FROM site_analytics`).run(); });

  it('linkSite accepts "locations/123456" and refuses "123456", a URL and a place id', async () => {
    await connect(SCOPE_WITH_PROFILE);
    const s = await siteOn();
    expect((await linkSite(e, s.siteId, { gbpLocation: "locations/123456" }, NOW)).gbpLocation).toBe("locations/123456");
    for (const bad of ["123456", "https://business.google.com/locations/123456", "ChIJN1t_tDeuEmsRUsoyG83frY4", "locations/1234", "locations/12a456", "locations/123456/reviews", " locations/123456", ""]) {
      await expect(linkSite(e, s.siteId, { gbpLocation: bad }, NOW)).rejects.toThrow(LinkRefused);
    }
    expect((await getLink(env.DB, s.siteId))!.gbpLocation).toBe("locations/123456");
  });

  it("refuses to link a location when the connection lacks the Business Profile permission, and touches nothing", async () => {
    await connect(SCOPE);
    const s = await siteOn();
    await expect(linkSite(e, s.siteId, { gbpLocation: LOCATION }, NOW)).rejects.toThrow(RECONNECT);
    expect(await getLink(env.DB, s.siteId)).toBeNull();
    await env.DB.prepare(`DELETE FROM google_auth`).run();
    await expect(linkSite(e, s.siteId, { gbpLocation: LOCATION }, NOW)).rejects.toThrow(RECONNECT);
  });

  it("null clears only the location and leaves Search Console alone, and a location needs no domain", async () => {
    await connect(SCOPE_WITH_PROFILE);
    const s = await siteOn();
    await saveLink(env.DB, s.siteId, { gscProperty: `sc-domain:${s.domain}` }, NOW.toISOString());
    await linkSite(e, s.siteId, { gbpLocation: LOCATION }, NOW);
    expect(await getLink(env.DB, s.siteId)).toMatchObject({ gscProperty: `sc-domain:${s.domain}`, gbpLocation: LOCATION });
    // Clearing needs no permission.
    await connect(SCOPE);
    expect(await linkSite(e, s.siteId, { gbpLocation: null }, NOW)).toMatchObject({ gscProperty: `sc-domain:${s.domain}`, gbpLocation: null });

    await connect(SCOPE_WITH_PROFILE);
    const bare = await createSite(env.DB, { businessId: s.businessId, url: null, domain: null });
    expect((await linkSite(e, bare.site.id, { gbpLocation: LOCATION }, NOW)).gbpLocation).toBe(LOCATION);
  });
});

// ---- the pull ----

const GBP_URL = "https://businessprofileperformance.googleapis.com/";
interface Plan { gbpStatus?: number; gscStatus?: number }
/** A fake Google for a pull: the token endpoint, Search Console (a fixed month) and the Business Profile Performance API. */
function pullGoogle(plan: Plan = {}) {
  const calls: string[] = [];
  const gbp = gbpFake(plan.gbpStatus ? { status: plan.gbpStatus } : {});
  const f = async (url: string, init?: RequestInit) => {
    calls.push(url);
    if (url === "https://oauth2.googleapis.com/token") return Response.json({ access_token: "tok", expires_in: 3600 });
    if (url.startsWith(GBP_URL)) return gbp.f(url, init);
    if (url.includes("/searchAnalytics/query")) {
      if (plan.gscStatus) return Response.json({ error: { message: "nope" } }, { status: plan.gscStatus });
      const body = JSON.parse(String(init?.body));
      if (body.dimensions?.[0] === "query") return Response.json({ rows: [{ keys: ["ace plumbing"], clicks: 12, impressions: 300 }] });
      if (body.dimensions?.[0] === "page") return Response.json({ rows: [{ keys: ["https://ace.test/drains"], clicks: 9 }] });
      return Response.json({ rows: [{ clicks: body.startDate === "2026-11-01" ? 40 : 30, impressions: 900, position: 7.3 }] });
    }
    return Response.json({}, { status: 404 });
  };
  return { f, profileCalls: () => calls.filter((u) => u.startsWith(GBP_URL)).length, reads: () => calls.filter((u) => u !== "https://oauth2.googleapis.com/token").length };
}

/** A real client's site linked to `gsc` and/or `gbp`. */
async function linked(o: { gsc?: boolean; gbp?: string | null } = {}) {
  const s = await siteOn();
  await saveLink(env.DB, s.siteId, { gscProperty: o.gsc === false ? null : `sc-domain:${s.domain}`, gbpLocation: o.gbp === undefined ? LOCATION : o.gbp }, NOW.toISOString());
  return s;
}

describe("the pull reads Business Profile as a third source", () => {
  beforeEach(async () => {
    for (const t of ["traffic_months", "site_analytics"]) await env.DB.prepare(`DELETE FROM ${t}`).run();
    await saveSettings(env.DB, { booking_config: "{}" });
    await connect(SCOPE_WITH_PROFILE);
    vi.restoreAllMocks();
  });

  it("pullMonth with a location and the permission saves the three numbers, ok", async () => {
    const s = await linked();
    const g = pullGoogle();
    expect(await pullMonth(e, s.siteId, PERIOD, { now: NOW, f: g.f })).toEqual({ status: "ok", error: "" });
    const row = await getTrafficMonth(env.DB, s.siteId, PERIOD);
    expect(row!.facts).toMatchObject({ search: { clicks: 40 }, profile: { calls: 7, directions: 7, websiteClicks: 7, previousCalls: 7 } });
  });

  it('pullMonth with a location but no profile scope saves the sentence "Reconnect Google with the Business Profile permission" and still saves search and visits', async () => {
    await connect(SCOPE);
    const s = await linked();
    const g = pullGoogle();
    const r = await pullMonth(e, s.siteId, PERIOD, { now: NOW, f: g.f });
    expect(r.status).toBe("partial");
    expect(r.error).toBe(RECONNECT);
    expect(g.profileCalls()).toBe(0);
    const row = await getTrafficMonth(env.DB, s.siteId, PERIOD);
    expect(row).toMatchObject({ status: "partial", error: RECONNECT });
    expect((row!.facts as any).search).toMatchObject({ clicks: 40 });
    expect((row!.facts as any).profile).toBeNull();
    expect((await getLink(env.DB, s.siteId))!.lastError).toBe(RECONNECT);
  });

  it("a Business Profile 403 saves partial with the Business Profile sentence and keeps search", async () => {
    const s = await linked();
    const r = await pullMonth(e, s.siteId, PERIOD, { now: NOW, f: pullGoogle({ gbpStatus: 403 }).f });
    expect(r).toEqual({ status: "partial", error: SENTENCE });
    expect(((await getTrafficMonth(env.DB, s.siteId, PERIOD))!.facts as any).search).toMatchObject({ clicks: 40 });
  });

  it("a profile alone, unread, is a failed month; read, it is an ok month", async () => {
    const s = await linked({ gsc: false });
    expect((await pullMonth(e, s.siteId, PERIOD, { now: NOW, f: pullGoogle({ gbpStatus: 403 }).f })).status).toBe("failed");
    expect((await pullMonth(e, s.siteId, PERIOD, { now: NOW, f: pullGoogle().f, force: true })).status).toBe("ok");
  });

  it("a site with no location makes no profile call and the facts keep profile null", async () => {
    const s = await linked({ gbp: null });
    const g = pullGoogle();
    expect((await pullMonth(e, s.siteId, PERIOD, { now: NOW, f: g.f })).status).toBe("ok");
    expect(g.profileCalls()).toBe(0);
    expect(((await getTrafficMonth(env.DB, s.siteId, PERIOD))!.facts as any).profile).toBeNull();
  });

  it("a retry keeps the profile an earlier try read while the location is linked, and drops it once it is not", async () => {
    const s = await linked();
    await pullMonth(e, s.siteId, PERIOD, { now: NOW, f: pullGoogle().f }); // ok
    await env.DB.prepare(`UPDATE traffic_months SET status = 'partial' WHERE site_id = ?`).bind(s.siteId).run();
    // Linked: Business Profile fails this time, the stored numbers stay.
    expect((await pullMonth(e, s.siteId, PERIOD, { now: NOW, f: pullGoogle({ gbpStatus: 500 }).f })).status).toBe("ok");
    expect(((await getTrafficMonth(env.DB, s.siteId, PERIOD))!.facts as any).profile).toMatchObject({ calls: 7 });
    // Not linked any more: nothing is kept for it.
    await env.DB.prepare(`UPDATE traffic_months SET status = 'partial' WHERE site_id = ?`).bind(s.siteId).run();
    await saveLink(env.DB, s.siteId, { gbpLocation: null }, NOW.toISOString());
    await pullMonth(e, s.siteId, PERIOD, { now: NOW, f: pullGoogle().f });
    expect(((await getTrafficMonth(env.DB, s.siteId, PERIOD))!.facts as any).profile).toBeNull();
  });

  it("a dead connection fails everything as before and reads nothing", async () => {
    await env.DB.prepare(`DELETE FROM google_auth`).run();
    const s = await linked();
    const g = pullGoogle();
    expect((await pullMonth(e, s.siteId, PERIOD, { now: NOW, f: g.f })).status).toBe("failed");
    expect(g.reads()).toBe(0);
  });

  it("the sweep, the wait and the link check all count a site linked to a location alone", async () => {
    const s = await linked({ gsc: false });
    expect(await hasLinkedSource(e, s.siteId)).toBe(true);
    expect(await trafficWait(e, s.businessId, PERIOD, new Date("2026-12-02T18:00:00.000Z"))).toBe(true);
    const g = pullGoogle();
    expect(await sweepTraffic(e, NOW, g.f)).toEqual({ pulled: 1, failed: 0, skipped: 0 });
    expect(g.profileCalls()).toBeGreaterThan(0);
    expect((await getTrafficMonth(env.DB, s.siteId, PERIOD))!.status).toBe("ok");
    expect(await trafficWait(e, s.businessId, PERIOD, new Date("2026-12-02T18:00:00.000Z"))).toBe(false);
    // A row with nothing at all linked is still nothing.
    await saveLink(env.DB, s.siteId, { gbpLocation: null }, NOW.toISOString());
    expect(await hasLinkedSource(e, s.siteId)).toBe(false);
  });
});

// ---- what reports say ----

const profile = (o: Partial<NonNullable<TrafficFacts["profile"]>> = {}): NonNullable<TrafficFacts["profile"]> => ({ calls: 12, directions: 9, websiteClicks: 30, previousCalls: 8, ...o });
const facts = (o: Partial<TrafficFacts> = {}): TrafficFacts => ({ version: 1, period: PERIOD, search: null, visits: null, profile: null, ...o });
const search = { clicks: 40, impressions: 900, position: 7.3, previousClicks: 30, previousImpressions: 700, queries: [], pages: [] };

const CARE = {
  version: 1, period: PERIOD, label: "November 2026", from: "2026-11-01T07:00:00.000Z", to: "2026-12-01T08:00:00.000Z", clientName: "Ace Plumbing",
  sites: [{ domain: "ace.com", monitoredSince: "2026-10-03", uptimePercent: 99.9, coveredDays: 30, incidents: 0, longestOutageMinutes: null, updatesApplied: 4, updatesRolledBack: 0, updatesFailed: 0, updatesTracked: true, backups: 2, speedScore: 81 }],
  edits: null, renewals: [], generatedAt: "2026-12-01T17:00:00.000Z",
};
const SEO = {
  version: 1, period: PERIOD, label: "November 2026", clientName: "Ace Plumbing", rankAsOf: "2026-12-01", previousRankAsOf: null,
  terms: [{ term: "drain cleaning", town: "Tigard", points: Array.from({ length: 9 }, (_, i) => ({ pos: i < 2 ? 2 : 9, ok: true })), measured: 9, visible: 2, previousVisible: null }],
  gbp: { rating: 4.7, reviewCount: 43, reviewsGained: null, ratingChange: null }, reviews: { seen: 0, posted: 0, needsYou: 0 },
  content: { published: [], drafted: 0, planned: 0 }, citations: null, nap: null, generatedAt: "2026-12-01T17:00:00.000Z",
};

describe("Business Profile numbers in reports", () => {
  it("shapeProfile keeps the three counts and the call comparison inside the allowed range", () => {
    expect(shapeProfile({ calls: 3, directions: 2, websiteClicks: 1, previousCalls: null })).toEqual({ calls: 3, directions: 2, websiteClicks: 1, previousCalls: null });
    expect(shapeProfile({ calls: -1, directions: 9_999_999.4, websiteClicks: Number.NaN, previousCalls: 4.6 })).toEqual({ calls: 0, directions: 1_000_000, websiteClicks: 0, previousCalls: 5 });
  });

  it("hasTrafficData is true for a search, visits or profile block alone and false for none", () => {
    expect(hasTrafficData(facts())).toBe(false);
    expect(hasTrafficData(null)).toBe(false);
    expect(hasTrafficData(undefined)).toBe(false);
    expect(hasTrafficData(facts({ profile: profile() }))).toBe(true);
    expect(hasTrafficData(facts({ search }))).toBe(true);
  });

  it("a report with profile numbers shows calls, directions and website clicks, and one without shows nothing about them", () => {
    // What the page gets, field by field.
    const pub = publicTraffic(facts({ search, profile: profile() }))!;
    expect(pub.profile).toEqual({ calls: 12, directions: 9, websiteClicks: 30, previousCalls: 8 });
    expect(publicTraffic(facts({ profile: profile() }))).toEqual({ profile: { calls: 12, directions: 9, websiteClicks: 30, previousCalls: 8 } });
    expect(publicTraffic(facts({ search }))).not.toHaveProperty("profile");
    expect(publicTraffic(facts())).toBeUndefined();

    const view = trafficView(pub)!;
    expect(view.profile!.rows).toEqual([
      { label: "People tapped to call", value: "12 (last month 8)" },
      { label: "Directions requested", value: "9" },
      { label: "Website clicks from your profile", value: "30" },
    ]);
    expect(view.note).toBe("Counted by Google's own month.");
    expect(trafficView(publicTraffic(facts({ search })))!.profile).toBeNull();
    // A real zero is shown as 0; no earlier month leaves the comparison out.
    const zero = trafficView(publicTraffic(facts({ profile: profile({ calls: 0, directions: 0, websiteClicks: 0, previousCalls: null }) })))!;
    expect(zero.profile!.rows).toEqual([
      { label: "People tapped to call", value: "0" }, { label: "Directions requested", value: "0" }, { label: "Website clicks from your profile", value: "0" },
    ]);

    // The code-written summary, and the lines Claude reads.
    const careWith = ReportFacts.parse({ ...CARE, traffic: facts({ profile: profile() }) });
    expect(plainSummary(careWith)).toContain("people tapped to call 12 times, asked for directions 9 times and clicked through to your website 30 times");
    expect(plainSummary(careWith)).toContain("counted by Google");
    expect(plainSummary(ReportFacts.parse({ ...CARE, traffic: facts({ search }) }))).not.toMatch(/Business Profile|tapped to call/);
    expect(plainSummary(ReportFacts.parse(CARE))).not.toMatch(/Business Profile|tapped to call/);
    const seoWith = SeoReportFacts.parse({ ...SEO, traffic: facts({ profile: profile() }) });
    expect(plainSeoSummary(seoWith)).toContain("tapped to call 12 times");
    expect(plainSeoSummary(SeoReportFacts.parse(SEO))).not.toMatch(/tapped to call/);
    expect(plainTraffic(facts({ search }))).toHaveLength(1);
    expect(plainTraffic(facts({ search })).join(" ")).not.toMatch(/call|direction|profile/i);

    const lines = trafficLines(facts({ search, profile: profile() })).join("\n");
    expect(lines).toContain("Google Business Profile: people tapped to call 12 times (last month 8); asked for directions 9 times; clicked through to the website 30 times");
    expect(trafficLines(facts({ profile: profile({ previousCalls: null }) })).join("\n")).toContain("tapped to call 12 times;");
    expect(trafficLines(facts({ search })).join("\n")).not.toMatch(/Business Profile/);
    expect(trafficLines(facts())).toEqual([]);
  });

  it("instructionsFor still forbids leads and sales when profile numbers exist", () => {
    for (const text of [
      careInstructions(ReportFacts.parse({ ...CARE, traffic: facts({ search, profile: profile() }) })),
      careInstructions(ReportFacts.parse({ ...CARE, traffic: facts({ profile: profile() }) })),
      seoInstructions(SeoReportFacts.parse({ ...SEO, traffic: facts({ search, profile: profile() }) })),
      seoInstructions(SeoReportFacts.parse({ ...SEO, traffic: facts({ profile: profile() }) })),
    ]) {
      expect(text).toMatch(/never mention leads, sales or money/i);
      expect(text).toMatch(/never say what caused a change/i);
      expect(text).toMatch(/never promise a result/i);
      expect(text).toMatch(/Google Business Profile/);
      expect(text).toMatch(/calls, direction requests and website clicks/i);
      expect(text).toMatch(/counted by Google/);
      // The calls are allowed now: the old "never mention ... calls" is gone.
      expect(text).not.toMatch(/never mention leads, sales, calls or money/i);
      expect(text).not.toMatch(/say nothing about traffic/i);
    }
    // Without a profile block, the text is what it was (the other test files pin it byte for byte).
    expect(careInstructions(ReportFacts.parse({ ...CARE, traffic: facts({ search }) }))).toMatch(/never mention leads, sales, calls or money/i);
    expect(careInstructions(ReportFacts.parse({ ...CARE, traffic: facts({ search }) }))).not.toMatch(/Business Profile/);
    expect(seoInstructions(SeoReportFacts.parse({ ...SEO, traffic: facts({ search }) }))).not.toMatch(/Business Profile/);
  });

  it("Local SEO's profile rule keeps the Business Profile counts apart from its own review figures", () => {
    const text = seoInstructions(SeoReportFacts.parse({ ...SEO, traffic: facts({ profile: profile() }) }));
    expect(text).toMatch(/not the reviews or rating/i);
    expect(text).toMatch(/as in our check/i);
  });
});
