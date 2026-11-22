import { createExecutionContext, env } from "cloudflare:test";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import worker from "../src/worker/index";
import { approve } from "../src/worker/approvals/decide";
import "../src/worker/approvals/careUpdates";
import { getMailDeps, setMailDeps } from "../src/worker/mail/deps";
import { markSubscription } from "../src/worker/db/subscriptions";
import { addCadence, createProject } from "../src/worker/db/projects";
import { ensureSeedSops } from "../src/worker/db/sops";
import { ACCESS_KEYS, createSite, setAccess, updateSite } from "../src/worker/db/sites";
import { listTasks } from "../src/worker/db/tasks";
import { createDevice } from "../src/worker/helper/auth";
import "../src/worker/helper/kinds";
import { monitoringDeps } from "../src/worker/monitoring/sweep";
import { completeTask } from "../src/worker/queue/db";
import "../src/worker/queue/kinds";
import { DAILY_CRON, runScheduled } from "../src/worker/schedule";
import { seedClient } from "./fixtures/clients";
import { E } from "./fixtures/close";
import { readyToSend } from "./fixtures/documents";
import { claimById } from "./fixtures/draftTask";
import { tool } from "./fixtures/mcp";
import { expectFiniteNumbers } from "./fixtures/numbers";
import { T0, resetProjectWork } from "./fixtures/projects";

// The Care update batch, end to end, through the entry points the app really uses: the daily cron (which starts the Wednesday batch and queues the certificate read), the Mac helper's own
// routes under /helper with a real device token (claim, upload, touch, complete), the owner's routes under /api, the real approval path, the MCP route and the queue's own completion
// for Claude's look at a changed page. The only fakes are the outside world the daily cron reaches (the registry lookup, a recorder that answers nothing) and the mail transport, which must
// see nothing; the helper itself is played by this test. No WordPress, SSH, Chrome, ffmpeg or TLS call is ever made. The calendar is fixed: Wednesday 2 December 2026, 09:00 in Los Angeles.
const START = new Date("2026-12-02T17:00:00.000Z");
const at = (d: Date) => vi.setSystemTime(d);
const ctx = () => createExecutionContext();

const SECRETS = { vaultName: "VAULT-NAME-SENTINEL", accessNote: "ACCESS-NOTE-SENTINEL", subscriptionToken: "SUBSCRIPTION-TOKEN-SENTINEL", pluginName: "PLUGIN-NAME-SENTINEL" };
/** What a client's SSH details look like in a payload: they may be in a helper job and nowhere else an agent or the page can read. */
const ALIAS_WORD = "host-alias";
const PATH_WORD = "/var/www/";
const JPEG = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0, 16, 0x4a, 0x46, 0x49, 0x46, 0, 1, 1, 0, 0, 1, 0, 1, 0, 0, 0xff, 0xd9]);

let cookie = "";
let token = "";
let errors: unknown[][] = [];
let rdap: string[] = [];
const realFetch = monitoringDeps.fetch;
let mail: Awaited<ReturnType<typeof readyToSend>>;

beforeEach(async () => {
  errors = []; rdap = []; cookie = "";
  vi.spyOn(console, "error").mockImplementation((...a: unknown[]) => { errors.push(a); });
  vi.spyOn(console, "warn").mockImplementation(() => {});
  vi.spyOn(console, "log").mockImplementation(() => {});
  vi.useFakeTimers({ toFake: ["Date"] });
  at(START);
  // The daily cron looks up domain expiry too: the registry answers nothing, and the test counts the questions.
  monitoringDeps.fetch = (async (input: RequestInfo | URL) => { rdap.push(String(input)); return new Response("{}", { status: 404 }); }) as typeof fetch;
  for (const t of ["care_page_checks", "care_runs", "care_batches", "care_updates", "site_inventories", "site_incidents", "site_checks", "helper_jobs", "helper_devices"]) await env.DB.prepare(`DELETE FROM ${t}`).run();
  await resetProjectWork();
  for (const t of ["billing_holds", "invoice_nudges", "invoices", "subscriptions", "document_views", "document_signatures", "documents", "deals", "activity", "drafts", "audits", "search_results", "businesses", "suppressions", "approvals"])
    await env.DB.prepare(`DELETE FROM ${t}`).run();
  await env.DB.prepare(`UPDATE mailboxes SET enabled = 0`).run();
  await env.DB.batch([env.DB.prepare(`DELETE FROM sop_template_steps`), env.DB.prepare(`DELETE FROM sop_templates`)]);
  await ensureSeedSops(env.DB);
  token = (await createDevice(env.DB, "Studio Mac")).token;
});
afterEach(() => {
  monitoringDeps.fetch = realFetch;
  vi.useRealTimers();
  vi.restoreAllMocks();
  setMailDeps(null);
});

// --- the owner's side -------------------------------------------------------------------------------------------------------------------------------------------------

async function owner(method: string, path: string, body?: unknown) {
  if (!cookie) {
    const login = await worker.fetch(new Request("https://x/api/login", { method: "POST", body: JSON.stringify({ password: "test-pass" }), headers: { "content-type": "application/json" } }), E, ctx());
    expect(login.status).toBe(200);
    cookie = login.headers.get("set-cookie")!.split(";")[0];
  }
  return worker.fetch(new Request(`https://x/api${path}`, { method, body: body === undefined ? undefined : JSON.stringify(body), headers: { cookie, "content-type": "application/json" } }), E, ctx());
}
/** Every /api body the test reads, as text, so the last check can look through all of them. */
const apiBodies: string[] = [];
const api = async <T = any>(method: string, path: string, body?: unknown, expected = 200): Promise<T> => {
  const r = await owner(method, path, body);
  expect(r.status, `${method} ${path} ${r.status}`).toBe(expected);
  const text = await r.text();
  apiBodies.push(text);
  return JSON.parse(text) as T;
};

// --- the helper's side: what the Mac does, through the real /helper routes ------------------------------------------------------------------------------------------------

interface Job { id: string; kind: string; attempts: number; payload: Record<string, any>; inputs: string[]; outputs: string[] }
const helperCall = (path: string, init: RequestInit = {}) =>
  worker.fetch(new Request(`https://x/helper${path}`, { ...init, headers: { authorization: `Bearer ${token}`, "cf-connecting-ip": "203.0.113.9", ...(init.headers ?? {}) } }), E, ctx());
const post = (path: string, body: unknown = {}) => helperCall(path, { method: "POST", body: JSON.stringify(body), headers: { "content-type": "application/json" } });

/** The next waiting job of one kind, or null. */
async function claim(kind: string): Promise<Job | null> {
  const r = await post("/jobs/claim", { kinds: [kind] });
  expect(r.status).toBe(200);
  return ((await r.json()) as { job?: Job }).job ?? null;
}
async function claimAll(kind: string): Promise<Job[]> {
  const out: Job[] = [];
  for (let j = await claim(kind); j; j = await claim(kind)) out.push(j);
  return out;
}
async function upload(job: Job, key: string) {
  const r = await helperCall(`/jobs/${job.id}/output?key=${encodeURIComponent(key)}`, { method: "PUT", body: JPEG, headers: { "content-type": "image/jpeg" } });
  expect(r.status, `upload ${key}`).toBe(200);
}
async function complete(job: Job, result: unknown) {
  const r = await post(`/jobs/${job.id}/complete`, { result });
  expect(r.status, `complete ${job.kind}: ${await r.clone().text()}`).toBe(200);
}

const page = (path: string, o: { afterStatus?: number; verdict?: "ok" | "changed" | "broken"; ssim?: number; up?: Partial<Record<"before" | "after" | "diff", boolean>> } = {}) => ({
  path,
  before: { status: 200, fatal: false, forms: 1 },
  after: { status: o.afterStatus ?? 200, fatal: false, forms: 1 },
  ssim: o.ssim ?? 0.99,
  verdict: o.verdict ?? "ok",
  uploaded: { before: false, after: false, diff: false, ...(o.up ?? {}) },
});
const item = (slug: string, version: string, updateVersion: string | null, name = slug) => ({ slug, name, status: "active", version, updateVersion, fromWporg: true });
const inventoryResult = (plugins: ReturnType<typeof item>[], dropped = 0) =>
  ({ wpVersion: "6.4.2", phpVersion: "8.2.1", core: null, plugins, themes: [], activeTheme: "twentytwentyfour", dropped });

// --- the world ------------------------------------------------------------------------------------------------------------------------------------------------------------

const count = async (table: string, where = "1 = 1") => (await env.DB.prepare(`SELECT COUNT(*) AS n FROM ${table} WHERE ${where}`).first<{ n: number }>())!.n;
const resolveAccess = async (siteId: string) => { for (const k of ACCESS_KEYS) await setAccess(env.DB, siteId, k, { status: "received" }, START.toISOString()); };
const activityOf = async (businessId: string, kind: string) =>
  (await api<{ activity: { kind: string; detail: string | null }[] }>("GET", `/leads/${businessId}`)).activity.filter((a) => a.kind === kind);

/** A real client with live Care and a brochure site on the given domain, read over SSH. `ssh: false` leaves the site on MainWP; a Care project with the weekly checklist is made unless `care` is false. */
async function mk(name: string, domain: string, o: { cents?: number; ssh?: boolean; mainwp?: boolean; test?: boolean; care?: boolean; paths?: string[] }) {
  const s = await seedClient({ test: o.test, subs: o.care === false ? [] : [{ key: "care", monthlyCents: o.cents ?? 5000, test: o.test }] });
  await env.DB.prepare(`UPDATE businesses SET name = ? WHERE id = ?`).bind(name, s.businessId).run();
  await updateSite(env.DB, s.site!.id, { url: `https://${domain}/`, domain }, START.toISOString());
  const short = domain.split(".")[0];
  if (o.ssh !== false) {
    await env.DB.prepare(`UPDATE sites SET cms = 'wordpress', access_method = ?, wp_ssh_alias = ?, wp_path = ?, care_paths = ? WHERE id = ?`)
      .bind(o.mainwp ? "mainwp" : "ssh_wpcli", o.mainwp ? null : `${ALIAS_WORD}-${short}`, o.mainwp ? null : `${PATH_WORD}${short}`, JSON.stringify(o.paths ?? ["/"]), s.site!.id).run();
  }
  await resolveAccess(s.site!.id); // so nothing but the updates moves the score
  let careProject: { id: string } | null = null;
  if (o.care !== false && !o.test) {
    careProject = (await createProject(env.DB, {
      businessId: s.businessId, dealId: null, documentId: null, onboardingId: null, kind: "care_onboarding", name: "Care", test: false, templateKey: "CARE-0", templateVersion: 1, careDeferred: false, startedAt: T0,
    })).project;
    await addCadence(env.DB, careProject.id, "CARE-1");
  }
  return { ...s, siteId: s.site!.id, domain, careProject };
}
type Client = Awaited<ReturnType<typeof mk>>;

const care1 = async (c: Client) => (await listTasks(env.DB, c.careProject!.id)).find((t) => t.cadenceKey === "CARE-1" && t.periodKey === "2026-W49")!;
const ticks = async (c: Client) => (await care1(c)).checklist.map((x) => x.done);
const waveApprovals = async () => (await env.DB.prepare(`SELECT id, title, preview, status, payload FROM approvals WHERE kind = 'care.updates' ORDER BY created_at, rowid`)
  .all<{ id: string; title: string; preview: string; status: string; payload: string }>()).results.map((a) => ({ ...a, payload: JSON.parse(a.payload) as { batchId: string; wave: number; sites: { siteId: string; domain: string; updates: { slug: string; to: string; needsTick: boolean }[] }[] } }));
const updatesOf = async (siteId: string) => (await env.DB.prepare(`SELECT slug, status FROM care_updates WHERE site_id = ? ORDER BY slug`).bind(siteId).all<{ slug: string; status: string }>()).results.map((r) => [r.slug, r.status]);

describe("care updates, end to end", () => {
  it("a Wednesday batch: inventories, a canary, Claude's look, a second wave with one rollback, a single-site run and a certificate warning; nothing is mailed and nothing secret is shown", async () => {
    // --- The world. Three brochure clients with Care (A the cheapest, so the canary), a Care client on MainWP, a test client with a test site, and a client without Care.
    const a = await mk("Alpha Bakery", "alpha-bakery.example.com", { cents: 5_000, paths: ["/", "/contact"] });
    const b = await mk("Bravo Plumbing", "bravo-plumbing.example.com", { cents: 6_000, paths: ["/"] });
    const c = await mk("Charlie Salon", "charlie-salon.example.com", { cents: 7_000, paths: ["/", "/contact"] });
    const mainwp = await mk("Mainwp Co", "mainwp-co.example.com", { cents: 5_000, mainwp: true });
    const test = await mk("Test Client", "test-client.example.com", { cents: 12_900, test: true, paths: ["/"] });
    const nocare = await mk("No Care Co", "no-care.example.com", { care: false });
    // Things that must never reach an agent or a page: a vault name, an access note and a subscription token.
    await setAccess(env.DB, a.siteId, "hosting", { status: "received", vaultItem: SECRETS.vaultName, note: SECRETS.accessNote }, START.toISOString());
    await markSubscription(env.DB, a.subIds[0], { token: SECRETS.subscriptionToken });

    // The mail transport goes in: from here on, every message the app sends is seen.
    mail = await readyToSend();
    setMailDeps({ ...getMailDeps(), now: () => new Date() });
    const before = { tasks: await count("tasks"), mail: mail.sent.length };

    // --- 09:00. The daily cron runs. It starts the week's batch and queues one inventory for each of the three SSH sites with Care, and none for MainWP, the test client or the client without Care.
    await runScheduled(E, DAILY_CRON, START);
    const inventories = (await env.DB.prepare(`SELECT payload, dedupe_key FROM helper_jobs WHERE kind = 'care.inventory'`).all<{ payload: string; dedupe_key: string }>()).results;
    expect(inventories.map((j) => JSON.parse(j.payload).siteId).sort()).toEqual([a.siteId, b.siteId, c.siteId].sort());
    for (const j of inventories) {
      expect(Object.keys(JSON.parse(j.payload)).sort()).toEqual(["alias", "batchId", "path", "siteId"]);
      expect(j.dedupe_key).toMatch(/^care\.inventory:.+:2026-W49$/);
    }
    for (const s of [mainwp, test, nocare]) expect(JSON.stringify(inventories)).not.toContain(s.siteId);
    const batch = (await api<{ batch: { id: string; period: string; kind: string; status: string } }>("GET", "/care/updates")).batch;
    expect(batch).toMatchObject({ period: "2026-W49", kind: "weekly", status: "inventory" });
    // The cron ran the project sweep too: each client has this week's CARE-1 checklist, and the batch has begun to tick it (1.1 and 1.2 wait for the inventories).
    for (const x of [a, b, c]) expect(await ticks(x)).toEqual([false, false, false, false, false, false]);
    // A second run on the same morning queues nothing new.
    await runScheduled(E, DAILY_CRON, START);
    expect(await count("helper_jobs", "kind = 'care.inventory'")).toBe(3);
    expect(await count("care_batches")).toBe(1);
    // The one daily certificate read is queued too (Care sites with an address; never the test client's).
    const certJobs = (await env.DB.prepare(`SELECT payload FROM helper_jobs WHERE kind = 'care.certs'`).all<{ payload: string }>()).results;
    expect(certJobs).toHaveLength(1);
    const certHosts = (JSON.parse(certJobs[0].payload) as { hosts: { siteId: string; host: string }[] }).hosts;
    expect(certHosts.map((h) => h.siteId)).toContain(a.siteId);
    expect(certHosts.map((h) => h.siteId)).not.toContain(test.siteId);
    expect(certHosts.map((h) => h.siteId)).not.toContain(nocare.siteId);

    // --- The helper takes the three inventories (one at a time) and reports. A has a small update and a major it saw today; B and C one each. One row was left out as unsafe (dropped 1).
    const read: Record<string, ReturnType<typeof inventoryResult>> = {
      [a.siteId]: inventoryResult([item("akismet", "1.0", "1.1"), item("bigplug", "1.0", "2.0", SECRETS.pluginName)]),
      [b.siteId]: inventoryResult([item("akismet", "1.0", "1.1")], 1),
      [c.siteId]: inventoryResult([item("x", "1.0", "1.1")]),
    };
    const claimedInventories = await claimAll("care.inventory");
    expect(claimedInventories).toHaveLength(3);
    expect(await claim("care.inventory")).toBeNull();
    for (const job of claimedInventories) {
      expect(job.inputs).toEqual([]);
      expect(job.outputs).toEqual([]);
      const i = claimedInventories.indexOf(job);
      if (i < 2) expect(await count("approvals", "kind = 'care.updates'")).toBe(0); // the first wave waits for the last inventory
      await complete(job, read[job.payload.siteId]);
    }
    expect(await count("care_updates")).toBe(4);
    // Wave 1 is one approval that names only A (the cheapest brochure site) and only its small update: the major seen today is in no wave.
    let approvals = await waveApprovals();
    expect(approvals).toHaveLength(1);
    expect(approvals[0]).toMatchObject({ title: "Care updates: wave 1 (1 site, 1 update)", status: "pending" });
    expect(approvals[0].payload.sites.map((s) => [s.siteId, s.updates.map((u) => u.slug)])).toEqual([[a.siteId, ["akismet"]]]);
    expect(approvals[0].preview).toContain("alpha-bakery.example.com");
    for (const word of ["bravo-plumbing", "charlie-salon", "bigplug"]) expect(approvals[0].preview).not.toContain(word);
    for (const x of [a, b, c]) expect((await ticks(x)).slice(0, 3)).toEqual([true, true, false]);
    expect(await count("helper_jobs", "kind = 'care.update'")).toBe(0); // nothing touches a site before a yes

    // --- Logan approves wave 1. One care.update job is queued for A. Its payload carries the alias and the folder and nothing else secret.
    expect(await approve(E, approvals[0].id)).toEqual({ ok: true });
    const canary = (await claim("care.update"))!;
    expect(canary).toBeTruthy();
    expect(await claim("care.update")).toBeNull();
    expect(Object.keys(canary.payload).sort()).toEqual(["alias", "path", "paths", "runId", "siteId", "siteUrl", "updates"]);
    expect(canary.payload).toMatchObject({ siteId: a.siteId, alias: `${ALIAS_WORD}-alpha-bakery`, path: `${PATH_WORD}alpha-bakery`, siteUrl: "https://alpha-bakery.example.com", paths: ["/", "/contact"] });
    expect(canary.payload.updates.map((u: { slug: string; from: string; to: string }) => [u.slug, u.from, u.to])).toEqual([["akismet", "1.0", "1.1"]]);
    for (const [what, value] of Object.entries(SECRETS)) expect(JSON.stringify(canary), `${what} is in the job`).not.toContain(value);
    expect(canary.outputs.sort()).toEqual([0, 1].flatMap((i) => ["before", "after", "diff"].map((k) => `care/${canary.payload.runId}/${i}-${k}.jpg`)).sort());
    expect(await updatesOf(a.siteId)).toEqual([["akismet", "queued"], ["bigplug", "available"]]);
    for (const x of [a, b, c]) expect((await ticks(x))[3]).toBe(x === a); // 1.4: Logan approved A only

    // --- The canary runs: the helper keeps its claim (touch), uploads its pictures to the exact keys it was given and reports. One page is the same, one changed.
    expect((await post(`/jobs/${canary.id}/touch`)).status).toBe(204);
    const keys = (i: number) => (["before", "after", "diff"] as const).map((k) => `care/${canary.payload.runId}/${i}-${k}.jpg`);
    for (const k of [...keys(0).slice(0, 2), ...keys(1)]) await upload(canary, k);
    expect((await helperCall(`/jobs/${canary.id}/output?key=${encodeURIComponent("care/not-this-run/0-before.jpg")}`, { method: "PUT", body: JPEG })).status).toBe(403);
    const runId = canary.payload.runId as string;
    await complete(canary, {
      backupFile: `siteline-backups/alpha-bakery.example.com-${runId}.sql.gz`,
      steps: canary.payload.updates.map((u: { id: string }) => ({ id: u.id, outcome: "applied", note: "" })),
      pages: [page("/", { up: { before: true, after: true } }), page("/contact", { verdict: "changed", ssim: 0.9, up: { before: true, after: true, diff: true } })],
      rolledBack: false, retry: false,
    });
    expect(await updatesOf(a.siteId)).toEqual([["akismet", "applied"], ["bigplug", "available"]]);
    const run = (await api<{ run: { id: string; status: string; backupFile: string; pages: { id: string; path: string; verdict: string; review: string; pictures: Record<string, string | null> }[] } }>("GET", `/care/runs/${runId}`)).run;
    expect(run).toMatchObject({ id: runId, status: "changed", backupFile: `siteline-backups/alpha-bakery.example.com-${runId}.sql.gz` });
    expect(run.pages.map((p) => [p.path, p.verdict, p.review])).toEqual([["/", "ok", "none"], ["/contact", "changed", "pending"]]);
    const picture = await owner("GET", `/care/pictures/${run.pages[1].id}/diff`);
    expect(picture.status).toBe(200);
    expect(picture.headers.get("content-type")).toBe("image/jpeg");
    expect(new Uint8Array(await picture.arrayBuffer())).toEqual(JPEG);
    // Claude has a page to look at, and wave 2 is not drafted: the canary has not passed yet.
    const reviews = (await env.DB.prepare(`SELECT id, status, target_id FROM claude_tasks WHERE kind = 'care.review'`).all<{ id: string; status: string; target_id: string }>()).results;
    expect(reviews).toEqual([{ id: expect.any(String), status: "pending", target_id: run.pages[1].id }]);
    expect(await waveApprovals()).toHaveLength(1);
    expect((await api<{ batch: { status: string } }>("GET", "/care/updates")).batch.status).toBe("wave1");
    expect((await ticks(a))[2]).toBe(true); // 1.3: the canary ran

    // --- Claude looks at the three pictures and answers fine, through the queue's real completion. That drafts wave 2 for the other two sites (not A again, not the major).
    const task = await claimById(reviews[0].id);
    expect(await completeTask(E, task.id, { verdict: "fine", note: "A slider moved, nothing else." })).toEqual({ ok: true });
    approvals = await waveApprovals();
    expect(approvals).toHaveLength(2);
    expect(approvals[1]).toMatchObject({ title: "Care updates: wave 2 (2 sites, 2 updates)", status: "pending" });
    expect(approvals[1].payload.sites.map((s) => s.siteId).sort()).toEqual([b.siteId, c.siteId].sort());
    expect((await api<{ batch: { status: string } }>("GET", "/care/updates")).batch.status).toBe("wave2");
    expect((await api<{ run: { pages: { review: string }[] } }>("GET", `/care/runs/${runId}`)).run.pages.map((p) => p.review)).toEqual(["none", "fine"]);

    // --- Logan approves wave 2. B's run is clean; C's page breaks, so the helper puts the plugin back and says so.
    expect(await approve(E, approvals[1].id)).toEqual({ ok: true });
    const wave2Jobs = await claimAll("care.update");
    expect(wave2Jobs.map((j) => j.payload.siteId).sort()).toEqual([b.siteId, c.siteId].sort());
    for (const j of wave2Jobs) for (const [what, value] of Object.entries(SECRETS)) expect(JSON.stringify(j), `${what} is in a job`).not.toContain(value);
    const jobB = wave2Jobs.find((j) => j.payload.siteId === b.siteId)!;
    const jobC = wave2Jobs.find((j) => j.payload.siteId === c.siteId)!;
    expect(await ticks(b)).toEqual([true, true, true, true, false, false]); // 1.3 once the canary ran, 1.4 Logan's yes; nothing after it until the helper has run
    expect(await ticks(c)).toEqual([true, true, true, true, false, false]);

    await complete(jobB, {
      backupFile: `siteline-backups/bravo-plumbing.example.com-${jobB.payload.runId}.sql.gz`,
      steps: jobB.payload.updates.map((u: { id: string }) => ({ id: u.id, outcome: "applied", note: "" })),
      pages: [page("/")], rolledBack: false, retry: false,
    });
    expect((await api<{ batch: { status: string } }>("GET", "/care/updates")).batch.status).toBe("wave2"); // C is still running: the week is not settled
    expect((await care1(b)).status).not.toBe("done");

    await upload(jobC, `care/${jobC.payload.runId}/1-after.jpg`);
    await complete(jobC, {
      backupFile: `siteline-backups/charlie-salon.example.com-${jobC.payload.runId}.sql.gz`,
      steps: jobC.payload.updates.map((u: { id: string }) => ({ id: u.id, outcome: "rolled_back", note: "put back after a page broke" })),
      // The after-shot read 500 (verdict broken); `after` is the read made once the plugin was back, and the page came back (a page still down would say "still broken: restore from").
      pages: [page("/"), page("/contact", { afterStatus: 200, verdict: "broken", ssim: 0.4, up: { after: true } })],
      rolledBack: true, retry: false,
    });
    expect(await updatesOf(c.siteId)).toEqual([["x", "rolled_back"]]);
    expect(await updatesOf(b.siteId)).toEqual([["akismet", "applied"]]);
    expect((await api<{ batch: { status: string } }>("GET", "/care/updates")).batch.status).toBe("done");

    // The rolled-back site: one update_failed incident, one CARE-5 fix task, a Today row at 85, health down 15 and a timeline line. Nobody else is hurt.
    const failed = (await env.DB.prepare(`SELECT site_id, detail, closed_at FROM site_incidents WHERE kind = 'update_failed'`).all<{ site_id: string; detail: string; closed_at: string | null }>()).results;
    expect(failed).toEqual([{ site_id: c.siteId, detail: "updates rolled back: x broke /contact", closed_at: null }]);
    const fixTasks = (await listTasks(env.DB, c.careProject!.id)).filter((t) => t.cadenceKey === "CARE-5");
    expect(fixTasks.map((t) => [t.title, t.owner, t.status])).toEqual([["Fix: charlie-salon.example.com after updates", "logan", "todo"]]);
    expect(await count("tasks", "cadence_key = 'CARE-5'")).toBe(1);
    const today = (await api<{ items: { kind: string; businessId: string; reason: string; priority: number }[] }>("GET", "/today")).items.filter((i) => i.kind === "site_incident");
    expect(today).toEqual([expect.objectContaining({ businessId: c.businessId, reason: "updates broke charlie-salon.example.com: rolled back", priority: 85 })]);
    const board = (await api<{ clients: { businessId: string; health: { score: number; reasons: string[] } }[] }>("GET", "/care")).clients;
    expect(board.find((r) => r.businessId === c.businessId)!.health).toMatchObject({ score: 85, reasons: ["Updates need a look"] });
    for (const x of [a, b]) expect(board.find((r) => r.businessId === x.businessId)!.health.score).toBe(100);
    expect(board.map((r) => r.businessId)).not.toContain(test.businessId);
    expect(await activityOf(c.businessId, "care_rolled_back")).toEqual([expect.objectContaining({ detail: expect.stringContaining("charlie-salon.example.com: updates rolled back") })]);
    expect(await activityOf(a.businessId, "care_updated")).toHaveLength(1);
    expect(await activityOf(b.businessId, "care_updated")).toHaveLength(1);
    expect(await activityOf(c.businessId, "care_updated")).toEqual([]);
    // The weekly checklists: the clean clients are done once the batch settled; the rolled-back one keeps 1.6 open for Logan.
    expect(await ticks(c)).toEqual([true, true, true, true, true, false]);
    expect((await care1(c)).status).not.toBe("done");
    expect(await ticks(a)).toEqual([true, true, true, true, true, true]);
    expect((await care1(a)).status).toBe("done");
    expect(await ticks(b)).toEqual([true, true, true, true, true, true]);
    expect((await care1(b)).status).toBe("done");

    // --- A single-site run on the test client's site, any day: read, one approval, one update, no CARE-1 item ticked.
    const single = await api<{ batch: { id: string; kind: string; status: string } }>("POST", `/sites/${test.siteId}/care-run`, {}, 201);
    expect(single.batch).toMatchObject({ kind: "single", status: "inventory" });
    const [readJob] = await claimAll("care.inventory");
    expect(readJob.payload).toMatchObject({ siteId: test.siteId, batchId: single.batch.id, alias: `${ALIAS_WORD}-test-client`, path: `${PATH_WORD}test-client` });
    await complete(readJob, inventoryResult([item("akismet", "1.0", "1.1")]));
    approvals = await waveApprovals();
    expect(approvals).toHaveLength(3);
    expect(approvals[2]).toMatchObject({ title: "Care updates: test-client.example.com", status: "pending" });
    expect(approvals[2].payload).toMatchObject({ wave: 0 });
    expect(await approve(E, approvals[2].id)).toEqual({ ok: true });
    const rehearsal = (await claim("care.update"))!;
    expect(rehearsal.payload).toMatchObject({ siteId: test.siteId, alias: `${ALIAS_WORD}-test-client` });
    await complete(rehearsal, {
      backupFile: `siteline-backups/test-client.example.com-${rehearsal.payload.runId}.sql.gz`,
      steps: rehearsal.payload.updates.map((u: { id: string }) => ({ id: u.id, outcome: "applied", note: "" })),
      pages: [page("/")], rolledBack: false, retry: false,
    });
    expect((await api<{ run: { status: string } }>("GET", `/care/runs/${rehearsal.payload.runId}`)).run.status).toBe("ok");
    expect((await env.DB.prepare(`SELECT status FROM care_batches WHERE id = ?`).bind(single.batch.id).first<{ status: string }>())!.status).toBe("done");
    expect(await updatesOf(test.siteId)).toEqual([["akismet", "applied"]]);
    // The weekly clients were not touched by the rehearsal.
    expect(await ticks(a)).toEqual([true, true, true, true, true, true]);
    expect(await ticks(c)).toEqual([true, true, true, true, true, false]);

    // --- The certificate read. A's expires in 9 days: one cert_expiring incident, a Today row at 66 and 15 off the score. The test client's entry in the result is not asked about and is ignored.
    const certJob = (await claim("care.certs"))!;
    expect(certJob.payload.hosts.map((h: { siteId: string }) => h.siteId)).toContain(a.siteId);
    await complete(certJob, {
      certs: [
        ...certJob.payload.hosts.map((h: { siteId: string }) => ({ siteId: h.siteId, validTo: h.siteId === a.siteId ? "2026-12-11" : "2027-03-01" })),
        { siteId: test.siteId, validTo: "2026-12-03" },
      ],
    });
    const certIncidents = (await env.DB.prepare(`SELECT site_id, detail, closed_at FROM site_incidents WHERE kind = 'cert_expiring'`).all<{ site_id: string; detail: string; closed_at: string | null }>()).results;
    expect(certIncidents).toEqual([{ site_id: a.siteId, detail: "certificate expires in 9 days", closed_at: null }]);
    const today2 = (await api<{ items: { kind: string; businessId: string; reason: string; priority: number }[] }>("GET", "/today")).items.filter((i) => i.kind === "site_incident");
    expect(today2.map((i) => [i.businessId, i.priority, i.reason]).sort()).toEqual([
      [a.businessId, 66, "alpha-bakery.example.com's certificate expires in 9 days"],
      [c.businessId, 85, "updates broke charlie-salon.example.com: rolled back"],
    ].sort());
    const board2 = (await api<{ clients: { businessId: string; health: { score: number } }[] }>("GET", "/care")).clients;
    expect(board2.find((r) => r.businessId === a.businessId)!.health.score).toBe(85);
    expect(board2.find((r) => r.businessId === c.businessId)!.health.score).toBe(85);
    expect(board2.find((r) => r.businessId === b.businessId)!.health.score).toBe(100);

    // --- The approvals are exactly the three wave approvals and the single-site one, all decided by Logan; no mail went out; nothing else was made. (The daily run's ladder sweep drafts pending `ladder.mail` approvals
    // for the builds this test seeds as done; they are left out here and nothing of them is sent.)
    const all = (await env.DB.prepare(`SELECT kind, status FROM approvals WHERE kind <> 'ladder.mail' ORDER BY created_at, rowid`).all<{ kind: string; status: string }>()).results;
    expect(all).toEqual([1, 2, 3].map(() => ({ kind: "care.updates", status: "approved" })));
    expect(approvals.map((x) => x.payload.wave)).toEqual([1, 2, 0]);
    expect(mail.sent).toEqual([]);
    expect(mail.sent.length).toBe(before.mail);
    expect(await count("tasks", "cadence_key = 'CARE-5'")).toBe(1);
    expect(rdap.every((u) => u.startsWith("https://rdap.org/domain/"))).toBe(true); // the only outside question the app asked: the registry, by the daily cron

    // --- Nothing an agent or the page can read has an alias, a folder, an address, a picture key or a secret in it, and every number is finite.
    const board3 = await api("GET", "/care/updates");
    const mcp = [await tool("get_care_updates", {}), await tool("get_care_overview", {}), await tool("list_incidents", {}), await tool("list_incidents", { open: true })];
    for (const r of mcp) {
      expect(r.isError, r.text).toBe(false);
      expect(r.text).not.toMatch(/https?:\/\//);
      expect(r.text).not.toContain(ALIAS_WORD);
      expect(r.text).not.toContain(PATH_WORD);
      expect(r.text).not.toContain("care/" + runId);
      expect(r.text).not.toContain(test.businessId);
      expect(r.text).not.toContain(test.siteId);
      for (const [what, value] of Object.entries(SECRETS)) expect(r.text, `${what} is in an MCP answer`).not.toContain(value);
    }
    const updatesJson = JSON.parse(mcp[0].text) as { batch: { status: string }; sites: { siteId: string; domain: string; canUpdate: boolean; why: string | null; updates: { slug: string; due: boolean }[]; lastRun: { status: string } | null; updateFailed: { detail: string } | null }[] };
    expect(updatesJson.batch).toMatchObject({ status: "done" });
    const siteOf = (id: string) => updatesJson.sites.find((s) => s.siteId === id)!;
    expect(siteOf(a.siteId)).toMatchObject({ canUpdate: true, updates: [{ type: "plugin", slug: "bigplug", from: "1.0", to: "2.0", risk: "major", held: false, due: false }], lastRun: { status: "changed" }, updateFailed: null });
    expect(siteOf(c.siteId)).toMatchObject({ lastRun: { status: "rolled_back" }, updateFailed: { detail: "updates rolled back: x broke /contact" } });
    expect(siteOf(mainwp.siteId)).toMatchObject({ canUpdate: false });
    expect(siteOf(mainwp.siteId).why).toMatch(/SSH/i);
    expect(updatesJson.sites.map((s) => s.siteId)).not.toContain(test.siteId);
    const apis = [JSON.stringify(board3), ...apiBodies, JSON.stringify(await api("GET", "/approvals"))];
    for (const body of apis) {
      expect(body).not.toContain(ALIAS_WORD);
      expect(body).not.toContain(PATH_WORD);
      expect(body).not.toContain(`care/${runId}/`);
      expect(body).not.toContain(SECRETS.vaultName);
      expect(body).not.toContain(SECRETS.accessNote);
      expect(body).not.toContain(SECRETS.subscriptionToken);
    }
    expectFiniteNumbers(updatesJson);
    expectFiniteNumbers(board2);
    // Nothing was logged as an error.
    expect(errors).toEqual([]);
    void before.tasks;
  });
});
