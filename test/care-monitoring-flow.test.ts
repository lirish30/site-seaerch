import { createExecutionContext, env } from "cloudflare:test";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import worker from "../src/worker/index";
import { getMailDeps, setMailDeps } from "../src/worker/mail/deps";
import { markSubscription } from "../src/worker/db/subscriptions";
import { ACCESS_KEYS, archiveSite, createSite, setAccess, updateSite } from "../src/worker/db/sites";
import { careFleet, type CareRow } from "../src/worker/monitoring/fleet";
import { monitoringDeps, sweepDomains } from "../src/worker/monitoring/sweep";
import { REMINDER_CRON, runScheduled } from "../src/worker/schedule";
import { seedClient } from "./fixtures/clients";
import { E } from "./fixtures/close";
import { readyToSend } from "./fixtures/documents";
import { tool } from "./fixtures/mcp";
import { expectFiniteNumbers, expectNumbersSurvive } from "./fixtures/numbers";
import { resetProjectWork } from "./fixtures/projects";

// Care monitoring end to end, through the entry points the app really uses: the five-minute cron for the uptime ticks, `sweepDomains` (the daily cron's domain step, called alone because the
// daily cron also runs the onboarding, project and billing sweeps, which can make approvals and tasks of their own), the owner's routes under /api, the MCP route and `buildToday` through
// GET /api/today. The only fakes are the fetch the probe and the registry lookup share (`monitoringDeps.fetch`, a recorder) and the mail transport (which must see nothing). The calendar is fixed:
// Thursday 3 December 2026, 09:00 in Los Angeles. One story, told in order.
const T = (hhmm: string) => new Date(`2026-12-03T${hhmm}:00.000Z`);
const START = T("17:00"); // 09:00 in Los Angeles
const at = (d: Date) => vi.setSystemTime(d);
const ctx = () => createExecutionContext();

const ACE = "https://ace-plumbing.example.com/";
const ZED = "https://zed-plumbing.example.com/";
const ZED_PRIVATE = "http://10.0.0.5/";
const ZED_ARCHIVED = "https://old-zed.example.com/";
const PLAIN = "https://plain-co.example.com/";
const TEST_SITE = "https://test-client.example.com/";
const SECRETS = { vaultName: "VAULT-NAME-SENTINEL", accessNote: "ACCESS-NOTE-SENTINEL", subscriptionToken: "SUBSCRIPTION-TOKEN-SENTINEL", siteBody: "SITE-BODY-SENTINEL" };

/** What the outside world answers: a status for each site address, and an expiry date for each domain. */
let status: Record<string, number> = {};
let expiry: Record<string, string> = {};
/** Every address the app fetched, in order. */
let fetched: string[] = [];
const realFetch = monitoringDeps.fetch;

const fakeWorld = (async (input: RequestInfo | URL) => {
  const url = String(input);
  fetched.push(url);
  const rdap = /^https:\/\/rdap\.org\/domain\/(.+)$/.exec(url);
  if (rdap) {
    const date = expiry[rdap[1]];
    return date ? new Response(JSON.stringify({ events: [{ eventAction: "expiration", eventDate: date }] }), { status: 200 }) : new Response("{}", { status: 404 });
  }
  return new Response(SECRETS.siteBody, { status: status[url] ?? 200, headers: { "x-secret": SECRETS.siteBody } });
}) as typeof fetch;
const siteCalls = () => fetched.filter((u) => !u.startsWith("https://rdap.org/"));
const rdapCalls = () => fetched.filter((u) => u.startsWith("https://rdap.org/"));

let mail: Awaited<ReturnType<typeof readyToSend>>;
let cookie = "";
let errors: unknown[][] = [];

beforeEach(async () => {
  errors = []; fetched = []; status = {}; expiry = {};
  vi.spyOn(console, "error").mockImplementation((...a: unknown[]) => { errors.push(a); });
  vi.spyOn(console, "warn").mockImplementation(() => {});
  vi.spyOn(console, "log").mockImplementation(() => {});
  vi.useFakeTimers({ toFake: ["Date"] });
  at(START);
  monitoringDeps.fetch = fakeWorld;
  // Incidents and sites go first: they point at businesses. The board and Today read every client, so the story starts from an empty set.
  for (const t of ["site_incidents", "site_checks"]) await env.DB.prepare(`DELETE FROM ${t}`).run();
  await resetProjectWork();
  for (const t of ["billing_holds", "invoice_nudges", "invoices", "subscriptions", "document_views", "document_signatures", "documents", "deals", "activity", "drafts", "audits", "search_results", "businesses", "suppressions", "approvals"])
    await env.DB.prepare(`DELETE FROM ${t}`).run();
  await env.DB.prepare(`UPDATE mailboxes SET enabled = 0`).run();
  cookie = "";
});
afterEach(() => {
  monitoringDeps.fetch = realFetch;
  vi.useRealTimers();
  vi.restoreAllMocks();
  setMailDeps(null);
});

async function owner(method: string, path: string, body?: unknown) {
  if (!cookie) {
    const login = await worker.fetch(new Request("https://x/api/login", { method: "POST", body: JSON.stringify({ password: "test-pass" }), headers: { "content-type": "application/json" } }), E, ctx());
    expect(login.status).toBe(200);
    cookie = login.headers.get("set-cookie")!.split(";")[0];
  }
  return worker.fetch(new Request(`https://x/api${path}`, { method, body: body === undefined ? undefined : JSON.stringify(body), headers: { cookie, "content-type": "application/json" } }), E, ctx());
}
const api = async <T = any>(method: string, path: string, body?: unknown, expected = 200): Promise<T> => {
  const r = await owner(method, path, body);
  expect(r.status, `${method} ${path} ${r.status}`).toBe(expected);
  return (await r.json()) as T;
};

/** One five-minute tick at `d`: the clock moves there and the cron runs. */
async function tick(d: Date) { at(d); await runScheduled(E, REMINDER_CRON, d); }

const today = async () => (await api<{ items: { id: string; kind: string; businessId: string; reason: string; priority: number }[] }>("GET", "/today")).items;
const siteRows = async () => (await today()).filter((i) => i.kind === "site_incident");
const board = async () => (await api<{ clients: CareRow[] }>("GET", "/care")).clients;
const count = async (table: string) => (await env.DB.prepare(`SELECT COUNT(*) AS n FROM ${table}`).first<{ n: number }>())!.n;
const checksOf = async (siteId: string) => (await env.DB.prepare(`SELECT COUNT(*) AS n FROM site_checks WHERE site_id = ?`).bind(siteId).first<{ n: number }>())!.n;
const activityOf = async (businessId: string, kind: string) =>
  (await api<{ activity: { kind: string; detail: string | null }[] }>("GET", `/leads/${businessId}`)).activity.filter((a) => a.kind === kind);
const resolveAccess = async (siteId: string) => { for (const k of ACCESS_KEYS) await setAccess(env.DB, siteId, k, { status: "received" }, START.toISOString()); };
const putUrl = (siteId: string, url: string) => updateSite(env.DB, siteId, { url, domain: new URL(url).hostname }, START.toISOString());

describe("care monitoring, end to end", () => {
  it("a site that goes down is one incident and one Today row until it is back; a domain close to expiring is one more; nothing is ever sent or made", async () => {
    // --- The world. Ace is a client with Care and one site. Zed has Care too, with a healthy site, an archived site and a site on a private address. Plain has no Care. Test is a test client with Care.
    const ace = await seedClient({ subs: [{ key: "care", monthlyCents: 12_900 }] });
    await env.DB.prepare(`UPDATE businesses SET name = 'Ace Plumbing' WHERE id = ?`).bind(ace.businessId).run();
    await putUrl(ace.site!.id, ACE);
    await resolveAccess(ace.site!.id); // so nothing but the monitoring moves the score
    // Things that must never reach an agent: a vault name, an access note and a subscription token.
    await setAccess(env.DB, ace.site!.id, "hosting", { status: "received", vaultItem: SECRETS.vaultName, note: SECRETS.accessNote }, START.toISOString());
    await markSubscription(env.DB, ace.subIds[0], { token: SECRETS.subscriptionToken });

    const zed = await seedClient({ subs: [{ key: "care", monthlyCents: 12_900 }] });
    await env.DB.prepare(`UPDATE businesses SET name = 'Zed Plumbing' WHERE id = ?`).bind(zed.businessId).run();
    await putUrl(zed.site!.id, ZED);
    await resolveAccess(zed.site!.id);
    const zedPrivate = (await createSite(env.DB, { businessId: zed.businessId, url: ZED_PRIVATE })).site;
    await resolveAccess(zedPrivate.id);
    const zedArchived = (await createSite(env.DB, { businessId: zed.businessId, url: ZED_ARCHIVED })).site;
    await archiveSite(env.DB, zedArchived.id, START.toISOString());

    const plain = await seedClient({ subs: [{ monthlyCents: 4_970 }] }); // a website subscription, not Care
    await env.DB.prepare(`UPDATE businesses SET name = 'Plain Co' WHERE id = ?`).bind(plain.businessId).run();
    await putUrl(plain.site!.id, PLAIN);

    const test = await seedClient({ test: true, subs: [{ key: "care", monthlyCents: 12_900 }] });
    await putUrl(test.site!.id, TEST_SITE);

    // The mail transport goes in: from here on, every message the app sends is seen.
    mail = await readyToSend();
    setMailDeps({ ...getMailDeps(), now: () => new Date() });
    const before = { approvals: await count("approvals"), tasks: await count("tasks"), claudeTasks: await count("claude_tasks"), mail: mail.sent.length };

    // --- Tick 1 (09:00): Ace answers 200. One check is written; nothing opens; the board shows Ace up with a full score.
    status = { [ACE]: 200, [ZED]: 200 };
    await tick(START);
    expect(siteCalls().sort()).toEqual([ACE, ZED].sort());
    expect(await checksOf(ace.site!.id)).toBe(1);
    expect(await checksOf(zed.site!.id)).toBe(1);
    expect(await count("site_incidents")).toBe(0);
    expect(await siteRows()).toEqual([]);
    let rows = await board();
    expect(rows.map((r) => r.name)).toEqual(["Ace Plumbing", "Zed Plumbing"]); // equal scores: by name
    const aceBoard = rows[0];
    const startScore = aceBoard.health.score;
    expect(startScore).toBe(100);
    expect(aceBoard.sites).toEqual([expect.objectContaining({ siteId: ace.site!.id, domain: "ace-plumbing.example.com", monitored: true, up: true, uptime30: 100, checks30: 1 })]);

    // --- Tick 2 (09:05): 503. A check is written but one blip is not an outage: no incident, nothing on Today.
    status[ACE] = 503;
    await tick(T("17:05"));
    expect(await checksOf(ace.site!.id)).toBe(2);
    expect(await count("site_incidents")).toBe(0);
    expect(await siteRows()).toEqual([]);
    expect((await board())[0].sites[0]).toMatchObject({ siteId: ace.site!.id, up: false });
    expect((await board())[0].openIncidents).toEqual([]);

    // --- Tick 3 (09:10): the second failure in a row opens one incident, and Today shows it (priority 90) with the exact reason two minutes later.
    await tick(T("17:10"));
    expect(await checksOf(ace.site!.id)).toBe(3);
    const open = (await env.DB.prepare(`SELECT id, site_id, business_id, kind, opened_at, closed_at, detail FROM site_incidents`).all<Record<string, string | null>>()).results;
    expect(open).toEqual([{ id: expect.any(String), site_id: ace.site!.id, business_id: ace.businessId, kind: "down", opened_at: T("17:10").toISOString(), closed_at: null, detail: "HTTP 503" }]);
    at(T("17:12"));
    expect(await siteRows()).toEqual([{
      id: `site_incident:${ace.businessId}`, kind: "site_incident", businessId: ace.businessId, businessName: "Ace Plumbing", reason: "ace-plumbing.example.com has been down for 2 minutes", due: null, priority: 90,
    }]);

    // The board shows Ace first, down, with a lower score; the MCP tools and the incident route agree with it.
    rows = await board();
    expect(rows.map((r) => r.name)).toEqual(["Ace Plumbing", "Zed Plumbing"]);
    expect(rows[0].sites[0]).toMatchObject({ siteId: ace.site!.id, up: false });
    expect(rows[0].health.score).toBe(startScore - 30);
    expect(rows[0].health.score).toBeLessThan(rows[1].health.score);
    expect(rows[0].health.reasons).toContain("Site is down");
    expect(rows[0].openIncidents).toEqual([{ id: open[0].id, siteId: ace.site!.id, domain: "ace-plumbing.example.com", kind: "down", openedAt: T("17:10").toISOString(), closedAt: null, detail: "HTTP 503" }]);
    const overview = await tool("get_care_overview", {});
    expect(overview.isError, overview.text).toBe(false);
    const overviewJson = JSON.parse(overview.text) as { clients: { clientId: string; name: string; healthScore: number; band: string; uptime30: number | null; openIncidents: number }[] };
    expect(overviewJson.clients.map((c) => c.clientId)).toEqual([ace.businessId, zed.businessId]);
    expect(overviewJson.clients[0]).toMatchObject({ name: "Ace Plumbing", healthScore: rows[0].health.score, band: rows[0].health.band, uptime30: rows[0].uptime30, openIncidents: 1 });
    expect(overviewJson.clients[1]).toMatchObject({ name: "Zed Plumbing", healthScore: 100, openIncidents: 0 });
    const listed = await tool("list_incidents", { open: true });
    expect(listed.isError, listed.text).toBe(false);
    const listedJson = JSON.parse(listed.text) as { incidents: { id: string; clientId: string; clientName: string; domain: string; kind: string; closedAt: string | null; detail: string }[] };
    expect(listedJson.incidents).toEqual([{
      id: open[0].id, clientId: ace.businessId, clientName: "Ace Plumbing", domain: "ace-plumbing.example.com", kind: "down", openedAt: T("17:10").toISOString(), closedAt: null, detail: "HTTP 503",
    }]);
    expect((await api<{ incidents: { id: string }[] }>("GET", "/incidents?open=1")).incidents.map((i) => i.id)).toEqual([open[0].id]);
    // The timeline has one site_down line, and it says the same fixed phrase.
    expect(await activityOf(ace.businessId, "site_down")).toEqual([expect.objectContaining({ kind: "site_down", detail: "HTTP 503" })]);
    expect(await activityOf(ace.businessId, "site_back")).toEqual([]);

    // --- Tick 4 (09:15): still 503. Nothing changes: the same incident, the same one timeline line, the same one Today row.
    await tick(T("17:15"));
    expect(await checksOf(ace.site!.id)).toBe(4);
    expect((await env.DB.prepare(`SELECT id, opened_at, closed_at FROM site_incidents`).all()).results).toEqual([{ id: open[0].id, opened_at: T("17:10").toISOString(), closed_at: null }]);
    expect(await activityOf(ace.businessId, "site_down")).toHaveLength(1);
    expect(await siteRows()).toEqual([expect.objectContaining({ businessId: ace.businessId, priority: 90, reason: "ace-plumbing.example.com has been down for 5 minutes" })]);
    expect((await board())[0].health.score).toBe(startScore - 30);

    // --- Tick 5 (09:20): the site answers 200. The incident closes, Today has no item, "back" is logged once and the score is where it started.
    status[ACE] = 200;
    await tick(T("17:20"));
    expect(await checksOf(ace.site!.id)).toBe(5);
    expect((await env.DB.prepare(`SELECT id, closed_at FROM site_incidents`).all()).results).toEqual([{ id: open[0].id, closed_at: T("17:20").toISOString() }]);
    expect(await siteRows()).toEqual([]);
    expect(await activityOf(ace.businessId, "site_back")).toEqual([expect.objectContaining({ kind: "site_back", detail: "back after 10 min" })]);
    expect(await activityOf(ace.businessId, "site_down")).toHaveLength(1);
    rows = await board();
    expect(rows[0].health.score).toBe(startScore);
    expect(rows[0].openIncidents).toEqual([]);
    expect(rows[0].sites[0]).toMatchObject({ up: true, checks30: 5 });
    expect((await api<{ incidents: { id: string; closedAt: string | null; detail: string }[] }>("GET", "/incidents")).incidents)
      .toEqual([expect.objectContaining({ id: open[0].id, closedAt: T("17:20").toISOString(), detail: "HTTP 503" })]);
    expect((await api<{ incidents: unknown[] }>("GET", "/incidents?open=1")).incidents).toEqual([]);
    // One more tick with the site up changes nothing.
    await tick(T("17:25"));
    expect(await count("site_incidents")).toBe(1);
    expect(await activityOf(ace.businessId, "site_back")).toHaveLength(1);

    // --- Who was fetched: Ace and Zed on every tick, and no other address: not the client without Care, the test client's, the archived site or the private address, which was skipped without a check.
    expect(siteCalls()).toHaveLength(12); // six ticks, two sites each
    expect([...new Set(siteCalls())].sort()).toEqual([ACE, ZED].sort());
    expect(rdapCalls()).toEqual([]); // the uptime tick never asks the registry
    for (const url of [PLAIN, TEST_SITE, ZED_ARCHIVED, ZED_PRIVATE]) expect(fetched.join(" ")).not.toContain(url);
    expect(await checksOf(zedPrivate.id)).toBe(0);
    expect(await checksOf(plain.site!.id)).toBe(0);
    expect(await checksOf(test.site!.id)).toBe(0);
    expect(await checksOf(zedArchived.id)).toBe(0);
    expect((await board()).find((r) => r.businessId === zed.businessId)!.sites.find((s) => s.siteId === zedPrivate.id)).toMatchObject({ monitored: true, monitorable: false, up: null, checks30: 0 });
    expect((await board()).map((r) => r.businessId)).not.toContain(plain.businessId); // switched off, no Care
    expect((await board()).map((r) => r.businessId)).not.toContain(test.businessId);
    // The check list of a site shows only status, time and a fixed phrase, newest first, and never an address; a test client's site is not there to ask about.
    const checks = (await api<{ checks: { checkedAt: string; ok: boolean; status: number | null; ms: number; error: string | null }[] }>("GET", `/sites/${ace.site!.id}/checks`)).checks;
    expect(checks.map((k) => [k.checkedAt, k.ok, k.status, k.error])).toEqual([
      [T("17:25").toISOString(), true, 200, null], [T("17:20").toISOString(), true, 200, null], [T("17:15").toISOString(), false, 503, "HTTP 503"],
      [T("17:10").toISOString(), false, 503, "HTTP 503"], [T("17:05").toISOString(), false, 503, "HTTP 503"], [T("17:00").toISOString(), true, 200, null],
    ]);
    expect((await owner("GET", `/sites/${test.site!.id}/checks`)).status).toBe(404);
    expect((await owner("PUT", `/sites/${test.site!.id}/monitoring`, { enabled: true })).status).toBe(404);

    // --- Domains (09:30). The registry says Ace's domain ends in 12 days and Zed's in 400: Ace gets a domain incident and a Today row at priority 66, Zed none. (sweepDomains is called alone; see the top.)
    fetched = [];
    at(T("17:30"));
    expiry = { "ace-plumbing.example.com": "2026-12-15T23:59:59Z", "zed-plumbing.example.com": "2028-01-07T23:59:59Z" };
    expect(await sweepDomains(E, T("17:30"))).toMatchObject({ checked: 3, opened: 1, closed: 0 });
    expect(rdapCalls().sort()).toEqual(["https://rdap.org/domain/ace-plumbing.example.com", "https://rdap.org/domain/zed-plumbing.example.com"]); // nobody else's domain is looked up
    const domainIncident = (await env.DB.prepare(`SELECT id, site_id, kind, closed_at FROM site_incidents WHERE kind = 'domain_expiring'`).all<{ id: string; site_id: string; kind: string; closed_at: string | null }>()).results;
    expect(domainIncident).toEqual([{ id: expect.any(String), site_id: ace.site!.id, kind: "domain_expiring", closed_at: null }]);
    expect(await siteRows()).toEqual([{
      id: `site_incident:${ace.businessId}`, kind: "site_incident", businessId: ace.businessId, businessName: "Ace Plumbing", reason: "ace-plumbing.example.com expires in 12 days", due: null, priority: 66,
    }]);
    rows = await board();
    expect(rows[0]).toMatchObject({ name: "Ace Plumbing", health: { score: startScore - 10 }, openIncidents: [expect.objectContaining({ kind: "domain_expiring", detail: "domain expires in 12 days" })] });
    expect(rows[0].sites[0]).toMatchObject({ domainExpiresOn: "2026-12-15" });
    expect(rows[1].sites.find((s) => s.siteId === zed.site!.id)).toMatchObject({ domainExpiresOn: "2028-01-07" });
    expect(await activityOf(ace.businessId, "domain_expiring")).toEqual([expect.objectContaining({ detail: "domain expires in 12 days" })]);
    // The agent's incident list words it the same way.
    const domainListed = JSON.parse((await tool("list_incidents", { open: true })).text) as { incidents: { kind: string; detail: string; domain: string }[] };
    expect(domainListed.incidents).toEqual([expect.objectContaining({ kind: "domain_expiring", detail: "domain expires in 12 days", domain: "ace-plumbing.example.com" })]);

    // A week and more later the registry says the domain was renewed (400 days): the incident closes, Today is empty, and the closed one reads as a fixed phrase, not a stale number.
    fetched = [];
    const later = new Date("2026-12-11T17:00:00.000Z");
    at(later);
    expiry["ace-plumbing.example.com"] = "2028-01-07T23:59:59Z";
    expect(await sweepDomains(E, later)).toMatchObject({ checked: 3, opened: 0, closed: 1 });
    expect(await siteRows()).toEqual([]);
    const closed = (await api<{ incidents: { kind: string; closedAt: string | null; detail: string; domain: string | null }[] }>("GET", "/incidents")).incidents;
    expect(closed.filter((i) => i.kind === "domain_expiring")).toEqual([expect.objectContaining({ closedAt: later.toISOString(), detail: "domain expiry warning", domain: "ace-plumbing.example.com" })]);
    expect((await board())[0].health.score).toBe(startScore);

    // --- Switching the client without Care on by hand makes the next tick fetch it, and only then.
    const D11 = (hhmm: string) => new Date(`2026-12-11T${hhmm}:00.000Z`);
    fetched = [];
    await tick(D11("17:05"));
    expect(siteCalls().sort()).toEqual([ACE, ZED].sort()); // Plain still has no Care and is switched off
    const on = await api<{ site: { siteId: string; monitored: boolean; domain: string } }>("PUT", `/sites/${plain.site!.id}/monitoring`, { enabled: true });
    expect(on.site).toMatchObject({ siteId: plain.site!.id, monitored: true, domain: "plain-co.example.com" });
    expect(JSON.stringify(on)).not.toContain(PLAIN); // the answer carries the domain, never the address
    fetched = [];
    await tick(D11("17:10"));
    expect(siteCalls().sort()).toEqual([ACE, PLAIN, ZED].sort());
    expect(await checksOf(plain.site!.id)).toBe(1);
    expect((await board()).map((r) => r.name)).toContain("Plain Co");
    // An address the probe may not fetch cannot be switched on, and the answer says why.
    expect((await owner("PUT", `/sites/${zedPrivate.id}/monitoring`, { enabled: true })).status).toBe(409);
    // Switched off again, Plain is left alone by the next tick.
    expect((await api<{ site: { monitored: boolean } }>("PUT", `/sites/${plain.site!.id}/monitoring`, { enabled: false })).site.monitored).toBe(false);
    fetched = [];
    await tick(D11("17:15"));
    expect(siteCalls()).not.toContain(PLAIN);

    // --- The story's most important line: monitoring sent nothing to anyone and made no approval, no task, no Claude task and no mail.
    expect({ approvals: await count("approvals"), tasks: await count("tasks"), claudeTasks: await count("claude_tasks"), mail: mail.sent.length }).toEqual(before);
    expect(mail.sent).toEqual([]);

    // --- No address, token, vault name or site answer is in anything an agent can read, and every number on the board is a finite number.
    const answers = [await tool("get_care_overview", {}), await tool("list_incidents", {}), await tool("list_incidents", { open: false }), await tool("list_incidents", { clientId: ace.businessId })];
    for (const r of answers) {
      expect(r.isError, r.text).toBe(false);
      for (const url of [ACE, ZED, PLAIN, ZED_PRIVATE, ZED_ARCHIVED, TEST_SITE]) expect(r.text, `an address is in ${r.text.slice(0, 80)}`).not.toContain(url);
      expect(r.text).not.toMatch(/https?:\/\//);
      for (const [what, value] of Object.entries(SECRETS)) expect(r.text, `${what} is in an MCP answer`).not.toContain(value);
      expect(r.text).not.toContain(test.businessId); // the test client is not there
    }
    const everything = JSON.stringify([await board(), (await api("GET", "/incidents")), checks]);
    for (const value of [ACE, ZED, PLAIN, ...Object.values(SECRETS)]) expect(everything).not.toContain(value);
    const reference = await careFleet(env.DB, new Date());
    expectNumbersSurvive({ clients: await board() }, { clients: reference });
    expectFiniteNumbers(reference);
    expectFiniteNumbers(JSON.parse(answers[0].text));
    for (const c of JSON.parse(answers[0].text).clients as { healthScore: number }[]) expect(Number.isInteger(c.healthScore)).toBe(true);
    // Nothing was logged as an error.
    expect(errors).toEqual([]);
  });
});
