import { createExecutionContext, env } from "cloudflare:test";
import { beforeEach, describe, expect, it, vi } from "vitest";
import worker from "../src/worker/index";
import { saveGoogleAuth } from "../src/worker/db/google";
import { archiveSite, createSite } from "../src/worker/db/sites";
import { getLink, saveLink, saveTrafficMonth, getTrafficMonth } from "../src/worker/db/traffic";
import type { Env } from "../src/worker/env";
import { encryptSecret } from "../src/worker/google/crypto";
import { GoogleNotConnected } from "../src/worker/google/access";
import { LinkRefused, MAX_GA4_STREAM_LOOKUPS, findCandidates, ga4StreamMatchesHost, gscMatchesHost, linkSite, normalizeHost } from "../src/worker/traffic/link";
import { listActivity } from "../src/worker/db/activity";
import { seedClient } from "./fixtures/clients";
import { E } from "./fixtures/close";

const NOW = new Date("2026-12-02T18:00:00.000Z");
const SCOPE = "openid email https://www.googleapis.com/auth/webmasters.readonly https://www.googleapis.com/auth/analytics.readonly";
const e = { ...E, GOOGLE_CLIENT_ID: "cid", GOOGLE_CLIENT_SECRET: "sec" } as Env;

interface Call { url: string; method: string }
/** A fake Google: the token endpoint, the Search Console site list, the Analytics account summaries and each property's data streams. */
function google(o: { sites?: string[]; props?: { id: string; name: string }[]; streams?: Record<string, string[]>; status?: number } = {}) {
  const calls: Call[] = [];
  const f = async (url: string, init?: RequestInit) => {
    calls.push({ url, method: init?.method ?? "GET" });
    if (o.status) return Response.json({ error: { message: "nope" } }, { status: o.status });
    if (url === "https://oauth2.googleapis.com/token") return Response.json({ access_token: "tok", expires_in: 3600 });
    if (url.endsWith("/webmasters/v3/sites")) return Response.json({ siteEntry: (o.sites ?? []).map((siteUrl) => ({ siteUrl, permissionLevel: "siteOwner" })) });
    if (url.includes("/accountSummaries")) return Response.json({ accountSummaries: [{ propertySummaries: (o.props ?? []).map((p) => ({ property: `properties/${p.id}`, displayName: p.name })) }] });
    const m = /properties\/(\d+)\/dataStreams/.exec(url);
    if (m) return Response.json({ dataStreams: (o.streams?.[m[1]] ?? []).map((h) => ({ type: "WEB_DATA_STREAM", webStreamData: { defaultUri: `https://${h}/` } })) });
    return Response.json({}, { status: 404 });
  };
  return { f, calls, streamCalls: () => calls.filter((c) => c.url.includes("/dataStreams")).length };
}

async function connect() {
  await env.DB.prepare(`DELETE FROM google_auth`).run();
  await saveGoogleAuth(env.DB, "me@x.test", await encryptSecret(env.SESSION_SECRET, "refresh-1"), SCOPE);
}

/** A client whose one site is on `domain` (a site with no domain when null). */
async function siteOn(domain: string | null) {
  const s = await seedClient({ site: false });
  const { site } = await createSite(env.DB, { businessId: s.businessId, url: domain ? `https://${domain}` : null, domain });
  return site.id;
}

beforeEach(async () => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(NOW);
  await env.DB.prepare(`DELETE FROM google_auth`).run();
});

describe("normalizeHost", () => {
  it.each([
    ["sc-domain:example.com", "example.com"],
    ["sc-domain:www.example.com", "example.com"],
    ["https://www.example.com/", "example.com"],
    ["HTTP://Example.COM:8080/a/b?q=1#h", "example.com"],
    ["example.com.", "example.com"],
    ["  www.Example.com/path ", "example.com"],
  ])("%s -> %s", (input, out) => expect(normalizeHost(input)).toBe(out));
});

describe("gscMatchesHost and ga4StreamMatchesHost", () => {
  it.each([
    ["sc-domain:example.com", "example.com", true],
    ["sc-domain:www.example.com", "example.com", true],
    ["SC-DOMAIN:Example.COM", "www.example.com", true],
    ["https://example.com/", "example.com", true],
    ["https://www.example.com:8443/a?b=1", "example.com", true],
    ["http://example.com./", "example.com", true],
    ["sc-domain:example.com", "blog.example.com", false],
    ["https://example.com/", "blog.example.com", false],
    ["sc-domain:blog.example.com", "example.com", false],
    ["sc-domain:badexample.com", "example.com", false],
    ["sc-domain:example.com.evil.com", "example.com", false],
    ["https://evil.com/example.com", "example.com", false],
    ["https://example.com@evil.com/", "example.com", false],
    ["sc-domain:", "example.com", false],
    ["sc-domain:com", "example.com", false],
    ["sc-domain:", "", false],
  ])("gscMatchesHost(%s, %s) is %s", (property, site, out) => expect(gscMatchesHost(property, site)).toBe(out));

  it.each([
    ["example.com", "example.com", true],
    ["www.example.com", "example.com", true],
    ["EXAMPLE.com", "www.example.com", true],
    ["blog.example.com:443", "blog.example.com", true],
    ["example.com", "blog.example.com", false],
    ["com", "example.com", false],
    ["co.uk", "example.co.uk", false],
    ["example.com.evil.com", "example.com", false],
    ["", "", false],
  ])("ga4StreamMatchesHost(%s, %s) is %s", (stream, site, out) => expect(ga4StreamMatchesHost(stream, site)).toBe(out));
});

describe("findCandidates", () => {
  it("matches sc-domain:www.example.com and https://example.com/ to a site on example.com and not to example.org", async () => {
    await connect();
    const siteId = await siteOn("example.com");
    const { f } = google({ sites: ["sc-domain:www.example.com", "https://example.com/", "sc-domain:example.org", "https://example.org/", "https://notexample.com/", "sc-domain:ample.com", "https://blog.example.com/"] });
    const c = await findCandidates(e, siteId, f);
    expect(c.gsc.map((g) => g.siteUrl)).toEqual(["sc-domain:www.example.com", "https://example.com/"]);
    expect(c.email).toBe("me@x.test");
    expect(c.ga4).toEqual([]);
  });

  it("matches a subdomain site only to properties on that exact host, never to the domain above it", async () => {
    await connect();
    const siteId = await siteOn("blog.example.com");
    const { f } = google({ sites: ["sc-domain:example.com", "https://example.com/", "https://blog.example.com/", "sc-domain:shop.example.com", "sc-domain:blog.example.com", "sc-domain:com"] });
    const c = await findCandidates(e, siteId, f);
    expect(c.gsc.map((g) => g.siteUrl)).toEqual(["https://blog.example.com/", "sc-domain:blog.example.com"]);
  });

  it("does not list a sc-domain value with a trailing dot, the same as linkSite refuses it", async () => {
    await connect();
    const siteId = await siteOn("example.com");
    const { f } = google({ sites: ["sc-domain:example.com.", "https://example.com./", "sc-domain:example.com"] });
    expect((await findCandidates(e, siteId, f)).gsc.map((g) => g.siteUrl)).toEqual(["sc-domain:example.com"]);
    await expect(linkSite(e, siteId, { gscProperty: "sc-domain:example.com." }, NOW, f)).rejects.toThrow(LinkRefused);
    await expect(linkSite(e, siteId, { gscProperty: "https://example.com./" }, NOW, f)).rejects.toThrow(LinkRefused);
  });

  it("lists a GA4 property only when a web stream host matches and stops after 40 stream lookups", async () => {
    await connect();
    const siteId = await siteOn("example.com");
    const props = Array.from({ length: 45 }, (_, i) => ({ id: String(10000 + i), name: `P${i}` }));
    const streams: Record<string, string[]> = { "10000": ["other.org"], "10001": ["www.example.com"], "10002": [], "10003": ["a.org", "example.com"], "10044": ["example.com"] };
    const g = google({ props, streams });
    const c = await findCandidates(e, siteId, g.f);
    expect(c.ga4).toEqual([{ id: "10001", name: "P1" }, { id: "10003", name: "P3" }]);
    expect(g.streamCalls()).toBe(MAX_GA4_STREAM_LOOKUPS);
    expect(MAX_GA4_STREAM_LOOKUPS).toBe(40);
  });

  it("with Google not connected answers the sentence \"Connect your Google account in Settings first\"", async () => {
    const siteId = await siteOn("example.com");
    const g = google();
    await expect(findCandidates(e, siteId, g.f)).rejects.toThrow(new GoogleNotConnected("Connect your Google account in Settings first"));
    expect(g.calls).toHaveLength(0);
  });

  it("asks to reconnect Google when the traffic scopes were not granted, after the token call and with no property lookups", async () => {
    await saveGoogleAuth(env.DB, "me@x.test", await encryptSecret(env.SESSION_SECRET, "refresh-1"), "openid email https://www.googleapis.com/auth/webmasters.readonly");
    const siteId = await siteOn("example.com");
    const g = google();
    await expect(findCandidates(e, siteId, g.f)).rejects.toThrow("Reconnect Google in Settings so it can read Search Console and Analytics.");
    expect(g.streamCalls()).toBe(0);
    expect(g.calls.every((c) => c.url === "https://oauth2.googleapis.com/token")).toBe(true);
  });

  it("refuses a site with no domain", async () => {
    await connect();
    const siteId = await siteOn(null);
    await expect(findCandidates(e, siteId, google().f)).rejects.toThrow("Set the site's domain first.");
  });
});

describe("linkSite", () => {
  const T = NOW;

  it("refuses sc-domain:other.com for example.com with \"That property is for another site.\"", async () => {
    const siteId = await siteOn("example.com");
    const err = await linkSite(e, siteId, { gscProperty: "sc-domain:other.com" }, T, google().f).catch((x) => x);
    expect(err).toBeInstanceOf(LinkRefused);
    expect(err.message).toBe("That property is for another site.");
    expect(await getLink(env.DB, siteId)).toBeNull();
  });

  it("links a Search Console property that belongs to the site, without calling Google", async () => {
    const siteId = await siteOn("example.com");
    const g = google();
    const link = await linkSite(e, siteId, { gscProperty: "sc-domain:example.com" }, T, g.f);
    expect(link).toMatchObject({ siteId, gscProperty: "sc-domain:example.com", ga4Property: null, linkedAt: NOW.toISOString() });
    expect(g.calls).toHaveLength(0);
  });

  it("refuses a Search Console value that is not a property", async () => {
    const siteId = await siteOn("example.com");
    for (const bad of ["example.com", "sc-domain:example.com/evil", "ftp://example.com/", "sc-domain:"])
      await expect(linkSite(e, siteId, { gscProperty: bad }, T, google().f), bad).rejects.toThrow(LinkRefused);
  });

  it("refuses a ga4 id whose streams list another host", async () => {
    await connect();
    const siteId = await siteOn("example.com");
    const g = google({ streams: { "12345": ["other.org", "example.com.evil.net"] } });
    const err = await linkSite(e, siteId, { ga4Property: "12345" }, T, g.f).catch((x) => x);
    expect(err).toBeInstanceOf(LinkRefused);
    expect(err.message).toBe("That property is for another site.");
    expect(g.streamCalls()).toBe(1);
    expect(await getLink(env.DB, siteId)).toBeNull();
  });

  it("refuses a ga4 id that is not 5 to 15 digits", async () => {
    await connect();
    const siteId = await siteOn("example.com");
    const g = google({ streams: { "1234": ["example.com"] } });
    for (const bad of ["1234", "1234567890123456", "properties/12345", "12a45", " 12345", ""])
      await expect(linkSite(e, siteId, { ga4Property: bad }, T, g.f), JSON.stringify(bad)).rejects.toThrow(LinkRefused);
    expect(g.calls).toHaveLength(0);
  });

  it("links a ga4 property whose web stream is exactly the site's host, and refuses a host above it", async () => {
    await connect();
    const siteId = await siteOn("blog.example.com");
    const g = google({ streams: { "12345": ["example.com"], "23456": ["www.example.com"], "34567": ["com"], "45678": ["co.uk"], "56789": ["BLOG.example.com:443"] } });
    for (const id of ["12345", "23456", "34567", "45678"]) {
      const err = await linkSite(e, siteId, { ga4Property: id }, T, g.f).catch((x) => x);
      expect(err, id).toBeInstanceOf(LinkRefused);
      expect(err.message).toBe("That property is for another site.");
    }
    expect(await getLink(env.DB, siteId)).toBeNull();
    expect((await linkSite(e, siteId, { ga4Property: "56789" }, T, g.f)).ga4Property).toBe("56789");
  });

  it("refuses these look-alike Search Console properties for example.com with \"That property is for another site.\"", async () => {
    const siteId = await siteOn("example.com");
    for (const bad of ["sc-domain:badexample.com", "sc-domain:example.com.evil.com", "https://example.com.evil.com/", "https://evil.com/example.com", "https://example.com@evil.com/", "sc-domain:com", "sc-domain:other.com"]) {
      const err = await linkSite(e, siteId, { gscProperty: bad }, T, google().f).catch((x) => x);
      expect(err, bad).toBeInstanceOf(LinkRefused);
      expect(err.message, bad).toBe("That property is for another site.");
    }
    expect(await getLink(env.DB, siteId)).toBeNull();
  });

  it("refuses a subdomain site a sc-domain property above it", async () => {
    const siteId = await siteOn("blog.example.com");
    await expect(linkSite(e, siteId, { gscProperty: "sc-domain:example.com" }, T, google().f)).rejects.toThrow("That property is for another site.");
  });

  it("refuses a ga4 property with no web stream unless it is exactly the one already linked", async () => {
    await connect();
    const siteId = await siteOn("example.com");
    const g = google({ streams: { "12345": [] } });
    await expect(linkSite(e, siteId, { ga4Property: "12345" }, T, g.f)).rejects.toThrow("That property has no website data stream.");
    await saveLink(env.DB, siteId, { ga4Property: "12345" }, T.toISOString());
    expect((await linkSite(e, siteId, { ga4Property: "12345" }, T, g.f)).ga4Property).toBe("12345");
    await expect(linkSite(e, siteId, { ga4Property: "54321" }, T, google({ streams: { "54321": [] } }).f)).rejects.toThrow("That property has no website data stream.");
  });

  it("refuses a site with no domain", async () => {
    const siteId = await siteOn(null);
    await expect(linkSite(e, siteId, { gscProperty: "sc-domain:example.com" }, T, google().f)).rejects.toThrow("Set the site's domain first.");
  });

  it("clears a link on a site whose domain was removed, but refuses to link one there", async () => {
    const s = await seedClient({ site: false });
    const { site } = await createSite(env.DB, { businessId: s.businessId, url: "https://example.com", domain: "example.com" });
    await saveLink(env.DB, site.id, { gscProperty: "sc-domain:example.com", ga4Property: "12345" }, T.toISOString());
    await env.DB.prepare(`UPDATE sites SET domain = NULL WHERE id = ?`).bind(site.id).run();
    const g = google();
    await expect(linkSite(e, site.id, { gscProperty: "sc-domain:example.com" }, T, g.f)).rejects.toThrow("Set the site's domain first.");
    await expect(linkSite(e, site.id, { ga4Property: "12345" }, T, g.f)).rejects.toThrow("Set the site's domain first.");
    expect(await linkSite(e, site.id, { gscProperty: null, ga4Property: null }, T, g.f)).toMatchObject({ gscProperty: null, ga4Property: null });
    expect(g.calls).toHaveLength(0);
  });

  it("with null clears that one key only", async () => {
    await connect();
    const siteId = await siteOn("example.com");
    await linkSite(e, siteId, { gscProperty: "sc-domain:example.com", ga4Property: "12345" }, T, google({ streams: { "12345": ["example.com"] } }).f);
    const g = google();
    const link = await linkSite(e, siteId, { ga4Property: null }, T, g.f);
    expect(link).toMatchObject({ gscProperty: "sc-domain:example.com", ga4Property: null });
    expect(g.calls).toHaveLength(0);
    expect((await linkSite(e, siteId, {}, T, g.f)).gscProperty).toBe("sc-domain:example.com");
  });

  it("logs traffic_linked on a change and not when nothing changed", async () => {
    const s = await seedClient({ site: false });
    const { site } = await createSite(env.DB, { businessId: s.businessId, url: "https://example.com", domain: "example.com" });
    const kinds = async () => (await listActivity(env.DB, s.businessId)).filter((a) => a.kind === "traffic_linked");
    await linkSite(e, site.id, { gscProperty: "sc-domain:example.com" }, T, google().f);
    expect(await kinds()).toHaveLength(1);
    await linkSite(e, site.id, { gscProperty: "sc-domain:example.com" }, T, google().f);
    expect(await kinds()).toHaveLength(1);
    await linkSite(e, site.id, { gscProperty: null }, T, google().f);
    expect(await kinds()).toHaveLength(2);
  });
});

describe("the link routes", () => {
  const ctx = () => createExecutionContext();
  let cookie = "";
  async function call(method: string, path: string, body?: unknown, session = true) {
    if (session && !cookie) {
      const login = await worker.fetch(new Request("https://x/api/login", { method: "POST", body: JSON.stringify({ password: "test-pass" }), headers: { "content-type": "application/json" } }), E, ctx());
      cookie = login.headers.get("set-cookie")!.split(";")[0];
    }
    return worker.fetch(new Request(`https://x/api/traffic${path}`, {
      method, body: body === undefined ? undefined : JSON.stringify(body), headers: { ...(session ? { cookie } : {}), "content-type": "application/json" },
    }), e, ctx());
  }

  it("PUT link without a session is 401", async () => {
    const siteId = await siteOn("example.com");
    expect((await call("PUT", `/site/${siteId}/link`, { gscProperty: "sc-domain:example.com" }, false)).status).toBe(401);
    expect((await call("POST", `/site/${siteId}/find`, undefined, false)).status).toBe(401);
    expect((await call("DELETE", `/site/${siteId}/link`, undefined, false)).status).toBe(401);
    expect(await getLink(env.DB, siteId)).toBeNull();
  });

  it("PUT link links the site and answers the link", async () => {
    const siteId = await siteOn("example.com");
    const r = await call("PUT", `/site/${siteId}/link`, { gscProperty: "sc-domain:example.com" });
    expect(r.status).toBe(200);
    expect(await r.json()).toMatchObject({ siteId, gscProperty: "sc-domain:example.com", ga4Property: null });
  });

  it("PUT link takes a Business Profile location: refused with 409 and its sentence without the permission, saved with it, and cleared by null", async () => {
    const siteId = await siteOn("example.com");
    await connect();
    const without = await call("PUT", `/site/${siteId}/link`, { gbpLocation: "locations/1234567890" });
    expect(without.status).toBe(409);
    expect(await without.json()).toEqual({ error: "Reconnect Google with the Business Profile permission." });
    expect((await call("PUT", `/site/${siteId}/link`, { gbpLocation: "1234567890" })).status).toBe(409);
    await env.DB.prepare(`DELETE FROM google_auth`).run();
    await saveGoogleAuth(env.DB, "me@x.test", await encryptSecret(env.SESSION_SECRET, "refresh-1"), `${SCOPE} https://www.googleapis.com/auth/business.manage`);
    const r = await call("PUT", `/site/${siteId}/link`, { gbpLocation: "locations/1234567890" });
    expect(r.status).toBe(200);
    expect(await r.json()).toMatchObject({ siteId, gscProperty: null, ga4Property: null, gbpLocation: "locations/1234567890" });
    expect(await (await call("PUT", `/site/${siteId}/link`, { gbpLocation: null })).json()).toMatchObject({ gbpLocation: null });
    expect((await call("PUT", `/site/${siteId}/link`, { gbpLocation: 5 })).status).toBe(400);
  });

  it("PUT link refuses another site's property with 409 and its sentence", async () => {
    const siteId = await siteOn("example.com");
    const r = await call("PUT", `/site/${siteId}/link`, { gscProperty: "sc-domain:other.com" });
    expect(r.status).toBe(409);
    expect(await r.json()).toEqual({ error: "That property is for another site." });
  });

  it("PUT link on an archived site is 404, and so is an unknown one", async () => {
    const siteId = await siteOn("example.com");
    await archiveSite(env.DB, siteId, NOW.toISOString());
    expect((await call("PUT", `/site/${siteId}/link`, { gscProperty: "sc-domain:example.com" })).status).toBe(404);
    expect((await call("POST", `/site/${siteId}/find`)).status).toBe(404);
    expect((await call("DELETE", `/site/${siteId}/link`)).status).toBe(404);
    expect((await call("PUT", `/site/nope/link`, {})).status).toBe(404);
    expect(await getLink(env.DB, siteId)).toBeNull();
  });

  it("PUT link with a wrong-typed body is 400", async () => {
    const siteId = await siteOn("example.com");
    expect((await call("PUT", `/site/${siteId}/link`, { gscProperty: 5 })).status).toBe(400);
  });

  it("POST find with Google not connected is 409 with the sentence", async () => {
    const siteId = await siteOn("example.com");
    const r = await call("POST", `/site/${siteId}/find`);
    expect(r.status).toBe(409);
    expect(await r.json()).toEqual({ error: "Connect your Google account in Settings first" });
  });

  it("DELETE link and PUT with both null work on a site without a domain, and a string property there is 409", async () => {
    const siteId = await siteOn("example.com");
    await saveLink(env.DB, siteId, { gscProperty: "sc-domain:example.com" }, NOW.toISOString());
    await env.DB.prepare(`UPDATE sites SET domain = NULL WHERE id = ?`).bind(siteId).run();
    const bad = await call("PUT", `/site/${siteId}/link`, { gscProperty: "sc-domain:example.com" });
    expect(bad.status).toBe(409);
    expect(await bad.json()).toEqual({ error: "Set the site's domain first." });
    const cleared = await call("PUT", `/site/${siteId}/link`, { gscProperty: null, ga4Property: null });
    expect(cleared.status).toBe(200);
    expect(await cleared.json()).toMatchObject({ gscProperty: null, ga4Property: null });
    await saveLink(env.DB, siteId, { gscProperty: "sc-domain:example.com" }, NOW.toISOString());
    expect((await call("DELETE", `/site/${siteId}/link`)).status).toBe(204);
    expect(await getLink(env.DB, siteId)).toBeNull();
  });

  it("DELETE link keeps the pulled months", async () => {
    const siteId = await siteOn("example.com");
    await saveLink(env.DB, siteId, { gscProperty: "sc-domain:example.com" }, NOW.toISOString());
    await saveTrafficMonth(env.DB, { siteId, period: "2026-11", status: "ok", facts: { search: { clicks: 10 } } }, NOW.toISOString());
    const r = await call("DELETE", `/site/${siteId}/link`);
    expect(r.status).toBe(204);
    expect(await getLink(env.DB, siteId)).toBeNull();
    expect(await getTrafficMonth(env.DB, siteId, "2026-11")).toMatchObject({ status: "ok", facts: { search: { clicks: 10 } } });
  });
});
