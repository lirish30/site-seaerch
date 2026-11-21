import { createExecutionContext, env } from "cloudflare:test";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import worker from "../src/worker/index";
import { healthFor } from "../src/worker/clients/healthData";
import { insertCheck, listIncidents, openIncident, setMonitoring } from "../src/worker/db/monitoring";
import { ACCESS_KEYS, archiveSite, setAccess, updateSite } from "../src/worker/db/sites";
import { markSubscription } from "../src/worker/db/subscriptions";
import { monitoringDeps, sweepUptime } from "../src/worker/monitoring/sweep";
import { buildToday } from "../src/worker/today";
import { seedClient } from "./fixtures/clients";
import { E } from "./fixtures/close";
import { ok } from "./fixtures/mcp";
import { resetProjectWork } from "./fixtures/projects";

// An open incident closes by itself once its site is no longer monitored (Care ended, switch off, address cleared, archived, marked test), silently.
const NOW = new Date("2027-02-01T18:00:00.000Z");
const DAY = 86_400_000;
const ago = (ms: number) => new Date(NOW.getTime() - ms).toISOString();
const CARE = [{ key: "care" as const, monthlyCents: 12_900 }];
const realFetch = monitoringDeps.fetch;
const ctx = () => createExecutionContext();

beforeEach(async () => {
  vi.spyOn(console, "error").mockImplementation(() => {});
  for (const t of ["site_incidents", "site_checks"]) await env.DB.prepare(`DELETE FROM ${t}`).run();
  await resetProjectWork();
  for (const t of ["billing_holds", "invoice_nudges", "invoices", "subscriptions", "document_views", "document_signatures", "documents", "deals", "activity", "drafts", "audits", "search_results", "businesses", "suppressions"])
    await env.DB.prepare(`DELETE FROM ${t}`).run();
  // Every site that is still monitored is down (503): an incident on it must stay open through a tick.
  monitoringDeps.fetch = (async () => new Response(null, { status: 503 })) as typeof fetch;
});
afterEach(() => { monitoringDeps.fetch = realFetch; vi.restoreAllMocks(); });

let cookie = "";
const call = async (method: string, path: string, body?: unknown) => {
  if (!cookie) {
    const login = await worker.fetch(new Request("https://x/api/login", { method: "POST", body: JSON.stringify({ password: "test-pass" }), headers: { "content-type": "application/json" } }), E, ctx());
    cookie = login.headers.get("set-cookie")!.split(";")[0];
  }
  return worker.fetch(new Request(`https://x/api${path}`, { method, body: body === undefined ? undefined : JSON.stringify(body), headers: { cookie, "content-type": "application/json" } }), E, ctx());
};

/** A real client with every access item settled, so the one thing moving its score is the open down incident. */
async function client(o: { care?: boolean } = {}) {
  const s = await seedClient({ subs: o.care === false ? [] : CARE });
  for (const k of ACCESS_KEYS) await setAccess(env.DB, s.site!.id, k, { status: "received" }, NOW.toISOString());
  return s;
}
const openDown = (s: { site: { id: string } | null; businessId: string }, kind: "down" | "domain_expiring" = "down") =>
  openIncident(env.DB, { siteId: s.site!.id, businessId: s.businessId, kind, detail: kind === "down" ? "HTTP 503" : "domain expires in 5 days", now: ago(9 * DAY) });
const isOpen = async (siteId: string, kind = "down") =>
  (await env.DB.prepare(`SELECT closed_at FROM site_incidents WHERE site_id = ? AND kind = ?`).bind(siteId, kind).first<{ closed_at: string | null }>())!.closed_at === null;
const todayRows = async (businessId: string) => (await buildToday(env.DB, NOW)).filter((i) => i.kind === "site_incident" && i.businessId === businessId);

/** Every place an owner could still see the incident. */
async function expectGone(businessId: string, label: string) {
  expect(await todayRows(businessId), `${label}: Today`).toEqual([]);
  expect((await listIncidents(env.DB, { open: true })).filter((i) => i.businessId === businessId), `${label}: listIncidents`).toEqual([]);
  const api = (await (await call("GET", "/incidents?open=1")).json()) as { incidents: { id: string }[] };
  expect(api.incidents, `${label}: GET /api/incidents`).toEqual([]);
  expect((await ok<{ incidents: unknown[] }>("list_incidents", { open: true })).incidents, `${label}: MCP list_incidents`).toEqual([]);
  const health = await healthFor(env.DB, businessId, NOW);
  expect(health.reasons, `${label}: health`).not.toContain("Site is down");
  expect(health.score, `${label}: health score`).toBe(100);
}
const silent = async (businessId: string) =>
  expect((await env.DB.prepare(`SELECT kind FROM activity WHERE business_id = ?`).bind(businessId).all<{ kind: string }>()).results.map((r) => r.kind)).not.toContain("site_back");

describe("an incident closes by itself when its site stops being monitored", () => {
  it("Care cancelled while the site is down: one tick and the incident is gone everywhere, with no site_back line", async () => {
    const s = await client();
    await openDown(s);
    // Before: the owner sees it everywhere and the client loses 30 points.
    expect((await todayRows(s.businessId)).length).toBe(1);
    expect((await healthFor(env.DB, s.businessId, NOW)).score).toBe(70);

    await markSubscription(env.DB, s.subIds[0], { status: "cancelled" }, { from: ["active"] });
    await sweepUptime(env, NOW);
    await expectGone(s.businessId, "care cancelled");
    await silent(s.businessId);
    expect(await isOpen(s.site!.id)).toBe(false);
  });

  it("a second tick changes nothing (the close time stays the first one)", async () => {
    const s = await client();
    await openDown(s);
    await markSubscription(env.DB, s.subIds[0], { status: "cancelled" }, { from: ["active"] });
    await sweepUptime(env, NOW);
    const first = (await env.DB.prepare(`SELECT closed_at FROM site_incidents WHERE site_id = ?`).bind(s.site!.id).first<{ closed_at: string }>())!.closed_at;
    expect(first).not.toBeNull();
    await sweepUptime(env, new Date(NOW.getTime() + 600_000));
    expect((await env.DB.prepare(`SELECT closed_at FROM site_incidents WHERE site_id = ?`).bind(s.site!.id).first<{ closed_at: string }>())!.closed_at).toBe(first);
  });

  it("an open domain_expiring incident closes too", async () => {
    const s = await client();
    await openDown(s, "domain_expiring");
    await markSubscription(env.DB, s.subIds[0], { status: "cancelled" }, { from: ["active"] });
    await sweepUptime(env, NOW);
    expect(await isOpen(s.site!.id, "domain_expiring")).toBe(false);
    expect(await todayRows(s.businessId)).toEqual([]);
  });

  it("a switch turned off on a client without Care: the PUT closes it at once, and a tick would too", async () => {
    const s = await client({ care: false });
    await setMonitoring(env.DB, s.site!.id, true, NOW.toISOString());
    await openDown(s);
    const r = await call("PUT", `/sites/${s.site!.id}/monitoring`, { enabled: false });
    expect(r.status).toBe(200);
    expect(await isOpen(s.site!.id)).toBe(false);
    await expectGone(s.businessId, "switch off via route");
    await silent(s.businessId);

    const t = await client({ care: false });
    await setMonitoring(env.DB, t.site!.id, true, NOW.toISOString());
    await openDown(t);
    await setMonitoring(env.DB, t.site!.id, false, NOW.toISOString());
    expect(await isOpen(t.site!.id)).toBe(true);
    await sweepUptime(env, NOW);
    expect(await isOpen(t.site!.id)).toBe(false);
  });

  it("an address cleared (by the sweep, and at once through updateSite)", async () => {
    const a = await client();
    await openDown(a);
    await env.DB.prepare(`UPDATE sites SET url = NULL WHERE id = ?`).bind(a.site!.id).run();
    await sweepUptime(env, NOW);
    expect(await isOpen(a.site!.id)).toBe(false);

    const b = await client();
    await openDown(b);
    await updateSite(env.DB, b.site!.id, { url: null }, NOW.toISOString());
    expect(await isOpen(b.site!.id)).toBe(false);
  });

  it("an archived site (by the sweep, and at once through archiveSite)", async () => {
    const a = await client();
    await openDown(a);
    await env.DB.prepare(`UPDATE sites SET archived_at = ? WHERE id = ?`).bind(NOW.toISOString(), a.site!.id).run();
    await sweepUptime(env, NOW);
    expect(await isOpen(a.site!.id)).toBe(false);

    const b = await client();
    await openDown(b);
    await archiveSite(env.DB, b.site!.id, NOW.toISOString());
    expect(await isOpen(b.site!.id)).toBe(false);
  });

  it("a site marked test", async () => {
    const s = await client();
    await openDown(s);
    await env.DB.prepare(`UPDATE sites SET test = 1 WHERE id = ?`).bind(s.site!.id).run();
    await sweepUptime(env, NOW);
    expect(await isOpen(s.site!.id)).toBe(false);
  });
});

describe("what must stay open", () => {
  it("a still-monitored Care site keeps its incident through a tick, and so does its Today row and its -30", async () => {
    const s = await client();
    await openDown(s);
    await sweepUptime(env, NOW);
    expect(await isOpen(s.site!.id)).toBe(true);
    expect((await todayRows(s.businessId)).length).toBe(1);
    expect((await healthFor(env.DB, s.businessId, NOW)).score).toBe(70);
  });

  it("a Care client's site stays monitored when its hand switch is turned off: the PUT leaves the incident open", async () => {
    const s = await client();
    await setMonitoring(env.DB, s.site!.id, true, NOW.toISOString());
    await openDown(s);
    expect((await call("PUT", `/sites/${s.site!.id}/monitoring`, { enabled: false })).status).toBe(200);
    expect(await isOpen(s.site!.id)).toBe(true);
    await sweepUptime(env, NOW);
    expect(await isOpen(s.site!.id)).toBe(true);
  });

  it("never touches another client's incident: only the unmonitored site's closes", async () => {
    const gone = await client();
    const kept = await client();
    const keptDomain = await client({ care: false });
    await setMonitoring(env.DB, keptDomain.site!.id, true, NOW.toISOString());
    await env.DB.prepare(`UPDATE sites SET domain = 'kept-domain.com' WHERE id = ?`).bind(keptDomain.site!.id).run();
    await openDown(gone); await openDown(kept); await openDown(keptDomain, "domain_expiring");
    await markSubscription(env.DB, gone.subIds[0], { status: "cancelled" }, { from: ["active"] });
    await sweepUptime(env, NOW);
    expect(await isOpen(gone.site!.id)).toBe(false);
    expect(await isOpen(kept.site!.id)).toBe(true);
    expect(await isOpen(keptDomain.site!.id, "domain_expiring")).toBe(true);
  });

  it("the PUT off on one client's site leaves another client's incident open", async () => {
    const a = await client({ care: false });
    const b = await client({ care: false });
    for (const s of [a, b]) { await setMonitoring(env.DB, s.site!.id, true, NOW.toISOString()); await openDown(s); }
    expect((await call("PUT", `/sites/${a.site!.id}/monitoring`, { enabled: false })).status).toBe(200);
    expect(await isOpen(a.site!.id)).toBe(false);
    expect(await isOpen(b.site!.id)).toBe(true);
  });

  it("an incident that is recorded as a fresh failure while monitored still opens normally", async () => {
    const s = await client();
    await insertCheck(env.DB, { siteId: s.site!.id, checkedAt: ago(5 * 60_000), ok: false, status: 503, ms: 10, error: "HTTP 503" });
    const r = await sweepUptime(env, NOW);
    expect(r.opened).toBe(1);
    expect(await isOpen(s.site!.id)).toBe(true);
  });
});
