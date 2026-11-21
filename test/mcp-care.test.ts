import { env } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";
import { closeIncident, insertCheck, openIncident } from "../src/worker/db/monitoring";
import { ACCESS_KEYS, setAccess } from "../src/worker/db/sites";
import { seedClient } from "./fixtures/clients";
import { resetProjectWork } from "./fixtures/projects";
import { actionCount, mcp, ok, tool } from "./fixtures/mcp";

// The two Care tools through the MCP route: the same fleet and incident views the Care board shows, cut down to hand-built, read-only answers.
const CARE = [{ key: "care" as const, monthlyCents: 12_900 }];
const iso = (ago: number) => new Date(Date.now() - ago).toISOString();
const HOUR = 3_600_000;
const SITE_URL = "https://ace.com";
const VAULT = "VAULT-ITEM-CARE-SENTINEL";
const NOTE = "ACCESS-NOTE-CARE-SENTINEL";

beforeEach(async () => {
  for (const t of ["site_incidents", "site_checks"]) await env.DB.prepare(`DELETE FROM ${t}`).run();
  await resetProjectWork();
  for (const t of ["billing_holds", "invoice_nudges", "invoices", "subscriptions", "document_views", "document_signatures", "documents", "deals", "activity", "drafts", "audits", "search_results", "businesses", "suppressions"])
    await env.DB.prepare(`DELETE FROM ${t}`).run();
});

const rename = (id: string, name: string) => env.DB.prepare(`UPDATE businesses SET name = ? WHERE id = ?`).bind(name, id).run();
const check = (siteId: string, ago: number, up: boolean) =>
  insertCheck(env.DB, { siteId, checkedAt: iso(ago), ok: up, status: up ? 200 : 503, ms: 120, error: up ? null : "HTTP 503" });

/** A real Care client with every access item settled (the vault name and a note are set on one of them), named as given. */
async function careClient(name: string, o: { test?: boolean } = {}) {
  const s = await seedClient({ subs: CARE, test: o.test });
  await rename(s.businessId, name);
  for (const k of ACCESS_KEYS) await setAccess(env.DB, s.site!.id, k, k === "hosting" ? { status: "received", vaultItem: VAULT, note: NOTE } : { status: "received" }, iso(0));
  return s;
}

/** A failing client (an open down incident, HTTP 503), a healthy one and a test client that also has a down incident. */
async function seedFleet() {
  const healthy = await careClient("Zed Plumbing");
  await check(healthy.site!.id, 3 * HOUR, true); await check(healthy.site!.id, 2 * HOUR, true);
  const sick = await careClient("Ace Plumbing");
  await check(sick.site!.id, 3 * HOUR, true); await check(sick.site!.id, 2 * HOUR, true); await check(sick.site!.id, HOUR, false);
  const sickInc = await openIncident(env.DB, { siteId: sick.site!.id, businessId: sick.businessId, kind: "down", detail: "HTTP 503", now: iso(HOUR) });
  const rehearsal = await careClient("Rehearsal Plumbing", { test: true });
  await openIncident(env.DB, { siteId: rehearsal.site!.id, businessId: rehearsal.businessId, kind: "down", detail: "HTTP 500", now: iso(HOUR) });
  return { healthy, sick, rehearsal, sickInc };
}

type Overview = { clients: { clientId: string; name: string; careLabel: string | null; healthScore: number; band: string; reasons: string[]; uptime30: number | null; openIncidents: number }[] };
type Incidents = { incidents: { id: string; clientId: string; clientName: string; domain: string | null; kind: string; openedAt: string; closedAt: string | null; detail: string }[] };

/** Nothing an agent must never read: no address, no vault name, no access note, no token or Stripe id. */
function expectNoLeaks(text: string, what: string) {
  // Case sensitive: the one allowed `HTTP 503` detail is upper case, while a link or a key name is lower case.
  for (const bad of ["http", "vault", "url", VAULT, NOTE, SITE_URL, "token", "stripe", "cus_", "sub_", "in_"]) expect(text, `${what} shows ${bad}`).not.toContain(bad);
}

describe("the tool list", () => {
  it("has the two care tools", async () => {
    const names = (await mcp("tools/list", {})).result.tools.map((t: { name: string }) => t.name);
    expect(names).toContain("get_care_overview");
    expect(names).toContain("list_incidents");
  });
});

describe("get_care_overview", () => {
  it("lists the failing client first and the healthy one second, and never the test client", async () => {
    const { healthy, sick } = await seedFleet();
    const { clients } = await ok<Overview>("get_care_overview", {});
    expect(clients.map((c) => c.name)).toEqual(["Ace Plumbing", "Zed Plumbing"]);
    expect(clients[0]).toEqual({
      clientId: sick.businessId, name: "Ace Plumbing", careLabel: "Care $129/mo", healthScore: 70, band: "watch",
      reasons: expect.any(Array), uptime30: 66.7, openIncidents: 1,
    });
    expect(clients[0].reasons.length).toBeGreaterThan(0);
    expect(clients[1]).toMatchObject({ clientId: healthy.businessId, healthScore: 100, band: "good", reasons: [], uptime30: 100, openIncidents: 0 });
    expect(Object.keys(clients[0]).sort()).toEqual(["band", "careLabel", "clientId", "healthScore", "name", "openIncidents", "reasons", "uptime30"]);
  });

  it("is an empty list with no Care clients", async () => {
    expect(await ok<Overview>("get_care_overview", {})).toEqual({ clients: [] });
  });

  it("logs one agent action", async () => {
    const before = await actionCount("get_care_overview");
    await tool("get_care_overview", {});
    expect(await actionCount("get_care_overview")).toBe(before + 1);
  });
});

describe("list_incidents", () => {
  it("open: true returns the one open incident, with its detail as HTTP 503", async () => {
    const { sick, sickInc } = await seedFleet();
    const { incidents } = await ok<Incidents>("list_incidents", { open: true });
    expect(incidents).toEqual([{ id: sickInc.incident.id, clientId: sick.businessId, clientName: "Ace Plumbing", domain: "ace.com", kind: "down", openedAt: sickInc.incident.openedAt, closedAt: null, detail: "HTTP 503" }]);
  });

  it("filters by client, by closed, and keeps the newest first", async () => {
    const { healthy, sick, sickInc } = await seedFleet();
    await closeIncident(env.DB, sick.site!.id, "down", iso(0));
    const second = await openIncident(env.DB, { siteId: sick.site!.id, businessId: sick.businessId, kind: "down", detail: "timed out", now: iso(60_000) });
    const all = (await ok<Incidents>("list_incidents", {})).incidents;
    expect(all.map((i) => i.id)).toEqual([second.incident.id, sickInc.incident.id]);
    expect(all[1].closedAt).not.toBeNull();
    expect((await ok<Incidents>("list_incidents", { clientId: sick.businessId })).incidents).toHaveLength(2);
    expect((await ok<Incidents>("list_incidents", { clientId: healthy.businessId })).incidents).toEqual([]);
    expect((await ok<Incidents>("list_incidents", { open: false })).incidents.map((i) => i.id)).toEqual([sickInc.incident.id]);
    expect((await ok<Incidents>("list_incidents", { limit: 1 })).incidents.map((i) => i.id)).toEqual([second.incident.id]);
  });

  it("never lists the test client's incident", async () => {
    const { rehearsal } = await seedFleet();
    const all = (await ok<Incidents>("list_incidents", {})).incidents;
    expect(all.map((i) => i.clientId)).not.toContain(rehearsal.businessId);
    expect((await ok<Incidents>("list_incidents", { clientId: rehearsal.businessId })).incidents).toEqual([]);
  });

  it("an unknown client id is an empty list and the id is not echoed", async () => {
    await seedFleet();
    const r = await tool("list_incidents", { clientId: "NOT-A-CLIENT-ECHO-SENTINEL" });
    expect(r.isError).toBe(false);
    expect(JSON.parse(r.text)).toEqual({ incidents: [] });
    expect(r.text).not.toContain("ECHO-SENTINEL");
  });

  it("refuses a limit over 100 or under 1, and takes 100", async () => {
    expect((await tool("list_incidents", { limit: 500 })).isError).toBe(true);
    expect((await tool("list_incidents", { limit: 101 })).isError).toBe(true);
    expect((await tool("list_incidents", { limit: 0 })).isError).toBe(true);
    expect((await tool("list_incidents", { limit: 100 })).isError).toBe(false);
  });

  it("defaults to 25", async () => {
    const s = await careClient("Many Plumbing");
    for (let i = 0; i < 30; i++) {
      await openIncident(env.DB, { siteId: s.site!.id, businessId: s.businessId, kind: "down", detail: "HTTP 503", now: iso((i + 2) * HOUR) });
      await closeIncident(env.DB, s.site!.id, "down", iso((i + 1) * HOUR));
    }
    expect((await ok<Incidents>("list_incidents", {})).incidents).toHaveLength(25);
  });

  it("words a domain incident from the site's expiry date, never from stored text", async () => {
    const s = await careClient("Domain Plumbing");
    await env.DB.prepare(`UPDATE sites SET domain_expires_on = ? WHERE id = ?`).bind(new Date(Date.now() + 12 * 86_400_000).toISOString().slice(0, 10), s.site!.id).run();
    await openIncident(env.DB, { siteId: s.site!.id, businessId: s.businessId, kind: "domain_expiring", detail: "SECRET stored sentence https://evil.test", now: iso(HOUR) });
    const { incidents } = await ok<Incidents>("list_incidents", { open: true });
    expect(incidents).toHaveLength(1);
    expect(incidents[0].detail).toMatch(/^domain expires in \d+ days?$/);
    expect(incidents[0].detail).not.toContain("SECRET");
  });

  it("logs one agent action", async () => {
    const before = await actionCount("list_incidents");
    await tool("list_incidents", { open: true });
    expect(await actionCount("list_incidents")).toBe(before + 1);
  });
});

describe("what neither tool may say", () => {
  it("the sentinels are really in the data", async () => {
    const { sick } = await seedFleet();
    expect((await env.DB.prepare(`SELECT vault_item, note FROM site_access_items WHERE site_id = ? AND key = 'hosting'`).bind(sick.site!.id).first())).toEqual({ vault_item: VAULT, note: NOTE });
    expect((await env.DB.prepare(`SELECT url FROM sites WHERE id = ?`).bind(sick.site!.id).first<{ url: string }>())!.url).toBe(SITE_URL);
  });

  it("the serialized answers carry no address, vault name, note, token or Stripe id", async () => {
    const { sick } = await seedFleet();
    for (const [name, args] of [["get_care_overview", {}], ["list_incidents", {}], ["list_incidents", { open: true }], ["list_incidents", { clientId: sick.businessId }]] as [string, unknown][]) {
      const r = await tool(name, args);
      expect(r.isError, name).toBe(false);
      expect(r.text.length, `${name} answered`).toBeGreaterThan(10);
      expectNoLeaks(r.text, `${name} ${JSON.stringify(args)}`);
    }
  });
});
