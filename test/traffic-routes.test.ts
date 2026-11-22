import { SELF, env } from "cloudflare:test";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { saveGoogleAuth } from "../src/worker/db/google";
import { saveLink, saveTrafficMonth } from "../src/worker/db/traffic";
import { encryptSecret } from "../src/worker/google/crypto";
import { seedClient } from "./fixtures/clients";
import { resetProjectWork } from "./fixtures/projects";

// The Traffic panel's read route: GET /api/clients/:id/traffic (Plan 16, Task 8). The owner sees the connection, each site's linked properties and the last six months pulled, newest first.
const NOW = new Date("2026-12-10T18:00:00.000Z");
const SCOPE = "openid email https://www.googleapis.com/auth/webmasters.readonly https://www.googleapis.com/auth/analytics.readonly";
const GSC = "sc-domain:ace.com";
const GA4 = "123456789";

let cookie = "";
beforeAll(async () => {
  const r = await SELF.fetch("https://x/api/login", { method: "POST", body: JSON.stringify({ password: "test-pass" }), headers: { "content-type": "application/json" } });
  cookie = r.headers.get("set-cookie")!.split(";")[0];
});
beforeEach(async () => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(NOW);
  for (const t of ["traffic_months", "site_analytics", "google_auth"]) await env.DB.prepare(`DELETE FROM ${t}`).run();
  await resetProjectWork();
  for (const t of ["billing_holds", "invoice_nudges", "invoices", "subscriptions", "document_views", "document_signatures", "documents", "deals", "activity", "drafts", "audits", "search_results", "businesses", "suppressions"])
    await env.DB.prepare(`DELETE FROM ${t}`).run();
});
const get = (id: string, auth = true) => SELF.fetch(`https://x/api/clients/${id}/traffic`, { headers: auth ? { cookie } : {} });
const connect = async (scope = SCOPE) => saveGoogleAuth(env.DB, "me@x.test", await encryptSecret(env.SESSION_SECRET, "refresh-1"), scope);

const facts = (o: { clicks?: number; sessions?: number | null } = {}) => ({
  version: 1, period: "2026-11",
  search: o.clicks === undefined ? null : { clicks: o.clicks, impressions: o.clicks * 10, position: 4.2, previousClicks: 1, previousImpressions: 2, queries: [{ query: "plumber near me", clicks: 3, impressions: 9 }], pages: [{ path: "/a", clicks: 2 }] },
  visits: o.sessions == null ? null : { sessions: o.sessions, users: 5, organic: 2, keyEvents: null, previousSessions: null, previousOrganic: null, channels: [] },
  profile: null,
});

describe("GET /api/clients/:id/traffic", () => {
  it("returns six months newest first and no property secrets beyond the ids shown to the owner", async () => {
    await connect();
    const s = await seedClient();
    await saveLink(env.DB, s.site!.id, { gscProperty: GSC, ga4Property: GA4 }, "2026-10-01T00:00:00.000Z");
    // Eight months pulled; the panel shows the six that ended last (2026-11 back to 2026-06). One failed month and one ok month that carries a leftover retry sentence.
    for (const [period, status, error] of [
      ["2026-11", "ok", "An old sentence from a merged retry."], ["2026-10", "partial", "Google did not answer. It will be tried again tomorrow."], ["2026-09", "failed", "Google no longer accepts the connection. Reconnect Google in Settings."],
      ["2026-08", "ok", ""], ["2026-07", "ok", ""], ["2026-06", "ok", ""], ["2026-05", "ok", ""], ["2026-04", "ok", ""],
    ] as const) await saveTrafficMonth(env.DB, { siteId: s.site!.id, period, status, facts: facts({ clicks: 7, sessions: 11 }), error }, "2026-12-04T00:00:00.000Z");
    await env.DB.prepare(`UPDATE site_analytics SET last_error = ? WHERE site_id = ?`).bind("Google did not answer. It will be tried again tomorrow.", s.site!.id).run();

    const r = await get(s.businessId);
    expect(r.status).toBe(200);
    const body = (await r.json()) as any;
    expect(body).toMatchObject({ connected: true, hasScopes: true, hasProfileScope: false, email: "me@x.test" });
    expect(body.sites).toHaveLength(1);
    const site = body.sites[0];
    expect(site).toMatchObject({ siteId: s.site!.id, domain: "ace.com", gscProperty: GSC, ga4Property: GA4, gbpLocation: null, lastError: "Google did not answer. It will be tried again tomorrow." });
    expect(site.months.map((m: any) => m.period)).toEqual(["2026-11", "2026-10", "2026-09", "2026-08", "2026-07", "2026-06"]);
    expect(site.months[0]).toEqual({ period: "2026-11", status: "ok", pulledAt: "2026-12-04T00:00:00.000Z", error: "", search: { clicks: 7, impressions: 70 }, visits: { sessions: 11 }, profile: null });
    expect(site.months[1].error).toBe("Google did not answer. It will be tried again tomorrow.");
    expect(site.months[2]).toMatchObject({ status: "failed", error: "Google no longer accepts the connection. Reconnect Google in Settings." });
    // Nothing else of the stored facts is sent: not the queries, the pages, nor a token.
    const text = JSON.stringify(body);
    for (const leak of ["plumber near me", "refresh-1", "refresh_token"]) expect(text).not.toContain(leak);
    expect(text).not.toContain('"/a"');
    expect(site.months.every((m: any) => Object.keys(m).sort().join() === "error,period,profile,pulledAt,search,status,visits")).toBe(true);
  });

  it("shows a month with a block that was not measured as null, and a site with no link as null properties and no months", async () => {
    await connect();
    const s = await seedClient();
    const r = await get(s.businessId);
    expect(((await r.json()) as any).sites).toEqual([{ siteId: s.site!.id, domain: "ace.com", gscProperty: null, ga4Property: null, gbpLocation: null, lastError: "", months: [] }]);
    await saveLink(env.DB, s.site!.id, { gscProperty: GSC }, "2026-10-01T00:00:00.000Z");
    await saveTrafficMonth(env.DB, { siteId: s.site!.id, period: "2026-11", status: "ok", facts: facts({ clicks: 0 }) }, "2026-12-04T00:00:00.000Z");
    const m = ((await (await get(s.businessId)).json()) as any).sites[0].months[0];
    expect(m.search).toEqual({ clicks: 0, impressions: 0 });
    expect(m.visits).toBeNull();
  });

  it("shows the Business Profile location and whether the permission was granted, and only the call count of a month's profile", async () => {
    await connect(`${SCOPE} https://www.googleapis.com/auth/business.manage`);
    const s = await seedClient();
    await saveLink(env.DB, s.site!.id, { gbpLocation: "locations/1234567890" }, "2026-10-01T00:00:00.000Z");
    await saveTrafficMonth(env.DB, { siteId: s.site!.id, period: "2026-11", status: "ok", facts: { ...facts({}), profile: { calls: 12, directions: 9, websiteClicks: 30, previousCalls: 8 } } }, "2026-12-04T00:00:00.000Z");
    const body = (await (await get(s.businessId)).json()) as any;
    expect(body).toMatchObject({ connected: true, hasScopes: true, hasProfileScope: true });
    expect(body.sites[0]).toMatchObject({ gbpLocation: "locations/1234567890", gscProperty: null, ga4Property: null });
    expect(body.sites[0].months[0]).toEqual({ period: "2026-11", status: "ok", pulledAt: "2026-12-04T00:00:00.000Z", error: "", search: null, visits: null, profile: { calls: 12 } });
    expect(JSON.stringify(body.sites[0].months)).not.toMatch(/directions|websiteClicks/);
  });

  it("GET traffic for a lead is 404", async () => {
    const s = await seedClient({ won: false, project: false });
    expect((await get(s.businessId)).status).toBe(404);
    expect((await get("nope")).status).toBe(404);
  });

  it("GET traffic needs a session", async () => {
    const s = await seedClient();
    expect((await get(s.businessId, false)).status).toBe(401);
  });

  it("GET traffic with Google not connected has connected false", async () => {
    const s = await seedClient();
    const body = (await (await get(s.businessId)).json()) as any;
    expect(body).toMatchObject({ connected: false, hasScopes: false, email: null });
    expect(body.sites).toHaveLength(1);
  });

  it("GET traffic with only one traffic scope granted has hasScopes false", async () => {
    await connect("openid email https://www.googleapis.com/auth/webmasters.readonly");
    const s = await seedClient();
    expect(await (await get(s.businessId)).json()).toMatchObject({ connected: true, hasScopes: false, email: "me@x.test" });
  });

  it("GET traffic leaves archived sites out", async () => {
    await connect();
    const s = await seedClient();
    await env.DB.prepare(`UPDATE sites SET archived_at = ? WHERE id = ?`).bind("2026-12-01T00:00:00.000Z", s.site!.id).run();
    expect(((await (await get(s.businessId)).json()) as any).sites).toEqual([]);
  });
});
