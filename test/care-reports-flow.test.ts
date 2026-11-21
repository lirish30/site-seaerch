import { createExecutionContext, env } from "cloudflare:test";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import worker from "../src/worker/index";
import { approve } from "../src/worker/approvals/decide";
import "../src/worker/approvals/careReport";
import { plainSummary, ReportFacts } from "../src/worker/care/reportFacts";
import { upsertUptimeDay } from "../src/worker/db/careReports";
import { placeHold } from "../src/worker/db/holds";
import { closeIncident, openIncident, setCertExpiry } from "../src/worker/db/monitoring";
import { addCadence, createProject } from "../src/worker/db/projects";
import { ensureSeedSops } from "../src/worker/db/sops";
import { ACCESS_KEYS, createSite, setAccess, updateSite } from "../src/worker/db/sites";
import { markSubscription } from "../src/worker/db/subscriptions";
import { listTasks } from "../src/worker/db/tasks";
import type { Env } from "../src/worker/env";
import { getMailDeps, setMailDeps } from "../src/worker/mail/deps";
import { monitoringDeps } from "../src/worker/monitoring/sweep";
import { buildBundle } from "../src/worker/queue/bundle";
import { completeTask } from "../src/worker/queue/db";
import "../src/worker/queue/kinds";
import { DAILY_CRON, runScheduled } from "../src/worker/schedule";
import { seedClient } from "./fixtures/clients";
import { E } from "./fixtures/close";
import { OWNER_EMAIL, readyToSend } from "./fixtures/documents";
import { claimById } from "./fixtures/draftTask";
import { mcp, tool } from "./fixtures/mcp";
import { expectFiniteNumbers } from "./fixtures/numbers";
import psi from "./fixtures/psi.json";

// The monthly Care reports, end to end, through the entry points the app really uses on a fixed calendar (Los Angeles): the owner's routes under /api with a real session (an edit request, time on it, "Build now", the
// words, the take-back), the daily cron on Wednesday 2 December 2026 at 09:00 (which rolls the last days of November up, makes each Care client's CARE-4 task and starts the reports), Claude's summaries through the queue's own
// completion (the function and the MCP route), the queue's own expiry on a later daily cron, the real approval path, the public route /api/public/m/<token> and the MCP route. The only fakes are the outside world: PageSpeed (the
// Worker's fetch), the registry lookup the daily cron makes, and the mail transport. A month of November's history (uptime days, runs, an outage) is written as data, because no entry point replays a month.
const DAY_BEFORE = new Date("2026-11-10T18:00:00.000Z"); // Tuesday 10 November, 10:00: the edit requests are made
const NOV_12 = new Date("2026-11-12T18:00:00.000Z");
const NOV_18 = new Date("2026-11-18T18:00:00.000Z");
const NOV_20 = new Date("2026-11-20T18:00:00.000Z");
const NOV_30 = new Date("2026-11-30T17:00:00.000Z"); // Monday 30 November, 09:00
const START = new Date("2026-12-02T17:00:00.000Z"); // Wednesday 2 December, 09:00
const DEC_17 = new Date("2026-12-17T17:00:00.000Z"); // Thursday 17 December, 09:00: the summary nobody wrote has expired
const at = (d: Date) => vi.setSystemTime(d);
const ctx = () => createExecutionContext();
const EV = { ...E, PAGESPEED_API_KEY: "psi-test-key" } as Env;

const SECRETS = {
  vaultName: "VAULT-NAME-SENTINEL", accessNote: "ACCESS-NOTE-SENTINEL", subscriptionToken: "SUBSCRIPTION-TOKEN-SENTINEL", pluginName: "PLUGIN-NAME-SENTINEL", pluginSlug: "plugin-slug-sentinel",
  incidentSentence: "INCIDENT-SENTENCE-SENTINEL", backupDir: "siteline-backups", backupFile: ".sql.gz",
};
/** What a client's SSH details look like: they may live in a helper job and nowhere a client, an agent or an owner page can read them. */
const ALIAS_WORD = "host-alias";
const PATH_WORD = "/var/www/";

const A_SUMMARY = "Alpha Bakery's two sites were up almost all of November. The main site went down once, for about three hours on the 14th. Two updates went in cleanly and one was put back because it broke a page.";
const A_REC = "Keep the next edit requests small, because this month's edit hours ran out.";
const C_SUMMARY = "Charlie Salon's site had a quiet November. Nothing was measured for uptime yet, so there is no figure to share.";
const C_REC = "Switch monitoring on for the site so next month's report has an uptime figure.";

let cookie = "";
let errors: unknown[][] = [];
let rdap: string[] = [];
let outside: string[] = [];
let mail: Awaited<ReturnType<typeof readyToSend>>;
const realFetch = monitoringDeps.fetch;
const apiBodies: string[] = [];
const publicBodies: string[] = [];
const mcpBodies: string[] = [];

beforeEach(async () => {
  errors = []; rdap = []; outside = []; cookie = "";
  apiBodies.length = 0; publicBodies.length = 0; mcpBodies.length = 0;
  vi.spyOn(console, "error").mockImplementation((...a: unknown[]) => { errors.push(a); });
  vi.spyOn(console, "warn").mockImplementation(() => {});
  vi.spyOn(console, "log").mockImplementation(() => {});
  vi.useFakeTimers({ toFake: ["Date"] });
  at(DAY_BEFORE);
  // The Worker's own fetch: PageSpeed answers the one fixture; anything else is a question the app should not have asked.
  vi.spyOn(globalThis, "fetch").mockImplementation((async (input: RequestInfo | URL) => {
    const url = String(input instanceof Request ? input.url : input);
    outside.push(url);
    if (url.startsWith("https://www.googleapis.com/pagespeedonline/v5/runPagespeed?")) return new Response(JSON.stringify(psi), { status: 200 });
    throw new Error("no network in tests");
  }) as typeof fetch);
  // The daily cron looks up domain expiry too: the registry answers nothing, and the test counts the questions.
  monitoringDeps.fetch = (async (input: RequestInfo | URL) => { rdap.push(String(input)); return new Response("{}", { status: 404 }); }) as typeof fetch;
  for (const t of ["care_reports", "site_uptime_days", "care_page_checks", "care_runs", "care_batches", "care_updates", "site_inventories", "site_incidents", "site_checks", "helper_jobs", "helper_devices"]) await env.DB.prepare(`DELETE FROM ${t}`).run();
  await env.DB.batch(["site_access_items", "sites"].map((t) => env.DB.prepare(`DELETE FROM ${t}`)));
  await env.DB.batch(["task_comments", "time_entries", "tasks", "change_order_views", "change_orders", "project_milestones", "project_cadences", "projects", "claude_tasks", "agent_actions"].map((t) => env.DB.prepare(`DELETE FROM ${t}`)));
  for (const t of ["billing_holds", "invoice_nudges", "invoices", "subscriptions", "document_views", "document_signatures", "documents", "deals", "activity", "drafts", "audits", "search_results", "businesses", "suppressions", "approvals", "messages"])
    await env.DB.prepare(`DELETE FROM ${t}`).run();
  await env.DB.prepare(`UPDATE mailboxes SET enabled = 0`).run();
  await env.DB.batch([env.DB.prepare(`DELETE FROM sop_template_steps`), env.DB.prepare(`DELETE FROM sop_templates`)]);
  await ensureSeedSops(env.DB);
});
afterEach(() => {
  monitoringDeps.fetch = realFetch;
  vi.useRealTimers();
  vi.restoreAllMocks();
  setMailDeps(null);
});

// --- the owner's side ---------------------------------------------------------------------------------------------------------------------------------------------------

async function owner(method: string, path: string, body?: unknown) {
  if (!cookie) {
    const login = await worker.fetch(new Request("https://x/api/login", { method: "POST", body: JSON.stringify({ password: "test-pass" }), headers: { "content-type": "application/json" } }), EV, ctx());
    expect(login.status).toBe(200);
    cookie = login.headers.get("set-cookie")!.split(";")[0];
  }
  return worker.fetch(new Request(`https://x/api${path}`, { method, body: body === undefined ? undefined : JSON.stringify(body), headers: { cookie, "content-type": "application/json" } }), EV, ctx());
}
/** Every /api body the test reads, as text, so the last check can look through all of them. */
const api = async <T = any>(method: string, path: string, body?: unknown, expected = 200): Promise<T> => {
  const r = await owner(method, path, body);
  const text = await r.text();
  expect(r.status, `${method} ${path} ${r.status} ${text}`).toBe(expected);
  apiBodies.push(text);
  return JSON.parse(text) as T;
};
/** The client's page, without a session, as the link in the mail opens it. */
async function page(token: string): Promise<{ status: number; json: any }> {
  const r = await worker.fetch(new Request(`https://x/api/public/m/${token}`), EV, ctx());
  const text = await r.text();
  publicBodies.push(text);
  return { status: r.status, json: JSON.parse(text) };
}
/** An MCP tool that must succeed; its text is kept for the leak check. */
async function ask(name: string, args: unknown = {}) {
  const r = await tool(name, args);
  expect(r.isError, `${name}: ${r.text}`).toBe(false);
  mcpBodies.push(r.text);
  return JSON.parse(r.text);
}

// --- the world ------------------------------------------------------------------------------------------------------------------------------------------------------------

const count = async (table: string, where = "1 = 1") => (await env.DB.prepare(`SELECT COUNT(*) AS n FROM ${table} WHERE ${where}`).first<{ n: number }>())!.n;
const resolveAccess = async (siteId: string) => { for (const k of ACCESS_KEYS) await setAccess(env.DB, siteId, k, { status: "received" }, NOV_20.toISOString()); };

interface Mk { key?: "care" | "care_plus"; test?: boolean; hold?: boolean; cadenceAt?: string; email: string; domains: string[] }
/** A client with live Care: their sites (WordPress over SSH, so the alias and the folder exist to be kept secret), a Care project and the monthly report cadence on it. A test client's project is the seeded rehearsal one. */
async function mk(name: string, o: Mk) {
  const s = await seedClient({ test: o.test, subs: [{ key: o.key ?? "care", monthlyCents: o.key === "care_plus" ? 24_900 : 12_900, test: o.test }], invoice: o.hold ? { cents: 5000 } : undefined });
  await env.DB.prepare(`UPDATE businesses SET name = ? WHERE id = ?`).bind(name, s.businessId).run();
  await env.DB.prepare(`UPDATE people SET email = ? WHERE business_id = ?`).bind(o.email, s.businessId).run();
  const siteIds = [s.site!.id];
  for (const [i, domain] of o.domains.entries()) {
    const id = i === 0 ? s.site!.id : (await createSite(env.DB, { businessId: s.businessId, url: `https://${domain}/`, test: o.test })).site.id;
    if (i > 0) siteIds.push(id);
    await updateSite(env.DB, id, { url: `https://${domain}/`, domain }, NOV_20.toISOString());
    await env.DB.prepare(`UPDATE sites SET cms = 'wordpress', access_method = 'ssh_wpcli', wp_ssh_alias = ?, wp_path = ?, care_paths = ? WHERE id = ?`)
      .bind(`${ALIAS_WORD}-${domain.split(".")[0]}`, `${PATH_WORD}${domain.split(".")[0]}`, JSON.stringify(["/"]), id).run();
    await resolveAccess(id);
  }
  const projectId = o.test ? s.project!.id : (await createProject(env.DB, {
    businessId: s.businessId, dealId: null, documentId: null, onboardingId: null, kind: "care_onboarding", name: "Care", test: false, templateKey: "CARE-0", templateVersion: 1, careDeferred: false, startedAt: "2026-10-15T17:00:00.000Z",
  })).project.id;
  await addCadence(env.DB, projectId, "CARE-4");
  await env.DB.prepare(`UPDATE project_cadences SET created_at = ? WHERE project_id = ? AND template_key = 'CARE-4'`).bind(o.cadenceAt ?? "2026-10-15T17:00:00.000Z", projectId).run();
  if (o.hold) expect(await placeHold(env.DB, { businessId: s.businessId, invoiceId: s.invoice!.id, now: NOV_20.toISOString() })).toBe(true);
  return { ...s, siteIds, projectId, email: o.email, name };
}
type Client = Awaited<ReturnType<typeof mk>>;

/** Uptime days as an earlier daily rollup wrote them: a full day is 288 checks. */
async function fullDays(siteId: string, first: number, last: number, failedOn: Record<number, number> = {}) {
  for (let d = first; d <= last; d++) await upsertUptimeDay(env.DB, siteId, `2026-11-${String(d).padStart(2, "0")}`, 288, 288 - (failedOn[d] ?? 0));
}
/** The raw probe checks of 29 and 30 November (a check every five minutes, all ok): the daily cron's own rollup turns them into days. */
async function rawChecks(siteId: string) {
  const base = Date.parse("2026-11-29T08:00:00.000Z"); // local midnight, PST
  const rows = Array.from({ length: 576 }, (_, k) =>
    env.DB.prepare(`INSERT INTO site_checks (id, site_id, checked_at, ok, status, ms, error) VALUES (?, ?, ?, 1, 200, 120, NULL)`).bind(crypto.randomUUID(), siteId, new Date(base + k * 300_000).toISOString()));
  for (let i = 0; i < rows.length; i += 100) await env.DB.batch(rows.slice(i, i + 100));
}
/** One finished update run, as `completeHelperJob` leaves it: the run, its helper job with the per-update outcomes, and the update row. */
async function seedRun(siteId: string, domain: string, finishedAt: string, outcome: "applied" | "rolled_back") {
  const runId = crypto.randomUUID(), jobId = crypto.randomUUID(), batchId = crypto.randomUUID(), updateId = crypto.randomUUID();
  const result = { backupFile: `${SECRETS.backupDir}/${domain}-${runId}${SECRETS.backupFile}`, steps: [{ id: updateId, outcome, note: "" }], pages: [], rolledBack: outcome === "rolled_back", retry: false };
  await env.DB.batch([
    env.DB.prepare(
      `INSERT INTO care_updates (id, site_id, type, slug, name, from_version, to_version, risk, first_seen_at, last_seen_at, status) VALUES (?, ?, 'plugin', ?, ?, '1.0', '1.1', 'minor', ?, ?, ?)`,
    ).bind(updateId, siteId, `${SECRETS.pluginSlug}-${updateId.slice(0, 6)}`, SECRETS.pluginName, finishedAt, finishedAt, outcome === "applied" ? "applied" : "available"),
    env.DB.prepare(`INSERT INTO care_batches (id, period, kind, site_id, status, created_at, updated_at) VALUES (?, '2026-11', 'single', ?, 'done', ?, ?)`).bind(batchId, siteId, finishedAt, finishedAt),
    env.DB.prepare(`INSERT INTO helper_jobs (id, kind, payload, status, result, created_at, done_at) VALUES (?, 'care.update', ?, 'done', ?, ?, ?)`)
      .bind(jobId, JSON.stringify({ runId, siteId, updates: [{ id: updateId }] }), JSON.stringify(result), finishedAt, finishedAt),
    env.DB.prepare(`INSERT INTO care_runs (id, batch_id, site_id, wave, helper_job_id, status, backup_file, summary, created_at, finished_at) VALUES (?, ?, ?, 0, ?, ?, ?, 'x', ?, ?)`)
      .bind(runId, batchId, siteId, jobId, outcome === "applied" ? "ok" : "rolled_back", result.backupFile, finishedAt, finishedAt),
  ]);
}

const care4 = async (c: Client) => (await listTasks(env.DB, c.projectId)).filter((t) => t.cadenceKey === "CARE-4");
const ticks = async (c: Client) => (await care4(c)).map((t) => t.checklist.map((x) => x.done));
const reportOf = (businessId: string, period = "2026-11") => env.DB.prepare(`SELECT * FROM care_reports WHERE business_id = ? AND period = ?`).bind(businessId, period)
  .first<{ id: string; status: string; token: string; summary: string; recommendation: string; summary_source: string; claude_task_id: string | null; approval_id: string | null; test: number; view_count: number; first_viewed_at: string | null; sent_at: string | null }>();
const reportApprovals = async () => (await env.DB.prepare(`SELECT id, status, preview, title, payload FROM approvals WHERE kind = 'care.report' ORDER BY created_at, rowid`)
  .all<{ id: string; status: string; preview: string; title: string; payload: string }>()).results.map((a) => ({ ...a, reportId: (JSON.parse(a.payload) as { reportId: string }).reportId }));
const reportTasks = async () => (await env.DB.prepare(`SELECT id, status, target_id FROM claude_tasks WHERE kind = 'care.report' ORDER BY created_at, rowid`).all<{ id: string; status: string; target_id: string }>()).results;
const activityOf = async (businessId: string, kind: string) =>
  (await api<{ activity: { kind: string; detail: string | null }[] }>("GET", `/leads/${businessId}`)).activity.filter((a) => a.kind === kind);
const tokenIn = (text: string) => [...text.matchAll(/\/m\/([A-Za-z0-9_-]{20,})/g)].map((m) => m[1]);

describe("care reports, end to end", () => {
  it("a December morning: three reports from the cron, Claude's words and a plain fallback, an approval and one mail, the client's page, a take-back and a test report that mails only the owner", async () => {
    // --- The world. Three Care clients (A: two sites, a month of checks, an outage, three update runs, a certificate 40 days out; B: began monitoring on 20 November; C: Care Plus with no checks at all), a client on billing hold
    // and a test client. Every client has an SSH alias and a folder on each site, and A carries a vault name, an access note and a subscription token: none of it may reach a client, an agent or an owner page.
    const a = await mk("Alpha Bakery", { email: "pat@alpha-bakery.test", domains: ["alpha-bakery.example.com", "alpha-shop.example.com"] });
    const b = await mk("Bravo Plumbing", { email: "pat@bravo-plumbing.test", domains: ["bravo-plumbing.example.com"], cadenceAt: "2026-11-20T17:00:00.000Z" });
    const c = await mk("Charlie Salon", { key: "care_plus", email: "pat@charlie-salon.test", domains: ["charlie-salon.example.com"] });
    const held = await mk("Delta Auto", { email: "pat@delta-auto.test", domains: ["delta-auto.example.com"], hold: true });
    const test = await mk("Test Client", { test: true, email: "pat@test-client.test", domains: ["test-client.example.com"] });
    const [aMain, aShop] = a.siteIds;
    await setAccess(env.DB, aMain, "hosting", { status: "received", vaultItem: SECRETS.vaultName, note: SECRETS.accessNote }, NOV_20.toISOString());
    await markSubscription(env.DB, a.subIds[0], { token: SECRETS.subscriptionToken });
    // November's history. A's main site: a full month, three hours down on the 14th (36 of that day's 288 checks), one clean run on the 4th and 11th each and one that was put back on the 18th; the shop site: a full month, no trouble.
    // The 29th and 30th are raw checks the daily cron rolls up itself. B: monitored since the 20th. C: nothing at all.
    await fullDays(aMain, 1, 28, { 14: 36 }); await rawChecks(aMain);
    await fullDays(aShop, 1, 28); await rawChecks(aShop);
    await fullDays(b.siteIds[0], 20, 30);
    const opened = await openIncident(env.DB, { siteId: aMain, businessId: a.businessId, kind: "down", detail: SECRETS.incidentSentence, now: "2026-11-14T18:00:00.000Z" });
    expect(opened.created).toBe(true);
    expect(await closeIncident(env.DB, aMain, "down", "2026-11-14T21:00:00.000Z")).not.toBeNull();
    await seedRun(aMain, "alpha-bakery.example.com", "2026-11-04T19:00:00.000Z", "applied");
    await seedRun(aMain, "alpha-bakery.example.com", "2026-11-11T19:00:00.000Z", "applied");
    await seedRun(aMain, "alpha-bakery.example.com", "2026-11-18T19:00:00.000Z", "rolled_back");
    await setCertExpiry(env.DB, aMain, "2027-01-11", NOV_20.toISOString()); // 40 days after 2 December

    // --- The edit hours, through the owner's routes on the days they happened. A's edit request takes 45 and 30 minutes and is done on the 20th; B's takes 30 minutes and is still open.
    const aEdit = (await api<{ taskId: string }>("POST", `/clients/${a.businessId}/edit-requests`, { title: "Update the menu page" }, 201)).taskId;
    const bEdit = (await api<{ taskId: string }>("POST", `/clients/${b.businessId}/edit-requests`, { title: "New phone number" }, 201)).taskId;
    at(NOV_12);
    await api("POST", `/tasks/${aEdit}/time`, { day: "2026-11-12", minutes: 45 }, 201);
    await api("POST", `/tasks/${bEdit}/time`, { day: "2026-11-12", minutes: 30 }, 201);
    at(NOV_18);
    await api("POST", `/tasks/${aEdit}/time`, { day: "2026-11-18", minutes: 30 }, 201);
    at(NOV_20);
    await api("POST", `/tasks/${aEdit}/complete`, {});
    // On the last day of the month Today reads the month still running: A has used 125% of its 60 minutes (over), B 50% (nothing to say).
    at(NOV_30);
    const todayNov = (await api<{ items: { kind: string; businessId: string; reason: string; priority: number }[] }>("GET", "/today")).items.filter((i) => i.kind === "care_edit_hours");
    expect(todayNov).toEqual([expect.objectContaining({ businessId: a.businessId, reason: "Alpha Bakery has used 125% of this month's edit hours", priority: 64 })]);
    expect((await api<{ ledger: unknown }>("GET", `/clients/${a.businessId}/edit-ledger?month=2026-11`)).ledger).toEqual({ month: "2026-11", allowanceMinutes: 60, usedMinutes: 75, percent: 125, state: "over" });
    expect((await api<{ ledger: unknown }>("GET", `/clients/${b.businessId}/edit-ledger?month=2026-11`)).ledger).toEqual({ month: "2026-11", allowanceMinutes: 60, usedMinutes: 30, percent: 50, state: "ok" });
    expect((await api<{ ledger: unknown }>("GET", `/clients/${c.businessId}/edit-ledger?month=2026-11`)).ledger).toEqual({ month: "2026-11", allowanceMinutes: 180, usedMinutes: 0, percent: 0, state: "ok" });
    expect((await api<{ ledger: unknown }>("GET", `/clients/${a.businessId}/edit-ledger`)).ledger).toMatchObject({ month: "2026-11", usedMinutes: 75 });

    // The mail transport goes in: from here on every message the app sends is seen. Nothing may go out before a yes.
    mail = await readyToSend();
    setMailDeps({ ...getMailDeps(), now: () => new Date() });

    // --- 2 December, 09:00. The daily cron runs: the rollup settles 29 and 30 November, each Care client's CARE-4 task of December is made, and the reports of November start for A, B and C only.
    at(START);
    await runScheduled(EV, DAILY_CRON, START);
    const reports = (await env.DB.prepare(`SELECT business_id, status, test, period FROM care_reports ORDER BY business_id`).all<{ business_id: string; status: string; test: number; period: string }>()).results;
    expect(reports.map((r) => r.business_id).sort()).toEqual([a.businessId, b.businessId, c.businessId].sort());
    for (const r of reports) expect(r).toMatchObject({ status: "collecting", test: 0, period: "2026-11" });
    expect(await reportOf(held.businessId)).toBeNull();
    expect(await reportOf(test.businessId)).toBeNull();
    const tasks = await reportTasks();
    expect(tasks.map((t) => t.target_id).sort()).toEqual((await Promise.all([a, b, c].map(async (x) => (await reportOf(x.businessId))!.id))).sort());
    for (const t of tasks) expect(t.status).toBe("pending");
    // CARE-4's first and fourth items are ticked for the three; the held and the test client have no task of the month.
    for (const x of [a, b, c]) expect(await ticks(x)).toEqual([[true, false, false, true, false, false]]);
    expect(await ticks(held)).toEqual([]);
    expect(await ticks(test)).toEqual([]);
    // The rollup wrote the 29th and 30th for A's sites from the raw checks, and PageSpeed was asked once for each of the four monitored sites of the three reports (never the held or the test client's).
    expect((await env.DB.prepare(`SELECT checks, ok_checks FROM site_uptime_days WHERE site_id = ? AND day IN ('2026-11-29', '2026-11-30') ORDER BY day`).bind(aMain).all()).results).toEqual([{ checks: 288, ok_checks: 288 }, { checks: 288, ok_checks: 288 }]);
    const psiUrls = outside.filter((u) => u.includes("pagespeedonline")).map((u) => decodeURIComponent(new URL(u).searchParams.get("url")!)).sort();
    expect(psiUrls).toEqual(["alpha-bakery", "alpha-shop", "bravo-plumbing", "charlie-salon"].map((n) => `https://${n}.example.com/`).sort());
    expect(outside.filter((u) => !u.includes("pagespeedonline"))).toEqual([]);
    // A second run on the same morning, and one the next day, change nothing.
    await runScheduled(EV, DAILY_CRON, START);
    at(new Date(START.getTime() + 86_400_000));
    await runScheduled(EV, DAILY_CRON, new Date(START.getTime() + 86_400_000));
    at(START);
    expect(await count("care_reports")).toBe(3);
    expect(await count("claude_tasks", "kind = 'care.report'")).toBe(3);
    expect(await count("approvals", "kind = 'care.report'")).toBe(0);
    expect(mail.sent).toEqual([]);
    // Today has no edit-hours row in the new month.
    expect((await api<{ items: { kind: string }[] }>("GET", "/today")).items.filter((i) => i.kind === "care_edit_hours")).toEqual([]);

    // --- The frozen facts of A: one report for the client, both sites, November's real numbers.
    const aReport = (await reportOf(a.businessId))!;
    const aFacts = ReportFacts.parse(JSON.parse((await env.DB.prepare(`SELECT facts FROM care_reports WHERE id = ?`).bind(aReport.id).first<{ facts: string }>())!.facts));
    expect(aFacts).toMatchObject({ period: "2026-11", label: "November 2026", clientName: "Alpha Bakery", edits: { allowanceMinutes: 60, usedMinutes: 75, percent: 125, state: "over", requestsDone: 1 } });
    const main = aFacts.sites.find((s) => s.domain === "alpha-bakery.example.com")!;
    const shop = aFacts.sites.find((s) => s.domain === "alpha-shop.example.com")!;
    expect(main).toMatchObject({ monitoredSince: "2026-11-01", uptimePercent: 99.6, coveredDays: 30, incidents: 1, longestOutageMinutes: 180, updatesApplied: 2, updatesRolledBack: 1, updatesFailed: 0, backups: 3, speedScore: 34 });
    expect(shop).toMatchObject({ uptimePercent: 100, coveredDays: 30, incidents: 0, longestOutageMinutes: null, updatesApplied: 0, backups: 0, speedScore: 34 });
    expect(aFacts.renewals).toEqual([{ what: "certificate", domain: "alpha-bakery.example.com", on: "2027-01-11" }]);
    const bFacts = ReportFacts.parse(JSON.parse((await env.DB.prepare(`SELECT facts FROM care_reports WHERE business_id = ?`).bind(b.businessId).first<{ facts: string }>())!.facts));
    expect(bFacts.sites).toEqual([expect.objectContaining({ domain: "bravo-plumbing.example.com", monitoredSince: "2026-11-20", coveredDays: 11, uptimePercent: 100, incidents: 0 })]);
    expect(bFacts.edits).toMatchObject({ allowanceMinutes: 60, usedMinutes: 30, percent: 50, state: "ok", requestsDone: 0 });
    const cFacts = ReportFacts.parse(JSON.parse((await env.DB.prepare(`SELECT facts FROM care_reports WHERE business_id = ?`).bind(c.businessId).first<{ facts: string }>())!.facts));
    expect(cFacts.sites).toEqual([expect.objectContaining({ domain: "charlie-salon.example.com", monitoredSince: null, uptimePercent: null, coveredDays: 0, incidents: 0, longestOutageMinutes: null })]);
    expect(cFacts.edits).toMatchObject({ allowanceMinutes: 180, usedMinutes: 0, state: "ok" });

    // --- Claude writes A's words: what it is shown holds no secret, and a good answer through the queue's own completion makes the report ready with one approval.
    const aTask = tasks.find((t) => t.target_id === aReport.id)!;
    const claimed = await claimById(aTask.id);
    const bundle = await buildBundle(EV, claimed);
    expect("text" in bundle).toBe(true);
    const shown = (bundle as { text: string }).text;
    expect(shown).toContain("alpha-bakery.example.com");
    expect(shown).toContain("uptime 99.6%");
    for (const [what, value] of Object.entries(SECRETS)) expect(shown, `${what} is in what Claude is shown`).not.toContain(value);
    for (const word of [ALIAS_WORD, PATH_WORD]) expect(shown).not.toContain(word);
    expect(shown.split("<untrusted_site_content>")[1]).not.toMatch(/https?:\/\//); // the numbers Claude is given hold no address
    expect(await completeTask(EV, aTask.id, { summary: A_SUMMARY, recommendation: A_REC })).toEqual({ ok: true });
    const aReady = (await reportOf(a.businessId))!;
    expect(aReady).toMatchObject({ status: "ready", summary: A_SUMMARY, recommendation: A_REC, summary_source: "claude" });
    expect(aReady.approval_id).not.toBeNull();

    // C's words go in through the MCP route: a link in them is refused (the task stays claimed), a good answer is taken.
    const cReport = (await reportOf(c.businessId))!;
    const cTask = tasks.find((t) => t.target_id === cReport.id)!;
    await claimById(cTask.id);
    const refused = await tool("complete_claude_task", { id: cTask.id, result: { summary: "Charlie Salon was fine. See https://charlie-salon.example.com/report for more.", recommendation: C_REC } });
    expect(refused.isError).toBe(true);
    expect(refused.text).toMatch(/link/i);
    expect((await env.DB.prepare(`SELECT status FROM claude_tasks WHERE id = ?`).bind(cTask.id).first<{ status: string }>())!.status).toBe("claimed");
    expect((await reportOf(c.businessId))!.status).toBe("collecting");
    expect(await count("approvals", "kind = 'care.report'")).toBe(1);
    const goodC = await tool("complete_claude_task", { id: cTask.id, result: { summary: C_SUMMARY, recommendation: C_REC } });
    expect(goodC).toEqual({ text: "done", isError: false });
    expect(await reportOf(c.businessId)).toMatchObject({ status: "ready", summary: C_SUMMARY, summary_source: "claude" });

    // --- Nobody picks up B's task. Two weeks on, the daily cron expires it, and the report gets the sentence the code wrote from the numbers, with its own approval.
    expect((await reportOf(b.businessId))!.status).toBe("collecting");
    at(DEC_17);
    cookie = ""; // the owner's session from November has run out: signing in again is part of the day
    await runScheduled(EV, DAILY_CRON, DEC_17);
    const bReady = (await reportOf(b.businessId))!;
    expect(bReady).toMatchObject({ status: "ready", summary_source: "plain", recommendation: "" });
    expect(bReady.summary).toBe(plainSummary(bFacts));
    expect(bReady.summary).toContain("bravo-plumbing.example.com was up 100% of the time (checked from November 20, 11 days)");
    expect(await count("care_reports")).toBe(3); // the cron of the 17th made no new report
    expect(await count("claude_tasks", "kind = 'care.report'")).toBe(3);
    const approvals = await reportApprovals();
    expect(approvals).toHaveLength(3);
    for (const x of approvals) expect(x.status).toBe("pending");
    expect(new Set(approvals.map((x) => x.reportId))).toEqual(new Set([aReady.id, bReady.id, (await reportOf(c.businessId))!.id]));
    const approvalOf = (r: { id: string }) => approvals.find((x) => x.reportId === r.id)!;
    expect(approvalOf(aReady).title).toBe("Send the November 2026 report to Alpha Bakery");
    expect(approvalOf(aReady).preview).toContain("pat@alpha-bakery.test");
    expect(approvalOf(aReady).preview).toContain("Written by Claude from the numbers.");
    expect(approvalOf(aReady).preview).toContain("up 99.6% over 30 days checked, 1 incident (longest about 180 minutes), 2 updates applied, 1 rolled back");
    expect(approvalOf(aReady).preview).toContain("Edit time: 75 of 60 edit minutes used, 1 edit request done");
    expect(approvalOf(aReady).preview).toContain("Coming up: certificate for alpha-bakery.example.com on 2027-01-11");
    expect(approvalOf(aReady).preview).toContain(`/m/${aReady.token}`);
    expect(approvalOf(bReady).preview).toContain("This summary was not written by Claude");
    // The Today feed on the 17th still reads December's edit hours: none were logged.
    expect((await api<{ items: { kind: string }[] }>("GET", "/today")).items.filter((i) => i.kind === "care_edit_hours")).toEqual([]);
    expect(mail.sent).toEqual([]);

    // --- The owner's list: the three reports are ready, each with its edit hours and a link; the claim is only A's and C's words, and B's report carries the code's own.
    const list = await api<{ period: string; reports: { id: string; client: string; status: string; source: string; link: string | null; ledger: { usedMinutes: number; state: string } | null; views: number }[] }>("GET", "/care/reports");
    expect(list.period).toBe("2026-11");
    expect(list.reports.map((r) => [r.client, r.status, r.source]).sort()).toEqual([["Alpha Bakery", "ready", "claude"], ["Bravo Plumbing", "ready", "plain"], ["Charlie Salon", "ready", "claude"]]);
    expect(list.reports.find((r) => r.client === "Alpha Bakery")!.ledger).toMatchObject({ usedMinutes: 75, state: "over" });
    expect(list.reports.find((r) => r.client === "Bravo Plumbing")!.ledger).toMatchObject({ usedMinutes: 30, state: "ok" });
    // A report that was never sent is not a page: B's link, still ready, is a 404 and counts no view.
    expect((await page(bReady.token)).status).toBe(404);
    expect((await page(aReady.token)).status).toBe(404);
    expect((await reportOf(b.businessId))!.view_count).toBe(0);

    // --- Logan approves A's report: one mail goes to A's contact, the report is sent, 1.2 and 1.3 are ticked on December's task and the timeline says so once.
    expect(await approve(EV, approvalOf(aReady).id)).toEqual({ ok: true });
    expect(mail.sent).toHaveLength(1);
    const sent = mail.sent[0];
    expect(sent.to).toBe("pat@alpha-bakery.test");
    expect(sent.subject).toBe("Your site's report for November 2026");
    expect(sent.text).toContain(A_SUMMARY);
    expect(sent.text).toContain("Hi Pat,");
    expect(tokenIn(sent.text)).toEqual([aReady.token]); // only A's own link
    expect(sent.text).toContain(`https://clients.hellositeline.test/m/${aReady.token}`);
    for (const other of [bReady.token, (await reportOf(c.businessId))!.token]) expect(sent.text + sent.html).not.toContain(other);
    const aSent = (await reportOf(a.businessId))!;
    expect(aSent).toMatchObject({ status: "sent" });
    expect(aSent.sent_at).toBe(DEC_17.toISOString());
    expect(await ticks(a)).toEqual([[true, true, true, true, false, false]]);
    expect(await ticks(b)).toEqual([[true, false, false, true, false, false]]);
    expect(await activityOf(a.businessId, "care_report_sent")).toEqual([expect.objectContaining({ detail: "November 2026 report sent to pat@alpha-bakery.test" })]);
    expect((await env.DB.prepare(`SELECT status FROM approvals WHERE id = ?`).bind(approvalOf(aReady).id).first<{ status: string }>())!.status).toBe("approved");

    // --- The client opens the link from the mail: the page has the figures, and the view is counted. The same link for B (not sent) stays a 404.
    const open = await page(tokenIn(sent.text)[0]);
    expect(open.status).toBe(200);
    expect(Object.keys(open.json).sort()).toEqual(["clientName", "edits", "label", "recommendation", "renewals", "sentOn", "sites", "summary"]);
    expect(open.json).toMatchObject({
      clientName: "Alpha Bakery", label: "November 2026", summary: A_SUMMARY, recommendation: A_REC, sentOn: "2026-12-17",
      edits: { usedMinutes: 75, allowanceMinutes: 60, state: "over", requestsDone: 1 },
      renewals: [{ what: "certificate", domain: "alpha-bakery.example.com", on: "2027-01-11" }],
    });
    const pMain = open.json.sites.find((s: { domain: string }) => s.domain === "alpha-bakery.example.com");
    const pShop = open.json.sites.find((s: { domain: string }) => s.domain === "alpha-shop.example.com");
    expect(open.json.sites).toHaveLength(2);
    expect(pMain).toEqual({ domain: "alpha-bakery.example.com", uptimePercent: 99.6, coveredDays: 30, monitoredSince: "2026-11-01", incidents: 1, longestOutageMinutes: 180, updatesApplied: 2, updatesRolledBack: 1, backups: 3, speedScore: 34 });
    expect(pMain.uptimePercent).toBeLessThan(100);
    expect(pShop).toMatchObject({ uptimePercent: 100, incidents: 0, longestOutageMinutes: null, updatesApplied: 0, updatesRolledBack: 0 });
    const viewed = (await reportOf(a.businessId))!;
    expect(viewed.view_count).toBe(1);
    expect(viewed.first_viewed_at).toBe(DEC_17.toISOString());
    expect((await page(bReady.token)).status).toBe(404);
    expect((await page("not-a-token")).status).toBe(404);
    expect((await reportOf(b.businessId))!.view_count).toBe(0);

    // --- Approving A's approval a second time sends nothing.
    expect(await approve(EV, approvalOf(aReady).id)).toMatchObject({ ok: false, status: 409 });
    expect(mail.sent).toHaveLength(1);
    expect(await activityOf(a.businessId, "care_report_sent")).toHaveLength(1);

    // --- The MCP route: the month's reports in one answer, without a link or a token; the rehearsal client's report is not in it.
    const tools = await mcp("tools/list");
    expect(tools.result.tools.map((t: { name: string }) => t.name)).toContain("get_care_report");
    const overview = await ask("get_care_report", { period: "2026-11" });
    expect(overview.period).toBe("2026-11");
    expect(overview.reports.map((r: { client: string; status: string }) => [r.client, r.status])).toEqual([["Alpha Bakery", "sent"], ["Bravo Plumbing", "ready"], ["Charlie Salon", "ready"]]);
    const mcpA = overview.reports[0];
    expect(mcpA).toMatchObject({ summary: A_SUMMARY, sentOn: "2026-12-17", views: 1, ledger: { usedMinutes: 75, state: "over" }, headline: { editRequestsDone: 1 } });
    expect(mcpA.headline.sites.find((s: { domain: string }) => s.domain === "alpha-bakery.example.com")).toMatchObject({ uptimePercent: 99.6, incidents: 1, longestOutageMinutes: 180, updatesApplied: 2, updatesRolledBack: 1 });

    // --- The take-back: A's report is revoked from the owner's list and its page is a 404 at once.
    const revoked = await api<{ report: { status: string; link: string | null } }>("POST", `/care/reports/${aSent.id}/revoke`, {});
    expect(revoked.report).toMatchObject({ status: "revoked", link: null });
    expect((await page(aSent.token)).status).toBe(404);
    expect((await reportOf(a.businessId))!).toMatchObject({ status: "revoked", view_count: 1 });
    expect(await api("POST", `/care/reports/${aSent.id}/revoke`, {}, 409)).toMatchObject({ error: expect.stringContaining("taken back") });
    expect(mail.sent).toHaveLength(1);

    // --- The rehearsal: "Build now" for the test client makes a `test` report, Claude writes its words, and the approved mail goes to the owner only, with "[Test] " on the subject.
    const built = await api<{ report: { id: string; status: string; period: string } }>("POST", `/clients/${test.businessId}/care-report`, {}, 201);
    expect(built.report).toMatchObject({ status: "collecting", period: "2026-11" });
    expect(await api("POST", `/clients/${test.businessId}/care-report`, {}, 200)).toMatchObject({ report: { id: built.report.id } });
    const testRow = (await reportOf(test.businessId))!;
    expect(testRow.test).toBe(1);
    const testTask = (await reportTasks()).find((t) => t.target_id === testRow.id)!;
    await claimById(testTask.id);
    expect(await completeTask(EV, testTask.id, { summary: "A rehearsal report: nothing is monitored for a test client.", recommendation: "This is a test." })).toEqual({ ok: true });
    const testApproval = (await reportApprovals()).find((x) => x.reportId === testRow.id)!;
    expect(testApproval.preview).toContain(`To: ${OWNER_EMAIL} (a test: nothing goes to`);
    expect(testApproval.preview).toContain("Subject: [Test] Your site's report for November 2026");
    expect(await approve(EV, testApproval.id)).toEqual({ ok: true });
    expect(mail.sent).toHaveLength(2);
    expect(mail.sent[1].to).toBe(OWNER_EMAIL);
    expect(mail.sent[1].subject).toBe("[Test] Your site's report for November 2026");
    expect(mail.sent.map((m) => m.to)).not.toContain("pat@test-client.test");
    expect((await reportOf(test.businessId))!.status).toBe("sent");
    // Its link opens the same page, nearly empty: a rehearsal client has no monitored sites and no live real Care plan, so no uptime and no edit hours.
    const rehearsalPage = await page(tokenIn(mail.sent[1].text)[0]);
    expect(rehearsalPage.status).toBe(200);
    expect(rehearsalPage.json).toMatchObject({ clientName: "Test Client", sites: [], edits: null, renewals: [] });
    // The held client got no report and no mail; the rehearsal client's report is not in the agent's answer.
    expect(mail.sent.map((m) => m.to)).not.toContain("pat@delta-auto.test");
    expect(await reportOf(held.businessId)).toBeNull();
    const afterTest = await ask("get_care_report", { period: "2026-11" });
    expect(afterTest.reports.map((r: { client: string }) => r.client)).not.toContain("Test Client");

    // --- The other MCP answers a client's report could leak through.
    await ask("get_care_overview");
    await ask("list_incidents", {});
    await ask("get_client", { id: a.businessId });

    // --- Nothing a client, an agent or the owner's pages can read has an alias, a folder, a backup file name, a vault name, an access note, a plugin name, an incident sentence or a subscription token; the only token in a mail
    // is the client's own link; every number is finite; and nothing was logged as an error.
    const allApi = [...apiBodies, JSON.stringify(await api("GET", "/approvals")), JSON.stringify(await api("GET", "/care/reports?period=2026-11"))];
    const everything = [...allApi, ...publicBodies, ...mcpBodies, ...mail.sent.flatMap((m) => [m.subject, m.text, m.html]), shown];
    expect(everything.length).toBeGreaterThan(30);
    for (const body of everything) {
      for (const word of [ALIAS_WORD, PATH_WORD, ...Object.values(SECRETS)]) expect(body, `${word} reached a body`).not.toContain(word);
    }
    for (const body of [...publicBodies, ...mcpBodies]) {
      for (const row of await env.DB.prepare(`SELECT token FROM care_reports`).all<{ token: string }>().then((r) => r.results)) expect(body).not.toContain(row.token);
    }
    expect(tokenIn(mail.sent[1].text)).toEqual([testRow.token]);
    expectFiniteNumbers(open.json);
    expectFiniteNumbers(overview);
    expect(rdap.every((u) => u.startsWith("https://rdap.org/domain/"))).toBe(true);
    expect(errors).toEqual([]);
  });
});
