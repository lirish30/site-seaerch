import { createExecutionContext, env } from "cloudflare:test";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import worker from "../src/worker/index";
import { saveGoogleAuth } from "../src/worker/db/google";
import { archiveSite, createSite } from "../src/worker/db/sites";
import { getLink, getTrafficMonth, saveLink, saveTrafficMonth } from "../src/worker/db/traffic";
import type { Env } from "../src/worker/env";
import { encryptSecret } from "../src/worker/google/crypto";
import { placeHold } from "../src/worker/db/holds";
import { saveSettings } from "../src/worker/db/settings";
import { DAILY_CRON, runScheduled } from "../src/worker/schedule";
import {
  MAX_PULL_ATTEMPTS, MAX_SITES_PER_RUN, PULL_FROM_DAY, REPORT_WAIT_UNTIL_DAY, TRAFFIC_WALL_MS, pullMonth, sweepTraffic, trafficClock, trafficWait,
} from "../src/worker/traffic/pull";
import { seedClient } from "./fixtures/clients";
import { E } from "./fixtures/close";

const SCOPE = "openid email https://www.googleapis.com/auth/webmasters.readonly https://www.googleapis.com/auth/analytics.readonly";
const e = { ...E, GOOGLE_CLIENT_ID: "cid", GOOGLE_CLIENT_SECRET: "sec" } as Env;
// Friday 4 December 2026, 10:00 in Los Angeles: the first pull day of December, so the month pulled is November.
const NOW = new Date("2026-12-04T18:00:00.000Z");
const PERIOD = "2026-11";
const at = (iso: string) => new Date(iso);

interface Call { url: string; method: string; body: any }
interface Plan {
  /** Search Console answers this status instead of data. */
  gscStatus?: number;
  /** Search Console answers with no rows at all: Google counted nothing. */
  gscEmpty?: boolean;
  /** Every Analytics call answers this status instead of data. */
  ga4Status?: number;
  /** The web stream hosts Analytics reports for a property (default: the host given to `linked`). */
  streams?: Record<string, string[]>;
}

/** A fake Google: the token endpoint, Search Console's query and Analytics' streams and reports. A request is told apart by its dates: the month asked for starts on `curStart`. */
function google(plan: Plan = {}, curStart = "2026-11-01") {
  const calls: Call[] = [];
  const f = async (url: string, init?: RequestInit) => {
    const body = typeof init?.body === "string" ? JSON.parse(init.body) : null;
    calls.push({ url, method: init?.method ?? "GET", body });
    if (url === "https://oauth2.googleapis.com/token") return Response.json({ access_token: "tok", expires_in: 3600 });
    if (url.includes("/searchAnalytics/query")) {
      if (plan.gscStatus) return Response.json({ error: { message: "nope" } }, { status: plan.gscStatus });
      if (plan.gscEmpty) return Response.json({});
      const cur = body.startDate === curStart;
      if (body.dimensions?.[0] === "query") return Response.json({ rows: [{ keys: ["ace plumbing"], clicks: 12, impressions: 300 }] });
      if (body.dimensions?.[0] === "page") return Response.json({ rows: [{ keys: ["https://ace.test/drains"], clicks: 9 }] });
      return Response.json({ rows: [cur ? { clicks: 40, impressions: 900, position: 7.34 } : { clicks: 30, impressions: 700, position: 8 }] });
    }
    if (url.includes("analyticsadmin.googleapis.com") || url.includes("analyticsdata.googleapis.com")) {
      if (plan.ga4Status) return Response.json({ error: { message: "nope" } }, { status: plan.ga4Status });
      const m = /properties\/(\d+)/.exec(url);
      if (url.endsWith("/dataStreams")) {
        return Response.json({ dataStreams: (plan.streams?.[m![1]] ?? []).map((h) => ({ type: "WEB_DATA_STREAM", webStreamData: { defaultUri: `https://${h}/` } })) });
      }
      if (body.dimensions) {
        return Response.json({
          rows: [
            { dimensionValues: [{ value: "Organic Search" }, { value: "date_range_0" }], metricValues: [{ value: "60" }] },
            { dimensionValues: [{ value: "Direct" }, { value: "date_range_0" }], metricValues: [{ value: "40" }] },
            { dimensionValues: [{ value: "Organic Search" }, { value: "date_range_1" }], metricValues: [{ value: "50" }] },
          ],
        });
      }
      return Response.json({
        metricHeaders: [{ name: "sessions" }, { name: "totalUsers" }, { name: "keyEvents" }],
        rows: [
          { dimensionValues: [{ value: "date_range_0" }], metricValues: [{ value: "100" }, { value: "80" }, { value: "7" }] },
          { dimensionValues: [{ value: "date_range_1" }], metricValues: [{ value: "90" }, { value: "70" }, { value: "5" }] },
        ],
      });
    }
    return Response.json({}, { status: 404 });
  };
  return {
    f, calls,
    /** Calls that reached Search Console or Analytics (not the token endpoint). */
    reads: () => calls.filter((c) => c.url !== "https://oauth2.googleapis.com/token"),
    gscCalls: () => calls.filter((c) => c.url.includes("/searchAnalytics/query")),
  };
}

async function connect() {
  await env.DB.prepare(`DELETE FROM google_auth`).run();
  await saveGoogleAuth(env.DB, "me@x.test", await encryptSecret(env.SESSION_SECRET, "refresh-1"), SCOPE);
}

let n = 0;
/**
 * A real client's site on `domain` (a new domain when left out), linked to Search Console and, with `ga4`, to Analytics property 123. Stream hosts for the fake are given to `google({ streams })`.
 * `test` makes the client a rehearsal one.
 */
async function linked(o: { domain?: string | null; gsc?: string | null; ga4?: string | null; test?: boolean; businessId?: string } = {}) {
  const domain = o.domain === undefined ? `ace${++n}.test` : o.domain;
  const businessId = o.businessId ?? (await seedClient({ site: false, test: o.test })).businessId;
  const { site } = await createSite(env.DB, { businessId, url: domain ? `https://${domain}` : null, domain, test: o.test ?? false });
  const gsc = o.gsc === undefined ? (domain ? `sc-domain:${domain}` : null) : o.gsc;
  await saveLink(env.DB, site.id, { gscProperty: gsc, ga4Property: o.ga4 ?? null }, NOW.toISOString());
  return { siteId: site.id, businessId, domain };
}

beforeEach(async () => {
  await env.DB.prepare(`DELETE FROM traffic_months`).run();
  await env.DB.prepare(`DELETE FROM site_analytics`).run();
  await saveSettings(env.DB, { booking_config: "{}" });
  await connect();
});
afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); });

const month = (siteId: string, period = PERIOD) => getTrafficMonth(env.DB, siteId, period);
const frame = { version: 1, period: PERIOD, search: null, visits: null, profile: null };

describe("the constants", () => {
  it("are the plan's numbers", () => {
    expect([PULL_FROM_DAY, REPORT_WAIT_UNTIL_DAY, MAX_PULL_ATTEMPTS, MAX_SITES_PER_RUN, TRAFFIC_WALL_MS]).toEqual([4, 7, 5, 40, 240_000]);
  });
});

describe("pullMonth", () => {
  it("pullMonth ok saves search and visits with the month before's numbers", async () => {
    const s = await linked({ domain: "ace.test", ga4: "123" });
    const g = google({ streams: { "123": ["ace.test"] } });
    const r = await pullMonth(e, s.siteId, PERIOD, { now: NOW, f: g.f });
    expect(r).toEqual({ status: "ok", error: "" });
    const row = await month(s.siteId);
    expect(row).toMatchObject({ status: "ok", attempts: 1, error: "", pulledAt: NOW.toISOString() });
    expect(row!.facts).toMatchObject({
      version: 1, period: PERIOD, profile: null,
      search: { clicks: 40, impressions: 900, position: 7.3, previousClicks: 30, previousImpressions: 700, queries: [{ query: "ace plumbing", clicks: 12, impressions: 300 }], pages: [{ path: "/drains", clicks: 9 }] },
      visits: { sessions: 100, users: 80, organic: 60, keyEvents: 7, previousSessions: 90, previousOrganic: 50 },
    });
    // The month and the one before it, as calendar dates: November, and October.
    const starts = g.reads().flatMap((c) => (c.body?.startDate ? [c.body.startDate] : c.body?.dateRanges?.map((d: any) => d.startDate) ?? []));
    expect(new Set(starts)).toEqual(new Set(["2026-11-01", "2026-10-01"]));
    const ends = g.reads().flatMap((c) => (c.body?.endDate ? [c.body.endDate] : c.body?.dateRanges?.map((d: any) => d.endDate) ?? []));
    expect(new Set(ends)).toEqual(new Set(["2026-11-30", "2026-10-31"]));
    // A clean read clears the link's error and stamps the check.
    expect(await getLink(env.DB, s.siteId)).toMatchObject({ lastError: "", checkedAt: NOW.toISOString() });
  });

  it("a month linked to Search Console alone is ok, with visits null", async () => {
    const s = await linked({ domain: "ace.test" });
    const g = google();
    expect((await pullMonth(e, s.siteId, PERIOD, { now: NOW, f: g.f })).status).toBe("ok");
    const facts = (await month(s.siteId))!.facts as any;
    expect(facts.search.clicks).toBe(40);
    expect(facts.visits).toBeNull();
    expect(g.reads().every((c) => c.url.includes("/searchAnalytics/query"))).toBe(true);
  });

  it("the month before December is November of the same year, and the month before January is last year's December", async () => {
    const s = await linked({ domain: "ace.test" });
    const g = google({}, "2027-01-01");
    // On 4 January 2027 the month pulled is December 2026; its comparison is November.
    expect((await pullMonth(e, s.siteId, "2026-12", { now: at("2027-01-04T18:00:00.000Z"), f: g.f })).status).toBe("ok");
    expect(new Set(g.gscCalls().map((c) => c.body.startDate))).toEqual(new Set(["2026-12-01", "2026-11-01"]));
    const g2 = google({}, "2026-01-01");
    await pullMonth(e, s.siteId, "2026-01", { now: at("2027-01-04T18:00:00.000Z"), f: g2.f });
    expect(new Set(g2.gscCalls().map((c) => c.body.startDate))).toEqual(new Set(["2026-01-01", "2025-12-01"]));
  });

  it("pullMonth with gsc ok and ga4 403 saves partial, visits null and the sentence naming the viewer", async () => {
    const s = await linked({ domain: "ace.test", ga4: "123" });
    const g = google({ ga4Status: 403, streams: { "123": ["ace.test"] } });
    const r = await pullMonth(e, s.siteId, PERIOD, { now: NOW, f: g.f });
    expect(r.status).toBe("partial");
    expect(r.error).toBe("Google says me@x.test can't read this one. Ask the client to add me@x.test as a viewer, then it will be tried again tomorrow.");
    const row = (await month(s.siteId))!;
    expect(row).toMatchObject({ status: "partial", error: r.error });
    expect((row.facts as any).search.clicks).toBe(40);
    expect((row.facts as any).visits).toBeNull();
    expect((await getLink(env.DB, s.siteId))!.lastError).toBe(r.error);
  });

  it("pullMonth with a 401 saves failed and the reconnect sentence", async () => {
    const s = await linked({ domain: "ace.test", ga4: "123" });
    const g = google({ gscStatus: 401, streams: { "123": ["ace.test"] } });
    const r = await pullMonth(e, s.siteId, PERIOD, { now: NOW, f: g.f });
    expect(r).toEqual({ status: "failed", error: "Google no longer accepts the connection. Reconnect Google in Settings." });
    expect(await month(s.siteId)).toMatchObject({ status: "failed", facts: frame, error: r.error });
    expect((await getLink(env.DB, s.siteId))!.lastError).toBe(r.error);
    // A dead connection is not retried on the other source.
    expect(g.reads().some((c) => c.url.includes("analytics"))).toBe(false);
  });

  it("pullMonth with Google not connected, or the traffic scopes not granted, saves failed and makes no read", async () => {
    const s = await linked({ domain: "ace.test" });
    await env.DB.prepare(`DELETE FROM google_auth`).run();
    const g = google();
    expect(await pullMonth(e, s.siteId, PERIOD, { now: NOW, f: g.f })).toEqual({ status: "failed", error: "Google isn't connected. Connect it in Settings." });
    await saveGoogleAuth(env.DB, "me@x.test", await encryptSecret(env.SESSION_SECRET, "refresh-1"), "openid email");
    const r = await pullMonth(e, s.siteId, PERIOD, { now: NOW, f: g.f });
    expect(r.status).toBe("failed");
    expect(r.error).toBe("Reconnect Google in Settings so it can read Search Console and Analytics.");
    expect(g.reads()).toEqual([]);
  });

  it("pullMonth refuses to read a link whose gsc host no longer matches the site's domain (saves failed, makes no Google call)", async () => {
    const s = await linked({ domain: "ace.test", gsc: "sc-domain:other.test" });
    const g = google();
    const r = await pullMonth(e, s.siteId, PERIOD, { now: NOW, f: g.f });
    expect(r).toEqual({ status: "failed", error: "This property no longer matches the site's domain. Link it again." });
    expect(g.calls).toEqual([]);
    expect(await month(s.siteId)).toMatchObject({ status: "failed", facts: frame, error: r.error });
    expect((await getLink(env.DB, s.siteId))!.lastError).toBe(r.error);
  });

  it("a site with no domain fails both sources with that sentence and makes no Google call", async () => {
    const s = await linked({ domain: null, gsc: "sc-domain:ace.test", ga4: "123" });
    const g = google({ streams: { "123": ["ace.test"] } });
    const r = await pullMonth(e, s.siteId, PERIOD, { now: NOW, f: g.f });
    expect(r).toEqual({ status: "failed", error: "This property no longer matches the site's domain. Link it again." });
    expect(g.calls).toEqual([]);
  });

  it("an Analytics property whose stream no longer matches fails that source alone, after one stream lookup", async () => {
    const s = await linked({ domain: "ace.test", ga4: "123" });
    const g = google({ streams: { "123": ["somebody-else.test"] } });
    const r = await pullMonth(e, s.siteId, PERIOD, { now: NOW, f: g.f });
    expect(r).toEqual({ status: "partial", error: "This property no longer matches the site's domain. Link it again." });
    const row = (await month(s.siteId))!;
    expect((row.facts as any).search.clicks).toBe(40);
    expect((row.facts as any).visits).toBeNull();
    expect(g.reads().filter((c) => c.url.endsWith("/dataStreams"))).toHaveLength(1);
    expect(g.reads().some((c) => c.url.includes(":runReport"))).toBe(false);
  });

  it("an Analytics property that ALSO measures another site fails that source alone and reads no report", async () => {
    const s = await linked({ domain: "ace.test", ga4: "123" });
    const g = google({ streams: { "123": ["brand.test", "ace.test"] } });
    const r = await pullMonth(e, s.siteId, PERIOD, { now: NOW, f: g.f });
    expect(r).toEqual({ status: "partial", error: "This property no longer matches the site's domain. Link it again." });
    expect(((await month(s.siteId))!.facts as any).visits).toBeNull();
    expect(g.reads().some((c) => c.url.includes(":runReport"))).toBe(false);
  });

  it("an Analytics property with no web stream fails that source and reads no report", async () => {
    const s = await linked({ domain: "ace.test", ga4: "123" });
    const g = google({ streams: { "123": [] } });
    const r = await pullMonth(e, s.siteId, PERIOD, { now: NOW, f: g.f });
    expect(r.error).toBe("This property no longer matches the site's domain. Link it again.");
    expect(g.reads().some((c) => c.url.includes(":runReport"))).toBe(false);
  });

  it("an Analytics property whose every stream is the site's host is still read", async () => {
    const s = await linked({ domain: "ace.test", ga4: "123" });
    const g = google({ streams: { "123": ["ace.test", "www.ace.test"] } });
    expect((await pullMonth(e, s.siteId, PERIOD, { now: NOW, f: g.f })).status).toBe("ok");
  });

  it("a site with nothing linked is failed with its sentence, no call and nothing saved", async () => {
    const s = await linked({ domain: "ace.test", gsc: null });
    const g = google();
    expect(await pullMonth(e, s.siteId, PERIOD, { now: NOW, f: g.f })).toEqual({ status: "failed", error: "Nothing is linked for this site." });
    expect(g.calls).toEqual([]);
    expect(await month(s.siteId)).toBeNull();
  });

  it("a later failed pull keeps the ok row, and so does a forced failed one (R15); a forced ok pull replaces it", async () => {
    const s = await linked({ domain: "ace.test" });
    await pullMonth(e, s.siteId, PERIOD, { now: NOW, f: google().f });
    const good = await month(s.siteId);
    expect(good!.status).toBe("ok");

    const later = at("2026-12-05T18:00:00.000Z");
    const r = await pullMonth(e, s.siteId, PERIOD, { now: later, f: google({ gscStatus: 500 }).f });
    expect(r.status).toBe("failed");
    expect(await month(s.siteId)).toEqual(good);

    // The owner's "Pull last month now" gets the failure sentence, and the good month stays with its facts.
    const forced = await pullMonth(e, s.siteId, PERIOD, { now: later, force: true, f: google({ gscStatus: 500 }).f });
    expect(forced).toEqual({ status: "failed", error: "Google did not answer. It will be tried again tomorrow." });
    expect(await month(s.siteId)).toEqual(good);

    const replaced = await pullMonth(e, s.siteId, PERIOD, { now: later, force: true, f: google().f });
    expect(replaced.status).toBe("ok");
    expect(await month(s.siteId)).toMatchObject({ status: "ok", facts: (good!.facts as any), pulledAt: later.toISOString(), attempts: 2 });
  });

  it("a forced pull still replaces a failed row fully", async () => {
    const s = await linked({ domain: "ace.test" });
    await pullMonth(e, s.siteId, PERIOD, { now: NOW, f: google({ gscStatus: 500 }).f });
    expect((await month(s.siteId))!.status).toBe("failed");
    expect((await pullMonth(e, s.siteId, PERIOD, { now: NOW, force: true, f: google().f })).status).toBe("ok");
    expect(await month(s.siteId)).toMatchObject({ status: "ok", attempts: 2 });
  });

  it("a linked property with an empty Search Console answer saves ok with clicks 0 and impressions 0", async () => {
    const s = await linked({ domain: "ace.test" });
    expect(await pullMonth(e, s.siteId, PERIOD, { now: NOW, f: google({ gscEmpty: true }).f })).toEqual({ status: "ok", error: "" });
    const facts = (await month(s.siteId))!.facts as any;
    expect(facts.search).toEqual({ clicks: 0, impressions: 0, position: null, previousClicks: 0, previousImpressions: 0, queries: [], pages: [] });
    expect(facts.visits).toBeNull();
  });

  describe("a retry of a month that was not complete", () => {
    const NEXT = at("2026-12-05T18:00:00.000Z");
    const both = async () => {
      const s = await linked({ domain: "ace.test", ga4: "123" });
      return { siteId: s.siteId, streams: { "123": ["ace.test"] } };
    };

    it("a failed retry keeps the search numbers a partial pull already read", async () => {
      const s = await both();
      expect((await pullMonth(e, s.siteId, PERIOD, { now: NOW, f: google({ ga4Status: 403, streams: s.streams }).f })).status).toBe("partial");
      const r = await pullMonth(e, s.siteId, PERIOD, { now: NEXT, f: google({ gscStatus: 500, ga4Status: 403, streams: s.streams }).f });
      expect(r.status).toBe("partial");
      expect(r.error).toContain("Google did not answer.");
      expect(r.error).toContain("can't read this one");
      const row = (await month(s.siteId))!;
      expect(row).toMatchObject({ status: "partial", attempts: 2, pulledAt: NEXT.toISOString(), error: r.error });
      expect((row.facts as any).search.clicks).toBe(40);
      expect((row.facts as any).visits).toBeNull();
      expect((await getLink(env.DB, s.siteId))!.lastError).toBe(r.error);
    });

    it("a partial retry that reads the other source ends up ok with both", async () => {
      const s = await both();
      expect((await pullMonth(e, s.siteId, PERIOD, { now: NOW, f: google({ gscStatus: 500, streams: s.streams }).f })).status).toBe("partial");
      // Search Console reads now, Analytics does not: the visits an earlier try read are kept, so both are there.
      const r = await pullMonth(e, s.siteId, PERIOD, { now: NEXT, f: google({ ga4Status: 403, streams: s.streams }).f });
      expect(r.status).toBe("ok");
      expect(r.error).toContain("can't read this one");
      const row = (await month(s.siteId))!;
      expect(row.status).toBe("ok");
      expect((row.facts as any).search.clicks).toBe(40);
      expect((row.facts as any).visits.sessions).toBe(100);
    });

    it("a partial retry that swaps sources keeps the union", async () => {
      const s = await both();
      await pullMonth(e, s.siteId, PERIOD, { now: NOW, f: google({ ga4Status: 403, streams: s.streams }).f });
      // Search Console now fails and Analytics now reads: the month holds both.
      const r = await pullMonth(e, s.siteId, PERIOD, { now: NEXT, f: google({ gscStatus: 500, streams: s.streams }).f });
      expect(r.status).toBe("ok");
      const row = (await month(s.siteId))!;
      expect(row.status).toBe("ok");
      expect((row.facts as any).search.clicks).toBe(40);
      expect((row.facts as any).visits.sessions).toBe(100);
    });

    it("a source that is no longer linked is not kept", async () => {
      const s = await both();
      await pullMonth(e, s.siteId, PERIOD, { now: NOW, f: google({ ga4Status: 403, streams: s.streams }).f });
      await saveLink(env.DB, s.siteId, { gscProperty: null }, NOW.toISOString());
      const r = await pullMonth(e, s.siteId, PERIOD, { now: NEXT, f: google({ ga4Status: 403, streams: s.streams }).f });
      expect(r.status).toBe("failed");
      expect((await month(s.siteId))!.facts).toEqual(frame);
    });

    it("force replaces the merged facts with this pull's result", async () => {
      const s = await both();
      await pullMonth(e, s.siteId, PERIOD, { now: NOW, f: google({ ga4Status: 403, streams: s.streams }).f });
      const r = await pullMonth(e, s.siteId, PERIOD, { now: NEXT, force: true, f: google({ gscStatus: 500, ga4Status: 403, streams: s.streams }).f });
      expect(r.status).toBe("failed");
      expect(await month(s.siteId)).toMatchObject({ status: "failed", facts: frame, attempts: 2 });
    });
  });

  it("an unknown or archived site is refused", async () => {
    const s = await linked({ domain: "ace.test" });
    await archiveSite(env.DB, s.siteId, NOW.toISOString());
    await expect(pullMonth(e, s.siteId, PERIOD, { now: NOW, f: google().f })).rejects.toThrow();
    await expect(pullMonth(e, "nope", PERIOD, { now: NOW, f: google().f })).rejects.toThrow();
  });
});

describe("sweepTraffic", () => {
  it("sweepTraffic does nothing on the 3rd and pulls last month on the 4th", async () => {
    const s = await linked({ domain: "ace.test" });
    const g = google();
    expect(await sweepTraffic(e, at("2026-12-03T18:00:00.000Z"), g.f)).toEqual({ pulled: 0, failed: 0, skipped: 0 });
    expect(g.calls).toEqual([]);
    expect(await sweepTraffic(e, NOW, g.f)).toEqual({ pulled: 1, failed: 0, skipped: 0 });
    expect(await month(s.siteId)).toMatchObject({ status: "ok" });
    expect(await month(s.siteId, "2026-12")).toBeNull();
  });

  it("sweepTraffic stops at the first 401 (one Google call, not forty)", async () => {
    const sites = [await linked(), await linked(), await linked()];
    const g = google({ gscStatus: 401 });
    const out = await sweepTraffic(e, NOW, g.f);
    expect(out).toEqual({ pulled: 0, failed: 1, skipped: 2 });
    expect(g.gscCalls()).toHaveLength(1);
    expect(g.calls.filter((c) => c.url === "https://oauth2.googleapis.com/token")).toHaveLength(1);
    const rows = await Promise.all(sites.map((s) => month(s.siteId)));
    expect(rows.filter(Boolean)).toHaveLength(1);
    expect(rows.find(Boolean)!.status).toBe("failed");
  });

  it("a Google call that times out fails that site with the 'did not answer' sentence and does not end the run (I3)", async () => {
    const sites = [await linked(), await linked()];
    const g = google();
    let thrown = false;
    const f = async (url: string, init?: RequestInit) => {
      if (url.includes("/searchAnalytics/query") && !thrown) { thrown = true; throw new DOMException("The operation timed out.", "TimeoutError"); }
      return g.f(url, init);
    };
    expect(await sweepTraffic(e, NOW, f)).toEqual({ pulled: 1, failed: 1, skipped: 0 });
    const rows = await Promise.all(sites.map((s) => month(s.siteId)));
    expect(rows.map((r) => r!.status).sort()).toEqual(["failed", "ok"]);
    expect(rows.find((r) => r!.status === "failed")!.error).toBe("Google did not answer. It will be tried again tomorrow.");
  });

  it("pullMonth's default fetch gives every Google call a timeout signal (I3)", async () => {
    await linked({ domain: "ace.test", ga4: "123" });
    const g = google({ streams: { "123": ["ace.test"] } });
    const signals: (AbortSignal | null | undefined)[] = [];
    vi.stubGlobal("fetch", vi.fn(async (url: string, init?: RequestInit) => { signals.push(init?.signal); return g.f(url, init); }));
    expect(await sweepTraffic(e, NOW)).toMatchObject({ pulled: 1 });
    expect(signals.length).toBeGreaterThan(3);
    expect(signals.every((x) => x instanceof AbortSignal)).toBe(true);
  });

  it("sweepTraffic asks Google for one token for the whole run", async () => {
    const sites = [await linked(), await linked(), await linked()];
    const g = google();
    expect(await sweepTraffic(e, NOW, g.f)).toEqual({ pulled: 3, failed: 0, skipped: 0 });
    expect(g.calls.filter((c) => c.url === "https://oauth2.googleapis.com/token")).toHaveLength(1);
    expect((await Promise.all(sites.map((s) => month(s.siteId)))).every((m) => m?.status === "ok")).toBe(true);
  });

  it("sweepTraffic stops the whole run when Google is not connected", async () => {
    const sites = [await linked(), await linked()];
    await env.DB.prepare(`DELETE FROM google_auth`).run();
    const g = google();
    expect(await sweepTraffic(e, NOW, g.f)).toEqual({ pulled: 0, failed: 1, skipped: 1 });
    expect(g.calls).toEqual([]);
    expect((await Promise.all(sites.map((s) => month(s.siteId)))).filter(Boolean)).toHaveLength(1);
  });

  it("sweepTraffic skips test clients, archived sites and a site with 5 attempts", async () => {
    const real = await linked({ domain: "real.test" });
    const test = await linked({ domain: "rehearsal.test", test: true });
    const archived = await linked({ domain: "gone.test" });
    await archiveSite(env.DB, archived.siteId, NOW.toISOString());
    const tired = await linked({ domain: "tired.test" });
    for (let i = 0; i < MAX_PULL_ATTEMPTS; i++) await saveTrafficMonth(env.DB, { siteId: tired.siteId, period: PERIOD, status: "failed", facts: frame, error: "x" }, "2026-12-04T01:00:00.000Z");
    const done = await linked({ domain: "done.test" });
    await saveTrafficMonth(env.DB, { siteId: done.siteId, period: PERIOD, status: "ok", facts: frame }, "2026-12-04T01:00:00.000Z");
    const empty = await linked({ domain: "empty.test", gsc: null });
    const g = google();
    expect(await sweepTraffic(e, NOW, g.f)).toEqual({ pulled: 1, failed: 0, skipped: 0 });
    expect(g.gscCalls().every((c) => c.url.includes(encodeURIComponent("sc-domain:real.test")))).toBe(true);
    expect(await month(real.siteId)).toMatchObject({ status: "ok" });
    for (const s of [test, archived, empty]) expect(await month(s.siteId)).toBeNull();
    expect(await month(tired.siteId)).toMatchObject({ attempts: MAX_PULL_ATTEMPTS, status: "failed" });
    expect((await month(done.siteId))!.attempts).toBe(1);
  });

  it("a client on billing hold keeps getting pulls", async () => {
    const c = await seedClient({ site: false, invoice: { cents: 50_000 } });
    expect(await placeHold(env.DB, { businessId: c.businessId, invoiceId: c.invoice!.id, now: NOW.toISOString() })).toBe(true);
    const s = await linked({ businessId: c.businessId, domain: "held.test" });
    expect((await sweepTraffic(e, NOW, google().f)).pulled).toBe(1);
    expect(await month(s.siteId)).toMatchObject({ status: "ok" });
  });

  it("sweepTraffic retries a partial month and a failed one, the site tried longest ago first", async () => {
    await linked({ domain: "never.test" });
    const old = await linked({ domain: "old.test" });
    const recent = await linked({ domain: "recent.test" });
    await saveTrafficMonth(env.DB, { siteId: old.siteId, period: PERIOD, status: "failed", facts: frame, error: "x" }, "2026-12-04T01:00:00.000Z");
    await saveTrafficMonth(env.DB, { siteId: recent.siteId, period: PERIOD, status: "partial", facts: frame, error: "x" }, "2026-12-04T09:00:00.000Z");
    const g = google();
    await sweepTraffic(e, NOW, g.f);
    const order = g.gscCalls().filter((c) => c.body.startDate === "2026-11-01" && !c.body.dimensions).map((c) => decodeURIComponent(c.url.split("/sites/")[1].split("/searchAnalytics")[0]));
    expect(order).toEqual(["sc-domain:never.test", "sc-domain:old.test", "sc-domain:recent.test"]);
    expect((await month(old.siteId))!.attempts).toBe(2);
  });

  it("sweepTraffic respects MAX_SITES_PER_RUN", async () => {
    const { businessId } = await seedClient({ site: false });
    const sites = [];
    for (let i = 0; i < MAX_SITES_PER_RUN + 1; i++) sites.push(await linked({ businessId, domain: `many${i}.test` }));
    const g = google();
    expect(await sweepTraffic(e, NOW, g.f)).toEqual({ pulled: MAX_SITES_PER_RUN, failed: 0, skipped: 0 });
    const done = (await Promise.all(sites.map((s) => month(s.siteId)))).filter(Boolean);
    expect(done).toHaveLength(MAX_SITES_PER_RUN);
    // The next run picks up the one left.
    expect(await sweepTraffic(e, at("2026-12-05T18:00:00.000Z"), g.f)).toEqual({ pulled: 1, failed: 0, skipped: 0 });
  });

  it("sweepTraffic stops starting sites once the wall guard is past and returns what it did", async () => {
    const sites = [await linked(), await linked(), await linked()];
    let t = 0;
    const real = trafficClock.now;
    // Every look moves the clock 3 minutes: the first site starts inside the guard, the second is past 4 minutes.
    trafficClock.now = () => (t += 3 * 60_000);
    try {
      expect(await sweepTraffic(e, NOW, google().f)).toEqual({ pulled: 1, failed: 0, skipped: 2 });
    } finally { trafficClock.now = real; }
    expect((await Promise.all(sites.map((s) => month(s.siteId)))).filter(Boolean)).toHaveLength(1);
  });

  it("a network fault in one site's pull is a failed read of that site and the next site is still pulled", async () => {
    const a = await linked({ domain: "boom.test" });
    const b = await linked({ domain: "fine.test" });
    const inner = google();
    const f = async (url: string, init?: RequestInit) => {
      if (url.includes(encodeURIComponent("sc-domain:boom.test"))) throw new TypeError("network down");
      return inner.f(url, init);
    };
    const out = await sweepTraffic(e, NOW, f as any);
    expect(out.pulled).toBe(1);
    expect(await month(b.siteId)).toMatchObject({ status: "ok" });
    // A network fault is a failed read of that site, saved with a plain sentence.
    expect(await month(a.siteId)).toMatchObject({ status: "failed", error: "Google could not be read. It will be tried again tomorrow." });
  });

  it("month edges use the booking zone: on 2026-12-04 07:00Z (Los Angeles 23:00 on the 3rd) the sweep does nothing, on 2026-12-04 09:00Z it pulls 2026-11", async () => {
    const s = await linked({ domain: "ace.test" });
    const g = google();
    expect(await sweepTraffic(e, at("2026-12-04T07:00:00.000Z"), g.f)).toEqual({ pulled: 0, failed: 0, skipped: 0 });
    expect(g.calls).toEqual([]);
    expect(await sweepTraffic(e, at("2026-12-04T09:00:00.000Z"), g.f)).toEqual({ pulled: 1, failed: 0, skipped: 0 });
    expect(await month(s.siteId)).toMatchObject({ status: "ok" });
  });

  it("the previous month on 2027-01-04 in the booking zone is 2026-12", async () => {
    const s = await linked({ domain: "ace.test" });
    await sweepTraffic(e, at("2027-01-04T18:00:00.000Z"), google({}, "2026-12-01").f);
    expect(await month(s.siteId, "2026-12")).toMatchObject({ status: "ok" });
  });
});

describe("the daily run", () => {
  it("pulls last month's numbers in the traffic part, before the care reports", async () => {
    const s = await linked({ domain: "ace.test" });
    vi.stubGlobal("fetch", vi.fn(google().f));
    const logs = vi.spyOn(console, "log").mockImplementation(() => {});
    vi.spyOn(console, "error").mockImplementation(() => {});
    await runScheduled(e, DAILY_CRON, NOW);
    expect(await month(s.siteId)).toMatchObject({ status: "ok" });
    const said = logs.mock.calls.map((c) => String(c[0]));
    expect(said.indexOf("traffic")).toBeGreaterThan(-1);
    expect(said.indexOf("traffic")).toBeLessThan(said.indexOf("care reports"));
    expect(logs).toHaveBeenCalledWith("traffic", JSON.stringify({ pulled: 1, failed: 0, skipped: 0 }));
  });
});

describe("trafficWait", () => {
  const SECOND = at("2026-12-02T18:00:00.000Z");
  const SEVENTH = at("2026-12-07T18:00:00.000Z");

  it("trafficWait is true on the 2nd with a linked site and no row, false on the 7th, false with no link, false once an ok row exists, false for a test client's site", async () => {
    const s = await linked({ domain: "ace.test" });
    expect(await trafficWait(e, s.businessId, PERIOD, SECOND)).toBe(true);
    expect(await trafficWait(e, s.businessId, PERIOD, at("2026-12-06T18:00:00.000Z"))).toBe(true);
    expect(await trafficWait(e, s.businessId, PERIOD, SEVENTH)).toBe(false);
    // The booking zone decides the day: 2026-12-07 05:00Z is still the 6th in Los Angeles.
    expect(await trafficWait(e, s.businessId, PERIOD, at("2026-12-07T05:00:00.000Z"))).toBe(true);
    expect(await trafficWait(e, s.businessId, PERIOD, at("2026-12-07T09:00:00.000Z"))).toBe(false);

    const none = await seedClient({ site: false });
    await createSite(env.DB, { businessId: none.businessId, url: "https://nolink.test", domain: "nolink.test" });
    expect(await trafficWait(e, none.businessId, PERIOD, SECOND)).toBe(false);

    const empty = await linked({ domain: "empty.test", gsc: null });
    expect(await trafficWait(e, empty.businessId, PERIOD, SECOND)).toBe(false);

    await saveTrafficMonth(env.DB, { siteId: s.siteId, period: PERIOD, status: "ok", facts: frame }, NOW.toISOString());
    expect(await trafficWait(e, s.businessId, PERIOD, SECOND)).toBe(false);

    const rehearsal = await linked({ domain: "rehearsal.test", test: true });
    expect(await trafficWait(e, rehearsal.businessId, PERIOD, SECOND)).toBe(false);
  });

  it("does not wait when Google is not connected or the traffic scopes were not granted (a dead connection cannot pull)", async () => {
    const s = await linked({ domain: "ace.test" });
    expect(await trafficWait(e, s.businessId, PERIOD, SECOND)).toBe(true);
    await saveGoogleAuth(env.DB, "me@x.test", await encryptSecret(env.SESSION_SECRET, "refresh-1"), "openid email https://www.googleapis.com/auth/webmasters.readonly");
    expect(await trafficWait(e, s.businessId, PERIOD, SECOND)).toBe(false);
    await env.DB.prepare(`DELETE FROM google_auth`).run();
    expect(await trafficWait(e, s.businessId, PERIOD, SECOND)).toBe(false);
    await connect();
    expect(await trafficWait(e, s.businessId, PERIOD, SECOND)).toBe(true);
  });

  it("a partial month ends the wait, a failed one does not until it has had 5 attempts", async () => {
    const s = await linked({ domain: "ace.test" });
    await saveTrafficMonth(env.DB, { siteId: s.siteId, period: PERIOD, status: "failed", facts: frame, error: "x" }, NOW.toISOString());
    expect(await trafficWait(e, s.businessId, PERIOD, SECOND)).toBe(true);
    for (let i = 1; i < MAX_PULL_ATTEMPTS - 1; i++) await saveTrafficMonth(env.DB, { siteId: s.siteId, period: PERIOD, status: "failed", facts: frame, error: "x" }, NOW.toISOString());
    expect((await month(s.siteId))!.attempts).toBe(MAX_PULL_ATTEMPTS - 1);
    expect(await trafficWait(e, s.businessId, PERIOD, SECOND)).toBe(true);
    await saveTrafficMonth(env.DB, { siteId: s.siteId, period: PERIOD, status: "failed", facts: frame, error: "x" }, NOW.toISOString());
    expect(await trafficWait(e, s.businessId, PERIOD, SECOND)).toBe(false);

    const p = await linked({ domain: "part.test" });
    await saveTrafficMonth(env.DB, { siteId: p.siteId, period: PERIOD, status: "partial", facts: frame, error: "x" }, NOW.toISOString());
    expect(await trafficWait(e, p.businessId, PERIOD, SECOND)).toBe(false);
  });

  it("waits while any one of the client's sites is still to be read, and not for an archived one", async () => {
    const a = await linked({ domain: "a.test" });
    const b = await linked({ businessId: a.businessId, domain: "b.test" });
    await saveTrafficMonth(env.DB, { siteId: a.siteId, period: PERIOD, status: "ok", facts: frame }, NOW.toISOString());
    expect(await trafficWait(e, a.businessId, PERIOD, SECOND)).toBe(true);
    await archiveSite(env.DB, b.siteId, NOW.toISOString());
    expect(await trafficWait(e, a.businessId, PERIOD, SECOND)).toBe(false);
  });
});

describe("POST /api/traffic/site/:siteId/pull", () => {
  const ctx = () => createExecutionContext();
  let cookie = "";
  async function call(siteId: string, body?: unknown, session = true) {
    if (session && !cookie) {
      const login = await worker.fetch(new Request("https://x/api/login", { method: "POST", body: JSON.stringify({ password: "test-pass" }), headers: { "content-type": "application/json" } }), E, ctx());
      cookie = login.headers.get("set-cookie")!.split(";")[0];
    }
    return worker.fetch(new Request(`https://x/api/traffic/site/${siteId}/pull`, {
      method: "POST", body: body === undefined ? undefined : JSON.stringify(body), headers: { ...(session ? { cookie } : {}), "content-type": "application/json" },
    }), e, ctx());
  }
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(NOW);
  });
  afterEach(() => { vi.useRealTimers(); });

  it("without a session is 401", async () => {
    const s = await linked({ domain: "ace.test" });
    expect((await call(s.siteId, { period: PERIOD }, false)).status).toBe(401);
  });

  it("pulls the month by force and answers the status and the sentence", async () => {
    const s = await linked({ domain: "ace.test" });
    const g = google();
    vi.stubGlobal("fetch", vi.fn(g.f));
    await saveTrafficMonth(env.DB, { siteId: s.siteId, period: PERIOD, status: "ok", facts: { ...frame, search: null } }, "2026-12-04T01:00:00.000Z");
    const r = await call(s.siteId, { period: PERIOD });
    expect(r.status).toBe(200);
    expect(await r.json()).toEqual({ status: "ok", error: "" });
    // Forced: the ok row it found was replaced by this pull.
    expect(((await month(s.siteId))!.facts as any).search.clicks).toBe(40);
  });

  it("a Google call that times out is 200 with the 'did not answer' sentence on a pull and 502 with it on find (I3)", async () => {
    const s = await linked({ domain: "ace.test" });
    vi.stubGlobal("fetch", vi.fn(async () => { throw new DOMException("The operation timed out.", "TimeoutError"); }));
    const r = await call(s.siteId, { period: PERIOD });
    expect(r.status).toBe(200);
    expect(await r.json()).toEqual({ status: "failed", error: "Google did not answer. It will be tried again tomorrow." });
    const found = await worker.fetch(new Request(`https://x/api/traffic/site/${s.siteId}/find`, { method: "POST", headers: { cookie } }), e, ctx());
    expect(found.status).toBe(502);
    expect(await found.json()).toEqual({ error: "Google did not answer. It will be tried again tomorrow." });
  });

  it("a failed pull is 200 with its sentence", async () => {
    const s = await linked({ domain: "ace.test" });
    vi.stubGlobal("fetch", vi.fn(google({ gscStatus: 429 }).f));
    const r = await call(s.siteId, { period: PERIOD });
    expect(r.status).toBe(200);
    expect(await r.json()).toEqual({ status: "failed", error: "Google did not answer. It will be tried again tomorrow." });
  });

  it("refuses a month that has not finished (this one, a later one, or one that is not a month) with 409 and calls nothing", async () => {
    const s = await linked({ domain: "ace.test" });
    const g = google();
    vi.stubGlobal("fetch", vi.fn(g.f));
    for (const period of ["2026-12", "2027-01", "2026-13", "nov", ""]) {
      const r = await call(s.siteId, { period });
      expect(r.status, period).toBe(409);
      expect(await r.json()).toEqual({ error: "Choose a month that has finished." });
    }
    expect(g.calls).toEqual([]);
    expect(await month(s.siteId, "2026-12")).toBeNull();
  });

  it("a body with no period is 400", async () => {
    const s = await linked({ domain: "ace.test" });
    expect((await call(s.siteId, {})).status).toBe(400);
  });

  it("the month ends in the booking zone: on 2026-12-01 05:00Z (still 30 November in Los Angeles) November is refused", async () => {
    const s = await linked({ domain: "ace.test" });
    vi.setSystemTime(at("2026-12-01T05:00:00.000Z"));
    vi.stubGlobal("fetch", vi.fn(google().f));
    expect((await call(s.siteId, { period: "2026-11" })).status).toBe(409);
    expect((await call(s.siteId, { period: "2026-10" })).status).toBe(200);
  });

  it("an unknown or archived site is 404, and a site with nothing linked is 409", async () => {
    const s = await linked({ domain: "ace.test" });
    const empty = await linked({ domain: "empty.test", gsc: null });
    vi.stubGlobal("fetch", vi.fn(google().f));
    expect((await call("nope", { period: PERIOD })).status).toBe(404);
    const r = await call(empty.siteId, { period: PERIOD });
    expect(r.status).toBe(409);
    expect(await r.json()).toEqual({ error: "Nothing is linked for this site." });
    const bare = await seedClient({ site: false });
    const { site } = await createSite(env.DB, { businessId: bare.businessId, url: "https://bare.test", domain: "bare.test" });
    expect((await call(site.id, { period: PERIOD })).status).toBe(409);
    await archiveSite(env.DB, s.siteId, NOW.toISOString());
    expect((await call(s.siteId, { period: PERIOD })).status).toBe(404);
  });
});
