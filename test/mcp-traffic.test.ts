import { env } from "cloudflare:test";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { saveGoogleAuth } from "../src/worker/db/google";
import { saveLink, saveTrafficMonth } from "../src/worker/db/traffic";
import { encryptSecret } from "../src/worker/google/crypto";
import { actionCount, mcp, ok, tool } from "./fixtures/mcp";
import { seedClient } from "./fixtures/clients";
import { resetProjectWork } from "./fixtures/projects";

// The read-only traffic tool through the MCP route (Plan 16, Task 8): per real client with a linked site, the month's merged numbers and each site's status; never a property id, a token, a Google error body, a
// search query or page path, or a rehearsal client.
const NOW = new Date("2026-12-10T18:00:00.000Z");
const GSC = "sc-domain:SECRET-GSC-PROPERTY.com";
const GA4 = "987654321";
const SPOKEN = "Google says me@x.test can't read this one. Ask the client to add me@x.test as a viewer, then it will be tried again tomorrow.";

beforeEach(async () => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(NOW);
  for (const t of ["traffic_months", "site_analytics", "google_auth", "agent_actions"]) await env.DB.prepare(`DELETE FROM ${t}`).run();
  await resetProjectWork();
  for (const t of ["billing_holds", "invoice_nudges", "invoices", "subscriptions", "document_views", "document_signatures", "documents", "deals", "activity", "drafts", "audits", "search_results", "businesses", "suppressions"])
    await env.DB.prepare(`DELETE FROM ${t}`).run();
  await saveGoogleAuth(env.DB, "me@x.test", await encryptSecret(env.SESSION_SECRET, "refresh-1"), "openid email");
});

const facts = (o: { clicks?: number; sessions?: number } = {}) => ({
  version: 1, period: "2026-11",
  search: o.clicks === undefined ? null : { clicks: o.clicks, impressions: o.clicks * 10, position: 4.2, previousClicks: 1, previousImpressions: 2, queries: [{ query: "QUERY-SENTINEL", clicks: 3, impressions: 9 }], pages: [{ path: "/PATH-SENTINEL", clicks: 2 }] },
  visits: o.sessions === undefined ? null : { sessions: o.sessions, users: 5, organic: 2, keyEvents: null, previousSessions: 3, previousOrganic: null, channels: [{ channel: "CHANNEL-SENTINEL", sessions: 4 }] },
  profile: null,
});

async function linked(name: string, o: { test?: boolean; period?: string; status?: "ok" | "partial" | "failed"; error?: string; facts?: unknown; link?: boolean } = {}) {
  const s = await seedClient({ test: o.test });
  await env.DB.prepare(`UPDATE businesses SET name = ? WHERE id = ?`).bind(name, s.businessId).run();
  if (o.link !== false) await saveLink(env.DB, s.site!.id, { gscProperty: GSC, ga4Property: GA4 }, "2026-10-01T00:00:00.000Z");
  if (o.facts !== null) await saveTrafficMonth(env.DB, { siteId: s.site!.id, period: o.period ?? "2026-11", status: o.status ?? "ok", facts: o.facts ?? facts({ clicks: 7, sessions: 11 }), error: o.error ?? "" }, "2026-12-04T00:00:00.000Z");
  return s;
}

type Answer = { period: string; clients: { clientId: string; client: string; traffic: any; sites: { domain: string | null; status: string | null; error: string }[] }[] };

describe("the tool", () => {
  it("is registered", async () => {
    const names = (await mcp("tools/list", {})).result.tools.map((t: { name: string }) => t.name);
    expect(names).toContain("get_traffic");
  });

  it("the server registers 33 tools", async () => {
    expect((await mcp("tools/list", {})).result.tools).toHaveLength(33);
  });
});

describe("get_traffic", () => {
  it("gives each client's month as counts only with each site's status, ordered by client name, for last month by default", async () => {
    const b = await linked("Bay Roofing", { facts: facts({ clicks: 1 }) });
    const a = await linked("Ace Plumbing");
    const out = await ok<Answer>("get_traffic", {});
    expect(out.period).toBe("2026-11");
    expect(out.clients.map((c) => c.client)).toEqual(["Ace Plumbing", "Bay Roofing"]);
    expect(out.clients[0]).toEqual({
      clientId: a.businessId, client: "Ace Plumbing",
      traffic: {
        search: { clicks: 7, impressions: 70, position: 4.2, previousClicks: 1, previousImpressions: 2 },
        visits: { sessions: 11, users: 5, organic: 2, keyEvents: null, previousSessions: 3, previousOrganic: null },
        profile: null,
      },
      sites: [{ domain: "ace.com", status: "ok", error: "" }],
    });
    expect(out.clients[1].traffic.visits).toBeNull();
    expect(b.businessId).toBe(out.clients[1].clientId);
    expect(await actionCount("get_traffic")).toBe(1);
  });

  it("takes a period and a client id", async () => {
    await linked("Ace Plumbing", { period: "2026-10", facts: { ...facts({ clicks: 2 }), period: "2026-10" } });
    const other = await linked("Cedar Dental", { period: "2026-10", facts: { ...facts({ clicks: 3 }), period: "2026-10" } });
    expect((await ok<Answer>("get_traffic", { period: "2026-10" })).clients.map((c) => c.client)).toEqual(["Ace Plumbing", "Cedar Dental"]);
    const one = await ok<Answer>("get_traffic", { period: "2026-10", clientId: other.businessId });
    expect(one.clients.map((c) => c.client)).toEqual(["Cedar Dental"]);
    expect(one.clients[0].traffic.search.clicks).toBe(3);
    expect((await ok<Answer>("get_traffic", { clientId: other.businessId })).clients[0].traffic).toBeNull();
  });

  it("includes the three Business Profile counts for a client linked to a location alone, and never the location id", async () => {
    const s = await linked("Ace Plumbing", { link: false, facts: { ...facts({}), profile: { calls: 12, directions: 9, websiteClicks: 30, previousCalls: 8 } } });
    await saveLink(env.DB, s.site!.id, { gbpLocation: "locations/5550123456789" }, "2026-10-01T00:00:00.000Z");
    const r = await tool("get_traffic", {});
    const out = JSON.parse(r.text) as Answer;
    expect(out.clients).toHaveLength(1);
    expect(out.clients[0].traffic).toEqual({ search: null, visits: null, profile: { calls: 12, directions: 9, websiteClicks: 30, previousCalls: 8 } });
    expect(out.clients[0].sites).toEqual([{ domain: "ace.com", status: "ok", error: "" }]);
    expect(r.text).not.toMatch(/locations\/|5550123456789/);
  });

  it("merges the sites of one client like the reports do and says nothing was pulled as traffic null", async () => {
    const a = await linked("Ace Plumbing");
    await linked("Bay Roofing", { facts: null });
    const out = await ok<Answer>("get_traffic", {});
    expect(out.clients.find((c) => c.client === "Bay Roofing")).toMatchObject({ traffic: null, sites: [{ domain: "ace.com", status: null, error: "" }] });
    expect(out.clients.find((c) => c.clientId === a.businessId)!.traffic.search.clicks).toBe(7);
  });

  it("gives the error sentence only when the site's status is not ok, with the Google account's address worded out", async () => {
    await linked("Ace Plumbing", { status: "ok", error: "A leftover sentence." });
    await linked("Bay Roofing", { status: "failed", error: SPOKEN, facts: facts({}) });
    const out = await ok<Answer>("get_traffic", {});
    expect(out.clients[0].sites[0]).toEqual({ domain: "ace.com", status: "ok", error: "" });
    expect(out.clients[1].sites[0].status).toBe("failed");
    expect(out.clients[1].sites[0].error).toBe("Google says the connected Google account can't read this one. Ask the client to add the connected Google account as a viewer, then it will be tried again tomorrow.");
  });

  it("words out an address in a stored sentence whatever the Google connection is now: disconnected, another account, or another case", async () => {
    const sentence = (who: string) => `Google says ${who} can't read this one. Ask the client to add ${who} as a viewer, then it will be tried again tomorrow.`;
    const worded = "Google says the connected Google account can't read this one. Ask the client to add the connected Google account as a viewer, then it will be tried again tomorrow.";
    await linked("Ace Plumbing", { status: "failed", error: sentence("old.owner@x.test"), facts: facts({}) });
    await linked("Bay Roofing", { status: "failed", error: sentence("Me@X.Test"), facts: facts({}) });
    const never = await linked("Cedar Dental", { facts: null });
    await env.DB.prepare(`UPDATE site_analytics SET last_error = ? WHERE site_id = ?`).bind(sentence("old.owner@x.test"), never.site!.id).run();
    // Disconnected: no auth row at all.
    await env.DB.prepare(`DELETE FROM google_auth`).run();
    const gone = await tool("get_traffic", {});
    expect(JSON.parse(gone.text).clients.map((c: any) => c.sites[0].error)).toEqual([worded, worded, worded]);
    // Reconnected as another account: the stored address is not the current one.
    await saveGoogleAuth(env.DB, "new.account@y.test", await encryptSecret(env.SESSION_SECRET, "refresh-2"), "openid email");
    const other = await tool("get_traffic", {});
    expect(JSON.parse(other.text).clients.map((c: any) => c.sites[0].error)).toEqual([worded, worded, worded]);
    for (const leak of ["old.owner@x.test", "Me@X.Test", "@x.test", "new.account@y.test", "@"]) expect(gone.text + other.text).not.toContain(leak);
  });

  it("keeps the full stop after an address that ends a sentence", async () => {
    await linked("Ace Plumbing", { status: "failed", error: "Ask the client to add Me@X.Test.", facts: facts({}) });
    expect((await ok<Answer>("get_traffic", {})).clients[0].sites[0].error).toBe("Ask the client to add the connected Google account.");
  });

  it("leaves out test clients and clients with no linked site, and returns no property id, token, query, page path or channel", async () => {
    await linked("Ace Plumbing");
    await linked("Rehearsal Co", { test: true });
    await linked("No Link Co", { link: false, facts: null });
    const r = await tool("get_traffic", {});
    expect(r.isError).toBe(false);
    const out = JSON.parse(r.text) as Answer;
    expect(out.clients.map((c) => c.client)).toEqual(["Ace Plumbing"]);
    for (const leak of [GSC, "SECRET-GSC-PROPERTY", GA4, "refresh-1", "QUERY-SENTINEL", "PATH-SENTINEL", "CHANNEL-SENTINEL", "me@x.test", "sc-domain"]) expect(r.text).not.toContain(leak);
  });

  it("get_traffic with an unknown period shape is refused by the schema", async () => {
    for (const period of ["2026-13", "Nov 2026", "2026-1", "2026-11-01", "last month"]) {
      const r = await tool("get_traffic", { period });
      expect(r.isError).toBe(true);
    }
    expect((await tool("get_traffic", { clientId: "" })).isError).toBe(true);
    expect(await actionCount("get_traffic")).toBe(0);
  });
});
