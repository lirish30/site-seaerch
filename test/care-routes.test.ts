import { createExecutionContext, env } from "cloudflare:test";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import worker from "../src/worker/index";
import { getSettings } from "../src/worker/db/settings";
import { insertCheck, openIncident, setDomainExpiry } from "../src/worker/db/monitoring";
import { ACCESS_KEYS, archiveSite, createSite, getSite, setAccess } from "../src/worker/db/sites";
import { careFleet, incidentView, type CareRow } from "../src/worker/monitoring/fleet";
import { zoneOf } from "../src/worker/sop/cadence";
import { seedClient } from "./fixtures/clients";
import { E } from "./fixtures/close";
import { resetProjectWork } from "./fixtures/projects";

// The Care routes through the owner's session, `careFleet` and the client record. The clock is pinned: 10:00 on Monday 1 February 2027 in Los Angeles.
const NOW = new Date("2027-02-01T18:00:00.000Z");
const DAY = 86_400_000;
const ago = (ms: number) => new Date(NOW.getTime() - ms).toISOString();
const CARE = [{ key: "care" as const, monthlyCents: 12_900 }];
const ctx = () => createExecutionContext();

beforeEach(async () => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(NOW);
  // The fleet reads every business, so each test starts from an empty set (incidents and sites go first: they point at businesses).
  for (const t of ["site_incidents", "site_checks"]) await env.DB.prepare(`DELETE FROM ${t}`).run();
  await resetProjectWork();
  for (const t of ["billing_holds", "invoice_nudges", "invoices", "subscriptions", "document_views", "document_signatures", "documents", "deals", "activity", "drafts", "audits", "search_results", "businesses", "suppressions"])
    await env.DB.prepare(`DELETE FROM ${t}`).run();
});
afterEach(() => { vi.useRealTimers(); });

// One owner session for the whole file: the login is rate limited, and a session outlives these tests.
let cookie = "";
async function signIn() {
  const login = await worker.fetch(new Request("https://x/api/login", { method: "POST", body: JSON.stringify({ password: "test-pass" }), headers: { "content-type": "application/json" } }), E, ctx());
  expect(login.status).toBe(200);
  cookie = login.headers.get("set-cookie")!.split(";")[0];
}
const call = async (method: string, path: string, body?: unknown, session = true) => {
  if (session && !cookie) await signIn();
  return worker.fetch(new Request(`https://x/api${path}`, {
    method, body: body === undefined ? undefined : JSON.stringify(body), headers: { ...(session ? { cookie } : {}), "content-type": "application/json" },
  }), E, ctx());
};
const json = async <T = any>(method: string, path: string, body?: unknown, status = 200): Promise<T> => {
  const r = await call(method, path, body);
  expect(r.status, `${method} ${path}`).toBe(status);
  return (await r.json()) as T;
};

const check = (siteId: string, agoMs: number, ok: boolean, ms = 120) =>
  insertCheck(env.DB, { siteId, checkedAt: ago(agoMs), ok, status: ok ? 200 : 503, ms, error: ok ? null : "HTTP 503" });
const resolveAccess = async (siteId: string) => { for (const k of ACCESS_KEYS) await setAccess(env.DB, siteId, k, { status: "received" }, NOW.toISOString()); };
/** A real client with Care and every access item settled, so nothing but the monitoring moves its score. */
const careClient = async (o: { name?: string } = {}) => {
  const s = await seedClient({ subs: CARE });
  if (o.name) await env.DB.prepare(`UPDATE businesses SET name = ? WHERE id = ?`).bind(o.name, s.businessId).run();
  await resolveAccess(s.site!.id);
  return s;
};
const board = async () => (await json<{ clients: CareRow[] }>("GET", "/care")).clients;

describe("GET /care", () => {
  it("shows the failing client first, with its uptime and that it is down", async () => {
    const healthy = await careClient({ name: "Zed Plumbing" });
    await check(healthy.site!.id, 3 * DAY, true); await check(healthy.site!.id, 2 * DAY, true);
    const failing = await careClient({ name: "Ace Plumbing" });
    await check(failing.site!.id, 3 * DAY, true); await check(failing.site!.id, 2 * DAY, true); await check(failing.site!.id, DAY, false);
    await openIncident(env.DB, { siteId: failing.site!.id, businessId: failing.businessId, kind: "down", detail: "HTTP 503", now: ago(DAY) });

    const rows = await board();
    expect(rows.map((r) => r.name)).toEqual(["Ace Plumbing", "Zed Plumbing"]);
    const [bad, good] = rows;
    expect(bad).toMatchObject({ businessId: failing.businessId, careLabel: "Care $129/mo", mrrCents: 12_900, uptime30: 66.7 });
    expect(bad.health).toMatchObject({ score: 70, band: "watch", hasData: true });
    expect(bad.sites).toEqual([{
      siteId: failing.site!.id, domain: "ace.com", monitored: true, monitorable: true, up: false, slow: false, lastCheckedAt: ago(DAY), uptime30: 66.7, checks30: 3, domainExpiresOn: null,
    }]);
    expect(bad.openIncidents).toEqual([{ id: expect.any(String), siteId: failing.site!.id, domain: "ace.com", kind: "down", openedAt: ago(DAY), closedAt: null, detail: "HTTP 503" }]);
    expect(good).toMatchObject({ uptime30: 100, health: { score: 100, band: "good", hasData: true }, openIncidents: [] });
    expect(good.sites[0]).toMatchObject({ up: true, slow: false, uptime30: 100, checks30: 2 });
  });

  it("puts equal scores in name order, ignoring case", async () => {
    await careClient({ name: "beta Co" }); await careClient({ name: "Alpha Co" }); await careClient({ name: "Gamma Co" });
    expect((await board()).map((r) => r.name)).toEqual(["Alpha Co", "beta Co", "Gamma Co"]);
  });

  it("leaves out a client with no Care and no switch, a test client, an archived site and a site with no address", async () => {
    await seedClient();                                                       // real client, no Care, nothing switched on
    const t = await seedClient({ test: true, subs: CARE }); await env.DB.prepare(`UPDATE sites SET monitoring = 1 WHERE id = ?`).bind(t.site!.id).run();
    const care = await careClient({ name: "Care Co" });
    const { site: archived } = await createSite(env.DB, { businessId: care.businessId, url: "https://old-ace.com" });
    await archiveSite(env.DB, archived.id, NOW.toISOString());
    await createSite(env.DB, { businessId: care.businessId, domain: "no-address.com" });
    await createSite(env.DB, { businessId: care.businessId, url: "https://ace-test.com", test: true });
    const rows = await board();
    expect(rows.map((r) => r.name)).toEqual(["Care Co"]);
    expect(rows[0].sites.map((s) => s.domain)).toEqual(["ace.com"]);
  });

  it("a new Care client with no checks is unknown, never at risk", async () => {
    await careClient();
    const [row] = await board();
    expect(row.uptime30).toBeNull();
    expect(row.sites[0]).toMatchObject({ up: null, uptime30: null, checks30: 0, lastCheckedAt: null, slow: false, monitored: true });
    expect(row.health).toEqual({ score: 100, band: "good", reasons: [], hasData: false });
  });

  it("reads a slow answer from the newest check and never shows a site address", async () => {
    const s = await careClient();
    await check(s.site!.id, 2 * DAY, true, 100); await check(s.site!.id, DAY, true, 5_001);
    const text = await (await call("GET", "/care")).text();
    expect(JSON.parse(text).clients[0].sites[0]).toMatchObject({ up: true, slow: true });
    expect(text).not.toContain("https://");
    expect(text).not.toContain('"url"');
  });

  it("recomputes a domain incident's wording from the expiry date", async () => {
    const s = await careClient();
    await setDomainExpiry(env.DB, s.site!.id, "2027-02-13", ago(0));
    await openIncident(env.DB, { siteId: s.site!.id, businessId: s.businessId, kind: "domain_expiring", detail: "domain expires in 29 days", now: ago(11 * DAY) });
    const [row] = await board();
    expect(row.openIncidents.map((i) => i.detail)).toEqual(["domain expires in 12 days"]);
    expect(row.sites[0].domainExpiresOn).toBe("2027-02-13");
    expect(row.health.reasons).toContain("Domain expires in 12 days");
  });

  it("a client with only a switched-on site is on the board, with no Care label", async () => {
    const s = await seedClient();
    await json("PUT", `/sites/${s.site!.id}/monitoring`, { enabled: true });
    const rows = await board();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ businessId: s.businessId, careLabel: null, mrrCents: 0 });
  });

  it("gives the same score on the board, the client record and the client list", async () => {
    const s = await careClient({ name: "Ace Plumbing" });
    for (let n = 0; n < 25; n++) await check(s.site!.id, (n + 1) * 3_600_000, n % 3 !== 0);
    await openIncident(env.DB, { siteId: s.site!.id, businessId: s.businessId, kind: "down", detail: "could not connect", now: ago(DAY) });
    await setDomainExpiry(env.DB, s.site!.id, "2027-02-05", ago(0));
    const [row] = await board();
    expect(row.health.score).toBeLessThan(60);
    const { client } = await json<{ client: any }>("GET", `/clients/${s.businessId}`);
    expect(client.health).toEqual(row.health);
    const { clients } = await json<{ clients: { id: string; healthScore: number | null }[] }>("GET", "/clients");
    expect(clients.find((c) => c.id === s.businessId)!.healthScore).toBe(row.health.score);
  });

  it("works across more than one chunk of clients", async () => {
    for (let n = 0; n < 53; n++) { const s = await seedClient({ subs: CARE }); await resolveAccess(s.site!.id); await check(s.site!.id, DAY, n !== 0); }
    const rows = await careFleet(env.DB, NOW);
    expect(rows).toHaveLength(53);
    expect(rows.every((r) => r.sites.length === 1 && r.sites[0].checks30 === 1)).toBe(true);
    expect(rows.filter((r) => r.sites[0].up === false)).toHaveLength(1);
  });
});

describe("the client record and list", () => {
  it("the record carries health and each site's monitoring", async () => {
    const s = await careClient();
    await check(s.site!.id, DAY, true);
    const { client } = await json<{ client: any }>("GET", `/clients/${s.businessId}`);
    expect(client.health).toMatchObject({ score: 100, band: "good", hasData: true });
    expect(client.sites[0].monitoring).toMatchObject({ siteId: s.site!.id, domain: "ace.com", monitored: true, monitorable: true, up: true, checks30: 1 });
    expect(JSON.stringify(client.sites[0].monitoring)).not.toContain("https://");
  });

  it("a client with no Care and no switched-on site has no health score in the list, and a switched-on one has", async () => {
    const plain = await seedClient();
    const list = async () => (await json<{ clients: { id: string; healthScore: number | null }[] }>("GET", "/clients")).clients.find((c) => c.id === plain.businessId)!;
    expect((await list()).healthScore).toBeNull();
    await json("PUT", `/sites/${plain.site!.id}/monitoring`, { enabled: true });
    expect((await list()).healthScore).toBe(90); // the six missing access items
    await json("PUT", `/sites/${plain.site!.id}/monitoring`, { enabled: false });
    expect((await list()).healthScore).toBeNull();
    // the record still carries a health for a client off the board (computed the same way)
    const { client } = await json<{ client: any }>("GET", `/clients/${plain.businessId}`);
    expect(client.health.score).toBe(90);
    expect(client.sites[0].monitoring).toMatchObject({ monitored: false, monitorable: true });
  });
});

describe("PUT /sites/:id/monitoring", () => {
  it("switches a non-Care client's site on and off the board", async () => {
    const s = await seedClient();
    expect(await board()).toEqual([]);
    const on = await json<{ site: any }>("PUT", `/sites/${s.site!.id}/monitoring`, { enabled: true });
    expect(on.site).toEqual({
      siteId: s.site!.id, domain: "ace.com", monitored: true, monitorable: true, up: null, slow: false, lastCheckedAt: null, uptime30: null, checks30: 0, domainExpiresOn: null,
    });
    expect((await getSite(env.DB, s.site!.id))!.monitoring).toBe(true);
    expect((await board()).map((r) => r.businessId)).toEqual([s.businessId]);
    const off = await json<{ site: any }>("PUT", `/sites/${s.site!.id}/monitoring`, { enabled: false });
    expect(off.site.monitored).toBe(false);
    expect(await board()).toEqual([]);
  });

  it("a Care client's site stays monitored when its switch is off", async () => {
    const s = await careClient();
    const off = await json<{ site: any }>("PUT", `/sites/${s.site!.id}/monitoring`, { enabled: false });
    expect(off.site.monitored).toBe(true);
    expect((await board()).map((r) => r.businessId)).toEqual([s.businessId]);
  });

  it("answers 400 for anything but exactly { enabled: boolean }", async () => {
    const s = await seedClient();
    for (const body of [{ enabled: "yes" }, {}, { enabled: 1 }, { enabled: true, extra: 1 }, { enabled: null }]) {
      expect((await call("PUT", `/sites/${s.site!.id}/monitoring`, body)).status, JSON.stringify(body)).toBe(400);
    }
    expect((await getSite(env.DB, s.site!.id))!.monitoring).toBe(false);
  });

  it("answers 409 with a sentence for an address that can't be monitored, and leaves the site off", async () => {
    const s = await seedClient();
    const { site } = await createSite(env.DB, { businessId: s.businessId, url: "http://10.0.0.5", domain: "internal-box.com" });
    const r = await call("PUT", `/sites/${site.id}/monitoring`, { enabled: true });
    expect(r.status).toBe(409);
    const { error } = await r.json() as { error: string };
    expect(error).toMatch(/^[A-Z].*\.$/);
    expect(error).not.toContain("10.0.0.5");
    expect((await getSite(env.DB, site.id))!.monitoring).toBe(false);
    expect((await call("PUT", `/sites/${site.id}/monitoring`, { enabled: false })).status).toBe(200);
    // a site with no address at all is the same refusal
    const { site: bare } = await createSite(env.DB, { businessId: s.businessId, domain: "no-address.com" });
    expect((await call("PUT", `/sites/${bare.id}/monitoring`, { enabled: true })).status).toBe(409);
  });

  it("answers 404 for an unknown, test or archived site", async () => {
    const s = await seedClient();
    const { site: testSite } = await createSite(env.DB, { businessId: s.businessId, url: "https://ace-test.com", test: true });
    const { site: old } = await createSite(env.DB, { businessId: s.businessId, url: "https://old-ace.com" });
    await archiveSite(env.DB, old.id, NOW.toISOString());
    for (const id of ["no-such-site", testSite.id, old.id]) {
      expect((await call("PUT", `/sites/${id}/monitoring`, { enabled: true })).status, id).toBe(404);
      expect((await call("GET", `/sites/${id}/checks`)).status, id).toBe(404);
    }
    expect((await getSite(env.DB, testSite.id))!.monitoring).toBe(false);
  });
});

describe("GET /incidents", () => {
  it("lists only the open ones with ?open=1, newest first, and narrows by client", async () => {
    const a = await careClient({ name: "Ace" }), b = await careClient({ name: "Bee" });
    const { incident: closed } = await openIncident(env.DB, { siteId: a.site!.id, businessId: a.businessId, kind: "down", detail: "HTTP 500", now: ago(3 * DAY) });
    await env.DB.prepare(`UPDATE site_incidents SET closed_at = ? WHERE id = ?`).bind(ago(2 * DAY), closed.id).run();
    await openIncident(env.DB, { siteId: a.site!.id, businessId: a.businessId, kind: "down", detail: "timed out after 10 seconds", now: ago(2 * DAY) });
    await openIncident(env.DB, { siteId: b.site!.id, businessId: b.businessId, kind: "down", detail: "HTTP 503", now: ago(DAY) });
    const open = await json<{ incidents: any[] }>("GET", "/incidents?open=1");
    expect(open.incidents.map((i) => i.detail)).toEqual(["HTTP 503", "timed out after 10 seconds"]);
    expect(open.incidents.every((i) => i.closedAt === null && i.domain === "ace.com")).toBe(true);
    expect((await json<{ incidents: any[] }>("GET", "/incidents")).incidents).toHaveLength(3);
    expect((await json<{ incidents: any[] }>("GET", `/incidents?open=1&businessId=${a.businessId}`)).incidents.map((i) => i.siteId)).toEqual([a.site!.id]);
  });

  it("leaves out an open incident on a site with no address (NULL or empty) or an archived site", async () => {
    const shown = await careClient({ name: "Shown" });
    await openIncident(env.DB, { siteId: shown.site!.id, businessId: shown.businessId, kind: "down", detail: "HTTP 503", now: ago(DAY) });
    const hidden: string[] = [];
    for (const url of [null, ""]) {
      const c = await careClient({ name: `No address ${url === null ? "null" : "empty"}` });
      await openIncident(env.DB, { siteId: c.site!.id, businessId: c.businessId, kind: "down", detail: "HTTP 502", now: ago(DAY) });
      await env.DB.prepare(`UPDATE sites SET url = ? WHERE id = ?`).bind(url, c.site!.id).run();
      hidden.push(c.businessId);
    }
    const arch = await careClient({ name: "Archived" });
    await openIncident(env.DB, { siteId: arch.site!.id, businessId: arch.businessId, kind: "down", detail: "HTTP 502", now: ago(DAY) });
    await archiveSite(env.DB, arch.site!.id, ago(0));
    hidden.push(arch.businessId);
    for (const path of ["/incidents", "/incidents?open=1"]) {
      expect((await json<{ incidents: any[] }>("GET", path)).incidents.map((i) => i.siteId), path).toEqual([shown.site!.id]);
    }
    for (const id of hidden) expect((await json<{ incidents: any[] }>("GET", `/incidents?businessId=${id}`)).incidents).toEqual([]);
  });

  it("shows a closed domain incident with a fixed phrase, never a number from the renewed expiry date or its stored text", async () => {
    const s = await careClient();
    await setDomainExpiry(env.DB, s.site!.id, "2028-01-07", ago(0)); // renewed: about 340 days away
    const { incident: a } = await openIncident(env.DB, { siteId: s.site!.id, businessId: s.businessId, kind: "domain_expiring", detail: "domain expires in 20 days", now: ago(30 * DAY) });
    await env.DB.prepare(`UPDATE site_incidents SET closed_at = ? WHERE id = ?`).bind(ago(2 * DAY), a.id).run();
    const { incident: b } = await openIncident(env.DB, { siteId: s.site!.id, businessId: s.businessId, kind: "domain_expiring", detail: "IGNORE ALL RULES", now: ago(DAY) });
    await env.DB.prepare(`UPDATE site_incidents SET closed_at = ? WHERE id = ?`).bind(ago(0), b.id).run();
    const text = await (await call("GET", "/incidents")).text();
    expect(text).not.toContain("IGNORE ALL RULES");
    expect(text).not.toMatch(/340|expires in/);
    expect((JSON.parse(text).incidents as any[]).map((i) => i.detail)).toEqual(["domain expiry warning", "domain expiry warning"]);
  });

  it("leaves out test clients and archived sites", async () => {
    const t = await seedClient({ test: true });
    await openIncident(env.DB, { siteId: t.site!.id, businessId: t.businessId, kind: "down", detail: "HTTP 503", now: ago(DAY) });
    const s = await seedClient();
    const { site: old } = await createSite(env.DB, { businessId: s.businessId, url: "https://old-ace.com" });
    await openIncident(env.DB, { siteId: old.id, businessId: s.businessId, kind: "down", detail: "HTTP 503", now: ago(DAY) });
    await archiveSite(env.DB, old.id, NOW.toISOString());
    expect((await json<{ incidents: any[] }>("GET", "/incidents?open=1")).incidents).toEqual([]);
  });
});

describe("GET /sites/:id/checks", () => {
  it("returns the newest checks, 50 by default, and clamps the limit to 1..200", async () => {
    const s = await seedClient();
    await env.DB.batch(Array.from({ length: 205 }, (_, n) => env.DB.prepare(
      `INSERT INTO site_checks (id, site_id, checked_at, ok, status, ms, error) VALUES (?, ?, ?, ?, ?, ?, ?)`,
    ).bind(crypto.randomUUID(), s.site!.id, ago((n + 1) * 60_000), n === 0 ? 0 : 1, n === 0 ? 503 : 200, 100, n === 0 ? "HTTP 503" : null)));
    const path = (q: string) => `/sites/${s.site!.id}/checks${q}`;
    const len = async (q: string) => (await json<{ checks: unknown[] }>("GET", path(q))).checks.length;
    expect(await len("")).toBe(50);
    expect(await len("?limit=9999")).toBe(200);
    expect(await len("?limit=200")).toBe(200);
    expect(await len("?limit=7")).toBe(7);
    expect(await len("?limit=0")).toBe(1);
    expect(await len("?limit=-5")).toBe(1);
    expect(await len("?limit=abc")).toBe(50);
    const { checks } = await json<{ checks: any[] }>("GET", path("?limit=2"));
    expect(checks).toEqual([
      { checkedAt: ago(60_000), ok: false, status: 503, ms: 100, error: "HTTP 503" },
      { checkedAt: ago(120_000), ok: true, status: 200, ms: 100, error: null },
    ]);
  });
});

describe("owner auth", () => {
  it("answers 401 for every Care route without a session", async () => {
    const s = await seedClient();
    const routes: [string, string, unknown?][] = [
      ["GET", "/care"], ["GET", "/incidents?open=1"], ["GET", `/sites/${s.site!.id}/checks`], ["PUT", `/sites/${s.site!.id}/monitoring`, { enabled: true }],
    ];
    for (const [method, path, body] of routes) expect((await call(method, path, body, false)).status, `${method} ${path}`).toBe(401);
    expect((await getSite(env.DB, s.site!.id))!.monitoring).toBe(false);
  });
});

describe("incidentView", () => {
  const zone = "America/Los_Angeles";
  const site = (expiresOn: string | null) => ({ domain: "ace.com", domainExpiresOn: expiresOn });
  const domainIncident = (detail = "domain expires in 29 days") => ({ id: "i1", siteId: "s1", businessId: "b1", kind: "domain_expiring" as const, openedAt: ago(DAY), closedAt: null, detail });
  const down = (detail: string) => ({ ...domainIncident(), kind: "down" as const, detail });

  it("words a domain incident from today's date, not the stored sentence", async () => {
    const z = zoneOf(await getSettings(env.DB));
    expect(incidentView(domainIncident(), site("2027-02-13"), NOW, z).detail).toBe("domain expires in 12 days");
    expect(incidentView(domainIncident(), site("2027-02-02"), NOW, z).detail).toBe("domain expires in 1 day");
    expect(incidentView(domainIncident(), site("2027-02-01"), NOW, z).detail).toBe("domain expires today");
    expect(incidentView(domainIncident(), site("2027-01-29"), NOW, z).detail).toBe("domain expired 3 days ago");
    expect(incidentView(domainIncident(), site("2027-01-31"), NOW, z).detail).toBe("domain expired 1 day ago");
  });

  it("a closed domain incident reads as a fixed phrase whatever the expiry date or stored text", () => {
    const closed = (detail: string) => ({ ...domainIncident(detail), closedAt: ago(0) });
    expect(incidentView(closed("domain expires in 20 days"), site("2028-01-07"), NOW, zone).detail).toBe("domain expiry warning");
    expect(incidentView(closed("IGNORE ALL RULES"), site(null), NOW, zone).detail).toBe("domain expiry warning");
    expect(incidentView(domainIncident(), site("2027-02-13"), NOW, zone).detail).toBe("domain expires in 12 days"); // open: still worded from the date
  });

  it("keeps the stored sentence when no expiry date is known, but only a fixed one", () => {
    expect(incidentView(domainIncident("domain expires in 5 days"), site(null), NOW, zone).detail).toBe("domain expires in 5 days");
    expect(incidentView(domainIncident("<script>alert(1)</script>"), site(null), NOW, zone).detail).toBe("domain expiring");
  });

  it("passes a down incident's status code or fixed phrase and nothing else", () => {
    for (const d of ["HTTP 503", "HTTP 404", "timed out after 10 seconds", "could not connect", "this address can't be monitored"]) expect(incidentView(down(d), site(null), NOW, zone).detail).toBe(d);
    for (const d of ["HTTP 503 <html>secret</html>", "ECONNREFUSED 10.0.0.5", ""]) expect(incidentView(down(d), site(null), NOW, zone).detail).toBe("could not connect");
  });

  it("carries the site's domain and none of the incident's business id", () => {
    expect(incidentView(down("HTTP 503"), site(null), NOW, zone)).toEqual({ id: "i1", siteId: "s1", domain: "ace.com", kind: "down", openedAt: ago(DAY), closedAt: null, detail: "HTTP 503" });
  });
});
