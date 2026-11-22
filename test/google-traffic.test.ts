import { env, SELF } from "cloudflare:test";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { gscMonth, gscTotals, listGscSites } from "../src/worker/google/searchConsole";
import { ga4Hosts, ga4Month, listGa4Properties } from "../src/worker/google/analytics";
import { GoogleApiError, google, timedFetch } from "../src/worker/google/api";
import { SCOPES, TRAFFIC_SCOPES, authUrl, hasTrafficScopes } from "../src/worker/google/oauth";
import { trafficProblem } from "../src/worker/traffic/problem";
import { saveGoogleAuth } from "../src/worker/db/google";

interface Call { url: string; method: string; headers: Record<string, string>; body: any }
function fake(respond: (c: Call) => Response) {
  const calls: Call[] = [];
  const f = async (url: string, init?: RequestInit) => {
    const c: Call = { url, method: init?.method ?? "GET", headers: (init?.headers ?? {}) as Record<string, string>, body: typeof init?.body === "string" ? JSON.parse(init.body) : init?.body };
    calls.push(c);
    return respond(c);
  };
  return { f, calls };
}

const OCT = { start: "2026-10-01", end: "2026-10-31" };
const SEP = { start: "2026-09-01", end: "2026-09-30" };
const SC_DOMAIN = "sc-domain:example.com";

/** Answers the three Search Console queries by what the body asks for. */
const gscFake = () => fake((c) => {
  const dims = c.body.dimensions as string[] | undefined;
  if (!dims) return Response.json({ rows: [{ clicks: 120, impressions: 4000, ctr: 0.03, position: 8.4567 }] });
  if (dims[0] === "query") return Response.json({ rows: [{ keys: ["plumber boise"], clicks: 40, impressions: 900, ctr: 0.04, position: 3 }, { keys: ["drain repair"], clicks: 12, impressions: 300, ctr: 0.04, position: 5 }] });
  return Response.json({ rows: [{ keys: ["https://example.com/"], clicks: 70, impressions: 2000, ctr: 0.035, position: 6 }] });
});

describe("Search Console", () => {
  it("gscMonth puts sc-domain%3Aexample.com in the path and sends startDate 2026-10-01 and endDate 2026-10-31", async () => {
    const { f, calls } = gscFake();
    await gscMonth(f, "tok", SC_DOMAIN, OCT);
    expect(calls).toHaveLength(3);
    for (const c of calls) {
      expect(c.url).toBe("https://www.googleapis.com/webmasters/v3/sites/sc-domain%3Aexample.com/searchAnalytics/query");
      expect(c.method).toBe("POST");
      expect(c.headers.authorization).toBe("Bearer tok");
      expect(c.body).toMatchObject({ startDate: "2026-10-01", endDate: "2026-10-31" });
    }
    expect(calls.map((c) => c.body.dimensions)).toEqual([undefined, ["query"], ["page"]]);
    expect(calls[1].body.rowLimit).toBe(10);
    expect(calls[2].body.rowLimit).toBe(10);
  });

  it("gscMonth with no rows returns clicks 0, impressions 0, position null, empty lists", async () => {
    const { f } = fake(() => Response.json({ responseAggregationType: "auto" }));
    expect(await gscMonth(f, "t", SC_DOMAIN, OCT)).toEqual({ clicks: 0, impressions: 0, position: null, queries: [], pages: [] });
  });

  it("gscMonth takes position from the aggregate row", async () => {
    const { f } = gscFake();
    const m = await gscMonth(f, "t", SC_DOMAIN, OCT);
    expect(m).toEqual({
      clicks: 120, impressions: 4000, position: 8.5,
      queries: [{ query: "plumber boise", clicks: 40, impressions: 900 }, { query: "drain repair", clicks: 12, impressions: 300 }],
      pages: [{ page: "https://example.com/", clicks: 70 }],
    });
  });

  it("gscTotals makes the one aggregate call", async () => {
    const { f, calls } = gscFake();
    expect(await gscTotals(f, "t", SC_DOMAIN, SEP)).toEqual({ clicks: 120, impressions: 4000 });
    expect(calls).toHaveLength(1);
    expect(calls[0].body.dimensions).toBeUndefined();
    expect(calls[0].body).toMatchObject({ startDate: "2026-09-01", endDate: "2026-09-30" });
    expect(await gscTotals(fake(() => Response.json({})).f, "t", SC_DOMAIN, SEP)).toEqual({ clicks: 0, impressions: 0 });
  });

  it("listGscSites drops siteUnverifiedUser", async () => {
    const { f, calls } = fake(() => Response.json({ siteEntry: [
      { siteUrl: "sc-domain:example.com", permissionLevel: "siteOwner" },
      { siteUrl: "https://nope.test/", permissionLevel: "siteUnverifiedUser" },
      { siteUrl: "https://www.example.org/", permissionLevel: "siteFullUser" },
    ] }));
    expect(await listGscSites(f, "tok")).toEqual([{ siteUrl: "sc-domain:example.com", level: "siteOwner" }, { siteUrl: "https://www.example.org/", level: "siteFullUser" }]);
    expect(calls[0].url).toBe("https://www.googleapis.com/webmasters/v3/sites");
    expect(await listGscSites(fake(() => Response.json({})).f, "tok")).toEqual([]);
  });
});

const num = (v: number) => ({ value: String(v) });
/** Answers the two runReport calls: totals (no channel dimension) and by channel. Both carry the two date ranges. */
const ga4Fake = (opts: { keyEvents?: boolean } = {}) => fake((c) => {
  const byChannel = c.body.dimensions?.some((d: any) => d.name === "sessionDefaultChannelGroup");
  if (byChannel) return Response.json({
    dimensionHeaders: [{ name: "sessionDefaultChannelGroup" }, { name: "dateRange" }], metricHeaders: [{ name: "sessions" }],
    rows: [
      { dimensionValues: [{ value: "Direct" }, { value: "date_range_0" }], metricValues: [num(30)] },
      { dimensionValues: [{ value: "Organic Search" }, { value: "date_range_0" }], metricValues: [num(80)] },
      { dimensionValues: [{ value: "Organic Search" }, { value: "date_range_1" }], metricValues: [num(50)] },
      { dimensionValues: [{ value: "Direct" }, { value: "date_range_1" }], metricValues: [num(20)] },
    ],
  });
  const withKe = opts.keyEvents !== false;
  return Response.json({
    dimensionHeaders: [{ name: "dateRange" }], metricHeaders: [{ name: "sessions" }, { name: "totalUsers" }, ...(withKe ? [{ name: "keyEvents" }] : [])],
    rows: [
      { dimensionValues: [{ value: "date_range_1" }], metricValues: [num(70), num(60), ...(withKe ? [num(3)] : [])] },
      { dimensionValues: [{ value: "date_range_0" }], metricValues: [num(110), num(90), ...(withKe ? [num(7)] : [])] },
    ],
  });
});

describe("Analytics", () => {
  it("ga4Month sends both date ranges and maps sessions, users and organic (the \"Organic Search\" channel)", async () => {
    const { f, calls } = ga4Fake();
    const m = await ga4Month(f, "tok", "123456", OCT, SEP);
    expect(calls).toHaveLength(2);
    for (const c of calls) {
      expect(c.url).toBe("https://analyticsdata.googleapis.com/v1beta/properties/123456:runReport");
      expect(c.method).toBe("POST");
      expect(c.headers.authorization).toBe("Bearer tok");
      expect(c.body.dateRanges).toEqual([{ startDate: "2026-10-01", endDate: "2026-10-31" }, { startDate: "2026-09-01", endDate: "2026-09-30" }]);
    }
    expect(m).toEqual({
      sessions: 110, users: 90, keyEvents: 7, organic: 80,
      channels: [{ channel: "Organic Search", sessions: 80 }, { channel: "Direct", sessions: 30 }],
      previous: { sessions: 70, organic: 50 },
    });
  });

  it("ga4Month with no keyEvents metric in the answer gives keyEvents null", async () => {
    const m = await ga4Month(ga4Fake({ keyEvents: false }).f, "t", "1", OCT, SEP);
    expect(m.keyEvents).toBeNull();
    expect(m.sessions).toBe(110);
  });

  it("ga4Month with no rows is a real zero, not null", async () => {
    const { f } = fake((c) => Response.json(c.body.dimensions?.length
      ? { dimensionHeaders: [{ name: "sessionDefaultChannelGroup" }, { name: "dateRange" }], metricHeaders: [{ name: "sessions" }] }
      : { dimensionHeaders: [{ name: "dateRange" }], metricHeaders: [{ name: "sessions" }, { name: "totalUsers" }, { name: "keyEvents" }] }));
    expect(await ga4Month(f, "t", "1", OCT, SEP)).toEqual({ sessions: 0, users: 0, keyEvents: 0, organic: 0, channels: [], previous: { sessions: null, organic: null } });
  });

  it("ga4Month with no date_range_1 row says the previous month was never measured (null), and a date_range_1 row of 0 is a real 0 (I5)", async () => {
    const answer = (prev: boolean) => fake((c) => Response.json(c.body.dimensions?.length
      ? { dimensionHeaders: [{ name: "sessionDefaultChannelGroup" }, { name: "dateRange" }], metricHeaders: [{ name: "sessions" }],
        rows: [{ dimensionValues: [{ value: "Organic Search" }, { value: "date_range_0" }], metricValues: [num(5)] }] }
      : { dimensionHeaders: [{ name: "dateRange" }], metricHeaders: [{ name: "sessions" }, { name: "totalUsers" }, { name: "keyEvents" }],
        rows: [
          { dimensionValues: [{ value: "date_range_0" }], metricValues: [num(5), num(4), num(1)] },
          ...(prev ? [{ dimensionValues: [{ value: "date_range_1" }], metricValues: [num(0), num(0), num(0)] }] : []),
        ] }));
    expect((await ga4Month(answer(false).f, "t", "1", OCT, SEP)).previous).toEqual({ sessions: null, organic: null });
    expect((await ga4Month(answer(true).f, "t", "1", OCT, SEP)).previous).toEqual({ sessions: 0, organic: 0 });
  });

  it("listGa4Properties flattens accountSummaries to id and name", async () => {
    const { f, calls } = fake(() => Response.json({ accountSummaries: [
      { account: "accounts/1", propertySummaries: [{ property: "properties/123", displayName: "Example" }, { property: "properties/456", displayName: "Other" }] },
      { account: "accounts/2" },
    ] }));
    expect(await listGa4Properties(f, "tok")).toEqual([{ id: "123", name: "Example" }, { id: "456", name: "Other" }]);
    expect(calls[0].url).toContain("https://analyticsadmin.googleapis.com/v1beta/accountSummaries");
  });

  it("ga4Hosts gives the lower-case hosts of the web streams only", async () => {
    const { f, calls } = fake(() => Response.json({ dataStreams: [
      { type: "WEB_DATA_STREAM", webStreamData: { defaultUri: "https://WWW.Example.com/" } },
      { type: "ANDROID_APP_DATA_STREAM", androidAppStreamData: { packageName: "com.example" } },
      { type: "WEB_DATA_STREAM", webStreamData: { defaultUri: "not a url" } },
    ] }));
    expect(await ga4Hosts(f, "tok", "123")).toEqual(["www.example.com"]);
    expect(calls[0].url).toBe("https://analyticsadmin.googleapis.com/v1beta/properties/123/dataStreams");
  });
});

describe("GoogleApiError", () => {
  it("a 403 is a GoogleApiError with status 403 and the old message text", async () => {
    const { f } = fake(() => Response.json({ error: { message: "User does not have sufficient permission" } }, { status: 403 }));
    const e: unknown = await google(f, "t", "https://x/y").catch((x: unknown) => x);
    expect(e).toBeInstanceOf(GoogleApiError);
    expect(e).toBeInstanceOf(Error);
    expect((e as GoogleApiError).status).toBe(403);
    expect((e as GoogleApiError).message).toBe("Google API 403: User does not have sufficient permission");
    const bare: unknown = await google(fake(() => new Response("nope", { status: 500 })).f, "t", "https://x/y").catch((x: unknown) => x);
    expect((bare as GoogleApiError).message).toBe("Google API 500: request failed");
  });
});

describe("GoogleApiError reason (I4)", () => {
  const failWith = (body: unknown) => google(fake(() => Response.json(body, { status: 403 })).f, "t", "https://x/y").catch((x: unknown) => x) as Promise<GoogleApiError>;

  it("carries the machine reason from errors[].reason, then details[].reason, then error.status, and never the message", async () => {
    expect((await failWith({ error: { status: "PERMISSION_DENIED", message: "secret words", errors: [{ reason: "accessNotConfigured", message: "x" }] } })).reason).toBe("accessNotConfigured");
    expect((await failWith({ error: { status: "PERMISSION_DENIED", message: "secret words", details: [{ "@type": "t", reason: "SERVICE_DISABLED" }] } })).reason).toBe("SERVICE_DISABLED");
    expect((await failWith({ error: { status: "PERMISSION_DENIED", message: "secret words" } })).reason).toBe("PERMISSION_DENIED");
    const none = await failWith({ error: { message: "secret words" } });
    expect(none.reason).toBeUndefined();
    // A "reason" that is not a plain machine word is not carried.
    expect((await failWith({ error: { errors: [{ reason: "Mail me at a@b.test $5 now" }] } })).reason).toBeUndefined();
  });
});

describe("timedFetch (I3)", () => {
  afterEach(() => { vi.unstubAllGlobals(); });

  it("calls fetch with the same url and init plus an abort signal", async () => {
    const seen: { url: string; init?: RequestInit }[] = [];
    vi.stubGlobal("fetch", vi.fn(async (url: string, init?: RequestInit) => { seen.push({ url, init }); return new Response("{}"); }));
    await timedFetch("https://x/y", { method: "POST", body: "b" });
    expect(seen[0].url).toBe("https://x/y");
    expect(seen[0].init).toMatchObject({ method: "POST", body: "b" });
    expect(seen[0].init!.signal).toBeInstanceOf(AbortSignal);
  });
});

describe("trafficProblem", () => {
  const err = (status: number) => new GoogleApiError(status, `Google API ${status}: some body text`);

  it("trafficProblem 403 names the connected email and says to ask the client to add it as a viewer", () => {
    const s = trafficProblem(err(403), { email: "pat@agency.test" });
    expect(s).toContain("pat@agency.test");
    expect(s).toMatch(/ask the client to add/i);
    expect(s).toMatch(/viewer/i);
    expect(trafficProblem(err(403), { email: null })).toMatch(/viewer/i);
  });

  it("trafficProblem 401 says to reconnect Google in Settings", () => {
    expect(trafficProblem(err(401), { email: "a@b.test" })).toMatch(/reconnect Google in Settings/i);
    expect(trafficProblem(new Error("Google token error: invalid_grant"), { email: null })).toMatch(/reconnect Google in Settings/i);
  });

  it("trafficProblem 429 and 500 say Google did not answer and it will be tried again tomorrow", () => {
    for (const status of [429, 500, 503]) expect(trafficProblem(err(status), { email: null })).toMatch(/Google did not answer.*tried again tomorrow/i);
  });

  it("a disabled API says to turn it on for the Google Cloud project, by source, and a plain 403 still says viewer (I4)", () => {
    const off = (reason: string) => new GoogleApiError(403, "Google API 403: x", reason);
    const ask = (reason: string, which?: "search" | "analytics" | "profile") => trafficProblem(off(reason), { email: "pat@agency.test", which });
    for (const reason of ["SERVICE_DISABLED", "accessNotConfigured", "API_NOT_ENABLED"]) {
      expect(ask(reason, "search")).toBe("Turn on the Google Search Console API for your Google Cloud project, then try again.");
      expect(ask(reason, "analytics")).toBe("Turn on the Google Analytics Data and Admin APIs for your Google Cloud project, then try again.");
      expect(ask(reason, "profile")).toBe("Turn on the Google My Business API for your Google Cloud project, then try again.");
    }
    expect(trafficProblem(off("PERMISSION_DENIED"), { email: "pat@agency.test", which: "search" })).toMatch(/viewer/);
    expect(trafficProblem(new GoogleApiError(403, "x"), { email: null })).toMatch(/viewer/);
    expect(trafficProblem(off("PERMISSION_DENIED"), { email: null, which: "profile" })).toMatch(/Business Profile API access/);
  });

  it("a timeout or abort is Google not answering, never a reconnect (I3)", () => {
    for (const name of ["TimeoutError", "AbortError"]) {
      const s = trafficProblem(new DOMException("The operation timed out", name), { email: "a@b.test" });
      expect(s).toBe("Google did not answer. It will be tried again tomorrow.");
    }
  });

  it("never repeats an error body", () => {
    for (const status of [400, 401, 403, 404, 429, 500]) expect(trafficProblem(err(status), { email: "a@b.test" })).not.toContain("some body text");
    expect(trafficProblem(new Error("secret detail"), { email: null })).not.toContain("secret detail");
  });
});

describe("scopes", () => {
  const SC = "https://www.googleapis.com/auth/webmasters.readonly";
  const GA = "https://www.googleapis.com/auth/analytics.readonly";
  const OLD = "openid email https://www.googleapis.com/auth/drive.file https://www.googleapis.com/auth/calendar.events https://www.googleapis.com/auth/calendar.freebusy";

  it("hasTrafficScopes is false for the scope string stored before this plan, true for both new scopes, false for one", () => {
    expect(TRAFFIC_SCOPES).toEqual([SC, GA]);
    expect(hasTrafficScopes(null)).toBe(false);
    expect(hasTrafficScopes(undefined)).toBe(false);
    expect(hasTrafficScopes(OLD)).toBe(false);
    expect(hasTrafficScopes(`${OLD} ${SC} ${GA}`)).toBe(true);
    expect(hasTrafficScopes(`${OLD} ${SC}`)).toBe(false);
    expect(hasTrafficScopes(`${OLD} ${GA}`)).toBe(false);
  });

  it("authUrl includes both new scopes", () => {
    const u = new URL(authUrl({ clientId: "cid", clientSecret: "x", redirectUri: "https://app/api/google/callback" }, "st"));
    const asked = u.searchParams.get("scope")!.split(" ");
    expect(asked).toContain(SC);
    expect(asked).toContain(GA);
    expect(SCOPES).toEqual(expect.arrayContaining([SC, GA]));
    expect(SCOPES.join(" ")).not.toContain("gmail");
  });
});

describe("GET /api/google/status traffic flag", () => {
  let cookie = "";
  beforeAll(async () => {
    const r = await SELF.fetch("https://x/api/login", { method: "POST", body: JSON.stringify({ password: "test-pass" }), headers: { "content-type": "application/json" } });
    cookie = r.headers.get("set-cookie")!.split(";")[0];
  });
  const status = async () => (await SELF.fetch("https://x/api/google/status", { headers: { cookie } })).json<any>();

  it("is false until both Search Console and Analytics are granted", async () => {
    await env.DB.prepare(`DELETE FROM google_auth`).run();
    expect((await status()).traffic).toBe(false);
    await saveGoogleAuth(env.DB, "me@example.com", "sealed", "openid email https://www.googleapis.com/auth/calendar.events https://www.googleapis.com/auth/calendar.freebusy");
    expect((await status()).traffic).toBe(false);
    await saveGoogleAuth(env.DB, "me@example.com", "sealed", "openid https://www.googleapis.com/auth/webmasters.readonly");
    expect((await status()).traffic).toBe(false);
    await saveGoogleAuth(env.DB, "me@example.com", "sealed", "openid https://www.googleapis.com/auth/webmasters.readonly https://www.googleapis.com/auth/analytics.readonly");
    expect(await status()).toMatchObject({ connected: true, traffic: true });
    await env.DB.prepare(`DELETE FROM google_auth`).run();
  });
});
