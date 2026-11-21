import { env } from "cloudflare:test";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { buildFacts, monthRange, plainSummary, ReportFacts } from "../src/worker/care/reportFacts";
import { openIncident, closeIncident, setCertExpiry, setDomainExpiry } from "../src/worker/db/monitoring";
import { upsertUptimeDay } from "../src/worker/db/careReports";
import { upsertSeen } from "../src/worker/db/careUpdates";
import { createSite, updateSite } from "../src/worker/db/sites";
import { insertTasks } from "../src/worker/db/tasks";
import psi from "./fixtures/psi.json";
import { seedClient, type SubSpec } from "./fixtures/clients";
import { newTask, resetProjectWork } from "./fixtures/projects";

const LA = "America/Los_Angeles";
/** Tuesday 1 December 2026, 09:00 in Los Angeles: the day the report of November is made. */
const NOW = new Date("2026-12-01T17:00:00.000Z");
const TODAY = "2026-12-01";
const CARE: SubSpec[] = [{ key: "care", monthlyCents: 12_900 }];

let fetchSpy: ReturnType<typeof vi.spyOn>;
beforeEach(async () => {
  for (const t of ["site_incidents", "site_checks", "site_uptime_days", "care_page_checks", "care_runs", "care_batches", "care_updates", "helper_jobs"]) await env.DB.prepare(`DELETE FROM ${t}`).run();
  await resetProjectWork();
  for (const t of ["billing_holds", "invoice_nudges", "invoices", "subscriptions", "document_views", "document_signatures", "documents", "deals", "activity", "drafts", "audits", "search_results", "businesses", "suppressions"])
    await env.DB.prepare(`DELETE FROM ${t}`).run();
  fetchSpy = vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("no network in tests"));
});
afterEach(() => { vi.restoreAllMocks(); });

type Client = Awaited<ReturnType<typeof seedClient>>;
const careClient = (subs: SubSpec[] = CARE) => seedClient({ subs });

/** The calendar date `n` days after the `YYYY-MM-DD` date `day`. */
const plus = (day: string, n: number) => { const [y, m, d] = day.split("-").map(Number); return new Date(Date.UTC(y, m - 1, d + n)).toISOString().slice(0, 10); };

/** A second live site on the client. */
async function addSite(s: Client, url: string) {
  return (await createSite(env.DB, { businessId: s.businessId, url })).site;
}
/** Full days (288 checks) from `first` to `last`, with `failed` failed checks on each. */
async function days(siteId: string, first: string, last: string, failed = 0) {
  for (let d = first; d <= last; d = plus(d, 1)) await upsertUptimeDay(env.DB, siteId, d, 288, 288 - failed);
}
/** What the run recorded for an update, as the helper's result names it. */
type Outcome = "applied" | "skipped" | "failed" | "rolled_back" | "rollback_failed";
const NOW_STATUS: Record<Outcome, string> = { applied: "applied", skipped: "available", failed: "failed", rolled_back: "rolled_back", rollback_failed: "failed" };
/**
 * One care run of a site that finished at `finishedAt`, with what the helper's result recorded for each update (`outcome`). A new update row gets the status the run left it in;
 * an `id` reuses an update that an earlier run handled. The job's result is stored as `completeHelperJob` stores it.
 */
async function run(siteId: string, finishedAt: string, o: { status?: string; backup?: string | null; updates?: { slug: string; outcome: Outcome; id?: string; note?: string }[] } = {}) {
  const runId = crypto.randomUUID(), jobId = crypto.randomUUID(), batchId = crypto.randomUUID();
  const ids: { id: string }[] = [];
  for (const u of o.updates ?? []) {
    const id = u.id ?? crypto.randomUUID();
    ids.push({ id });
    if (!u.id) {
      await env.DB.prepare(
        `INSERT INTO care_updates (id, site_id, type, slug, name, from_version, to_version, risk, first_seen_at, last_seen_at, status) VALUES (?, ?, 'plugin', ?, ?, '1.0', '2.0', 'minor', ?, ?, ?)`,
      ).bind(id, siteId, u.slug, `Name of ${u.slug}`, finishedAt, finishedAt, NOW_STATUS[u.outcome]).run();
    }
  }
  const result = { backupFile: null, steps: (o.updates ?? []).map((u, i) => ({ id: ids[i].id, outcome: u.outcome, note: u.note ?? "" })), pages: [], rolledBack: false, retry: false };
  await env.DB.batch([
    env.DB.prepare(`INSERT INTO care_batches (id, period, kind, site_id, status, created_at, updated_at) VALUES (?, '2026-11', 'single', ?, 'done', ?, ?)`).bind(batchId, siteId, finishedAt, finishedAt),
    env.DB.prepare(`INSERT INTO helper_jobs (id, kind, payload, status, result, created_at, done_at) VALUES (?, 'care.update', ?, 'done', ?, ?, ?)`)
      .bind(jobId, JSON.stringify({ runId, siteId, updates: ids }), JSON.stringify(result), finishedAt, finishedAt),
    env.DB.prepare(
      `INSERT INTO care_runs (id, batch_id, site_id, wave, helper_job_id, status, backup_file, summary, created_at, finished_at) VALUES (?, ?, ?, 0, ?, ?, ?, 'x', ?, ?)`,
    ).bind(runId, batchId, siteId, jobId, o.status ?? "ok", o.backup === undefined ? null : o.backup, finishedAt, finishedAt),
  ]);
  return { runId, ids: ids.map((x) => x.id) };
}
/** An edit-request task of the client, done at `doneAt` (or still open). */
async function editTask(s: Client, doneAt: string | null) {
  const [t] = await insertTasks(env.DB, [newTask(s.project!.id, s.businessId, { editRequest: true, isStep: false, title: "Edit request" })]);
  if (doneAt) await env.DB.prepare(`UPDATE tasks SET status = 'done', done_at = ? WHERE id = ?`).bind(doneAt, t.id).run();
  return t;
}
const facts = (s: Client, o: { speed?: boolean; period?: string; now?: Date } = {}) => buildFacts(env, s.businessId, o.period ?? "2026-11", o.now ?? NOW, { speed: o.speed ?? false });

describe("monthRange", () => {
  it("is the local month: November in Los Angeles starts at 07:00Z (PDT ended on the 1st) and ends at 08:00Z on 1 December", () => {
    expect(monthRange("2026-11", LA)).toEqual({ from: "2026-11-01T07:00:00.000Z", to: "2026-12-01T08:00:00.000Z", fromDay: "2026-11-01", toDay: "2026-11-30" });
  });
  it("follows the zone's DST: March has 31 days and starts at 08:00Z, April starts at 07:00Z", () => {
    expect(monthRange("2026-03", LA)).toEqual({ from: "2026-03-01T08:00:00.000Z", to: "2026-04-01T07:00:00.000Z", fromDay: "2026-03-01", toDay: "2026-03-31" });
  });
  it("is a different instant in another zone, and knows leap years and December", () => {
    expect(monthRange("2028-02", "Pacific/Auckland")).toEqual({ from: "2028-01-31T11:00:00.000Z", to: "2028-02-29T11:00:00.000Z", fromDay: "2028-02-01", toDay: "2028-02-29" });
    expect(monthRange("2026-12", LA).to).toBe("2027-01-01T08:00:00.000Z");
  });
  it("refuses a period that is not a month", () => {
    for (const bad of ["2026-13", "2026-00", "2026-1", "26-11", "2026-11-01", ""]) expect(() => monthRange(bad, LA)).toThrow(RangeError);
  });
});

describe("buildFacts: shape and sites", () => {
  it("gives one ReportFacts with one SiteFacts per live monitored site, and it parses back", async () => {
    const s = await careClient();
    const second = await addSite(s, "https://ace-shop.com");
    const f = await facts(s);
    expect(f).toMatchObject({ version: 1, period: "2026-11", label: "November 2026", from: "2026-11-01T07:00:00.000Z", to: "2026-12-01T08:00:00.000Z", clientName: "Ace Plumbing", generatedAt: NOW.toISOString() });
    expect(f.sites.map((x) => x.domain)).toEqual(["ace.com", "ace-shop.com"]);
    expect(second.domain).toBe("ace-shop.com");
    expect(ReportFacts.parse(JSON.parse(JSON.stringify(f)))).toEqual(f);
    expect(ReportFacts.parse(f)).toEqual(f);
  });

  it("leaves out an archived site and, for a client without Care, a site nobody switched monitoring on for", async () => {
    const s = await careClient();
    const archived = await addSite(s, "https://old-ace.com");
    await env.DB.prepare(`UPDATE sites SET archived_at = ? WHERE id = ?`).bind(NOW.toISOString(), archived.id).run();
    expect((await facts(s)).sites.map((x) => x.domain)).toEqual(["ace.com"]);
    const plain = await seedClient({ subs: [] });
    expect((await facts(plain)).sites).toEqual([]);
    await env.DB.prepare(`UPDATE sites SET monitoring = 1 WHERE id = ?`).bind(plain.site!.id).run();
    expect((await facts(plain)).sites.map((x) => x.domain)).toEqual(["ace.com"]);
  });

  it("has no sites at all for a client that has nothing monitored, and no edits section without a Care plan", async () => {
    const s = await seedClient({ subs: [], site: false });
    const f = await facts(s);
    expect(f.sites).toEqual([]);
    expect(f.edits).toBeNull();
    expect(f.renewals).toEqual([]);
  });
});

describe("buildFacts: uptime", () => {
  it("is null, with no coverage and no start date, for a site with no uptime days, and the plain summary says nothing about uptime for it", async () => {
    const s = await careClient();
    const f = await facts(s);
    expect(f.sites[0]).toMatchObject({ uptimePercent: null, coveredDays: 0, monitoredSince: null, incidents: 0, longestOutageMinutes: null, speedScore: null });
    expect(plainSummary(f)).not.toMatch(/uptime|was up|%/i);
  });

  it("a client that began on the 20th is monitored since that day, covers 11 days and shows the partial month in the summary", async () => {
    const s = await careClient();
    await days(s.site!.id, "2026-11-20", "2026-11-30");
    await days(s.site!.id, "2026-12-01", "2026-12-05"); // outside the month
    const f = await facts(s);
    expect(f.sites[0]).toMatchObject({ monitoredSince: "2026-11-20", coveredDays: 11, uptimePercent: 100 });
    expect(plainSummary(f)).toMatch(/up 100% of the time/);
    expect(plainSummary(f)).toMatch(/November 20/);
  });

  it("never shows 100 for a month with a failed check", async () => {
    const s = await careClient();
    await days(s.site!.id, "2026-11-01", "2026-11-29");
    await upsertUptimeDay(env.DB, s.site!.id, "2026-11-30", 288, 287);
    expect((await facts(s)).sites[0].uptimePercent).toBe(99.9);
  });

  it("keeps the start date when monitoring began before the month, and ignores days with too few checks", async () => {
    const s = await careClient();
    await days(s.site!.id, "2026-10-15", "2026-10-31");
    await upsertUptimeDay(env.DB, s.site!.id, "2026-11-01", 100, 100); // under 144: not covered
    await days(s.site!.id, "2026-11-02", "2026-11-03", 12);
    const f = await facts(s);
    expect(f.sites[0]).toMatchObject({ monitoredSince: "2026-10-15", coveredDays: 2, uptimePercent: 95.8 });
    expect(plainSummary(f)).not.toMatch(/began/);
  });
});

describe("buildFacts: incidents", () => {
  it("counts the down incidents opened in the month and the longest outage; an open one runs to the month end; other kinds and other months do not count", async () => {
    const s = await careClient();
    const id = s.site!.id;
    const down = async (at: string, closeAt: string | null) => {
      await openIncident(env.DB, { siteId: id, businessId: s.businessId, kind: "down", detail: "The shop returned HTTP 500 on /checkout", now: at });
      if (closeAt) await closeIncident(env.DB, id, "down", closeAt);
    };
    await down("2026-10-31T23:00:00.000Z", "2026-10-31T23:30:00.000Z"); // October
    await down("2026-11-05T10:00:00.000Z", "2026-11-05T10:12:00.000Z"); // 12 minutes
    await down("2026-11-09T10:00:00.000Z", "2026-11-09T11:30:00.000Z"); // 90 minutes
    await down("2026-11-30T20:00:00.000Z", null); // still open: to 2026-12-01T08:00Z is 720 minutes
    await openIncident(env.DB, { siteId: id, businessId: s.businessId, kind: "domain_expiring", detail: "soon", now: "2026-11-02T10:00:00.000Z" });
    expect((await facts(s)).sites[0]).toMatchObject({ incidents: 3, longestOutageMinutes: 720 });
  });

  it("stops an outage at the month end and at now: one that closed in December, or is still open when the report is made, counts no later time", async () => {
    const s = await careClient();
    const id = s.site!.id;
    await openIncident(env.DB, { siteId: id, businessId: s.businessId, kind: "down", detail: "d", now: "2026-11-30T20:00:00.000Z" });
    await closeIncident(env.DB, id, "down", "2026-12-02T10:00:00.000Z"); // 12 hours of November, then December
    expect((await facts(s)).sites[0]).toMatchObject({ incidents: 1, longestOutageMinutes: 720 });
    await env.DB.prepare(`DELETE FROM site_incidents`).run();
    // Made on the 10th at 22:00Z for the month in progress: an outage still open has run two hours, not to the month end.
    await openIncident(env.DB, { siteId: id, businessId: s.businessId, kind: "down", detail: "d", now: "2026-11-10T20:00:00.000Z" });
    expect((await facts(s, { now: new Date("2026-11-10T22:00:00.000Z") })).sites[0]).toMatchObject({ incidents: 1, longestOutageMinutes: 120 });
  });

  it("an outage that began before the month and ended inside it counts, from the month's first instant; one that ended before it does not; one that spans the whole month runs the whole month", async () => {
    const s = await careClient();
    const id = s.site!.id;
    // November in Los Angeles starts at 07:00Z on the 1st.
    await openIncident(env.DB, { siteId: id, businessId: s.businessId, kind: "down", detail: "d", now: "2026-10-31T23:00:00.000Z" });
    await closeIncident(env.DB, id, "down", "2026-10-31T23:30:00.000Z"); // over before the month
    await openIncident(env.DB, { siteId: id, businessId: s.businessId, kind: "down", detail: "d", now: "2026-11-01T05:00:00.000Z" });
    await closeIncident(env.DB, id, "down", "2026-11-01T09:00:00.000Z"); // two hours of November (07:00Z to 09:00Z), the first two of the outage's four
    expect((await facts(s)).sites[0]).toMatchObject({ incidents: 1, longestOutageMinutes: 120 });
    // The same outage is also October's: its hours before the month end count there.
    expect((await facts(s, { period: "2026-10", now: new Date("2026-11-01T17:00:00.000Z") })).sites[0]).toMatchObject({ incidents: 2, longestOutageMinutes: 120 });
    await env.DB.prepare(`DELETE FROM site_incidents`).run();
    await openIncident(env.DB, { siteId: id, businessId: s.businessId, kind: "down", detail: "d", now: "2026-10-30T00:00:00.000Z" });
    await closeIncident(env.DB, id, "down", "2026-12-05T00:00:00.000Z");
    expect((await facts(s)).sites[0]).toMatchObject({ incidents: 1, longestOutageMinutes: 43_260 }); // 30 days and the hour the month is long in the fall-back zone
    await env.DB.prepare(`DELETE FROM site_incidents`).run();
    // Still open from October when the report is made inside November: it has run from the month's start to now, and one that closed exactly at the start is not in it.
    await openIncident(env.DB, { siteId: id, businessId: s.businessId, kind: "down", detail: "d", now: "2026-10-31T10:00:00.000Z" });
    expect((await facts(s, { now: new Date("2026-11-01T10:00:00.000Z") })).sites[0]).toMatchObject({ incidents: 1, longestOutageMinutes: 180 });
    await closeIncident(env.DB, id, "down", "2026-11-01T07:00:00.000Z");
    expect((await facts(s)).sites[0]).toMatchObject({ incidents: 0, longestOutageMinutes: null });
  });

  it("an incident opened at 23:30 local on the 30th is November's, one at 00:10 local on 1 December is December's", async () => {
    const s = await careClient();
    const id = s.site!.id;
    await openIncident(env.DB, { siteId: id, businessId: s.businessId, kind: "down", detail: "d", now: "2026-12-01T07:30:00.000Z" });
    await closeIncident(env.DB, id, "down", "2026-12-01T07:40:00.000Z");
    await openIncident(env.DB, { siteId: id, businessId: s.businessId, kind: "down", detail: "d", now: "2026-12-01T08:10:00.000Z" });
    await closeIncident(env.DB, id, "down", "2026-12-01T08:30:00.000Z");
    expect((await facts(s)).sites[0]).toMatchObject({ incidents: 1, longestOutageMinutes: 10 });
    expect((await facts(s, { period: "2026-12", now: new Date("2027-01-01T17:00:00.000Z") })).sites[0]).toMatchObject({ incidents: 1, longestOutageMinutes: 20 });
  });
});

describe("buildFacts: updates and backups", () => {
  it("counts a run in the month it finished, by the local clock: 23:40 on 30 November is November, 00:10 on 1 December is December", async () => {
    const s = await careClient();
    const id = s.site!.id;
    await run(id, "2026-12-01T07:40:00.000Z", { backup: "b1", updates: [{ slug: "a", outcome: "applied" }, { slug: "b", outcome: "applied" }] }); // 23:40 on the 30th
    await run(id, "2026-12-01T08:10:00.000Z", { backup: "b2", updates: [{ slug: "c", outcome: "applied" }] }); // 00:10 on the 1st
    expect((await facts(s)).sites[0]).toMatchObject({ updatesApplied: 2, updatesRolledBack: 0, updatesFailed: 0, backups: 1 });
    expect((await facts(s, { period: "2026-12", now: new Date("2027-01-01T17:00:00.000Z") })).sites[0]).toMatchObject({ updatesApplied: 1, backups: 1 });
  });

  it("counts a rolled-back run's updates under rolled back, failed and rollback-failed ones under failed, and counts nothing for a skipped one", async () => {
    const s = await careClient();
    await run(s.site!.id, "2026-11-12T18:00:00.000Z", {
      status: "rolled_back", backup: "b",
      updates: [{ slug: "a", outcome: "rolled_back" }, { slug: "b", outcome: "rolled_back" }, { slug: "c", outcome: "failed" }, { slug: "f", outcome: "rollback_failed" }, { slug: "d", outcome: "applied" }, { slug: "e", outcome: "skipped" }],
    });
    expect((await facts(s)).sites[0]).toMatchObject({ updatesApplied: 1, updatesRolledBack: 2, updatesFailed: 2, backups: 1 });
  });

  it("counts what the run recorded, not the update's status now: an inventory read after a rolled-back run puts the update back to available and the count stays", async () => {
    const s = await careClient();
    const id = s.site!.id;
    const r = await run(id, "2026-11-12T18:00:00.000Z", { status: "rolled_back", updates: [{ slug: "a", outcome: "rolled_back" }, { slug: "b", outcome: "failed" }] });
    expect(r.ids).toHaveLength(2);
    await upsertSeen(env.DB, id, [
      { type: "plugin", slug: "a", name: "Name of a", fromVersion: "1.0", toVersion: "2.0", risk: "minor", rollbackable: true },
      { type: "plugin", slug: "b", name: "Name of b", fromVersion: "1.0", toVersion: "2.0", risk: "minor", rollbackable: true },
    ], "2026-11-20T18:00:00.000Z");
    const now = await env.DB.prepare(`SELECT status FROM care_updates WHERE site_id = ? ORDER BY slug`).bind(id).all<{ status: string }>();
    expect(now.results.map((x) => x.status)).toEqual(["available", "available"]); // the reset really happened
    expect((await facts(s)).sites[0]).toMatchObject({ updatesApplied: 0, updatesRolledBack: 1, updatesFailed: 1 });
    expect(plainSummary(await facts(s))).toMatch(/1 was rolled back/);
  });

  it("counts a retried update in each run's own month: failed in October, applied in November", async () => {
    const s = await careClient();
    const id = s.site!.id;
    const first = await run(id, "2026-10-10T18:00:00.000Z", { status: "failed", updates: [{ slug: "a", outcome: "failed" }] });
    await run(id, "2026-11-12T18:00:00.000Z", { updates: [{ slug: "a", outcome: "applied", id: first.ids[0] }] });
    await env.DB.prepare(`UPDATE care_updates SET status = 'applied' WHERE id = ?`).bind(first.ids[0]).run();
    expect((await facts(s)).sites[0]).toMatchObject({ updatesApplied: 1, updatesFailed: 0, updatesRolledBack: 0 });
    expect((await facts(s, { period: "2026-10", now: new Date("2026-11-01T17:00:00.000Z") })).sites[0]).toMatchObject({ updatesApplied: 0, updatesFailed: 1, updatesRolledBack: 0 });
  });

  it("an update put back only because another one failed is neither rolled back nor failed: one failed with four collaterals is 1 failed, 0 rolled back", async () => {
    const s = await careClient();
    const COLLATERAL = "put back because another update failed";
    await run(s.site!.id, "2026-11-12T18:00:00.000Z", {
      status: "rolled_back", backup: "b",
      updates: [{ slug: "bad", outcome: "failed", note: "wp-cli refused the update" }, ...["a", "b", "c", "d"].map((slug) => ({ slug, outcome: "rolled_back" as const, note: COLLATERAL }))],
    });
    expect((await facts(s)).sites[0]).toMatchObject({ updatesApplied: 0, updatesRolledBack: 0, updatesFailed: 1 });
    // The update that failed and was itself put back, and a rollback with no note, still count.
    await run(s.site!.id, "2026-11-19T18:00:00.000Z", { status: "rolled_back", updates: [{ slug: "x", outcome: "rolled_back", note: "put back after this update failed" }, { slug: "y", outcome: "rolled_back" }] });
    expect((await facts(s)).sites[0]).toMatchObject({ updatesRolledBack: 2, updatesFailed: 1 });
  });

  it("says updates were tracked only for a site with a run that finished in the month, even a run with nothing to update", async () => {
    const s = await careClient();
    const other = await addSite(s, "https://ace-shop.com");
    const third = await addSite(s, "https://ace-blog.com");
    await run(s.site!.id, "2026-11-12T18:00:00.000Z", { updates: [] }); // a run with nothing in it still covered the month
    await run(other.id, "2026-10-12T18:00:00.000Z", { updates: [{ slug: "a", outcome: "applied" }] }); // October's run
    await run(third.id, "2026-11-12T18:00:00.000Z", {});
    await env.DB.prepare(`UPDATE care_runs SET finished_at = NULL, status = 'running' WHERE site_id = ?`).bind(third.id).run(); // still going
    const f = await facts(s);
    expect(Object.fromEntries(f.sites.map((x) => [x.domain, x.updatesTracked]))).toEqual({ "ace.com": true, "ace-shop.com": false, "ace-blog.com": false });
    expect(ReportFacts.parse({ ...f, sites: f.sites.map(({ updatesTracked: _t, ...rest }) => rest) }).sites[0].updatesTracked).toBeUndefined(); // an older stored report still parses
  });

  it("counts a backup only for a run with a backup file, per site, and not for another site's run or a run still going", async () => {
    const s = await careClient();
    const other = await addSite(s, "https://ace-shop.com");
    await run(s.site!.id, "2026-11-03T18:00:00.000Z", { backup: "b1" });
    await run(s.site!.id, "2026-11-10T18:00:00.000Z", { backup: null });
    await run(s.site!.id, "2026-11-17T18:00:00.000Z", { backup: "" });
    await run(other.id, "2026-11-03T18:00:00.000Z", { backup: "b2" });
    await run(other.id, "2026-11-10T18:00:00.000Z", { backup: "b3" });
    await env.DB.prepare(`UPDATE care_runs SET finished_at = NULL, status = 'running' WHERE site_id = ? AND backup_file = 'b3'`).bind(other.id).run();
    const f = await facts(s);
    expect(f.sites.map((x) => [x.domain, x.backups])).toEqual([["ace.com", 1], ["ace-shop.com", 1]]);
  });
});

describe("buildFacts: edits", () => {
  it("counts an edit request done on 30 November local, with the allowance and time from the ledger", async () => {
    const s = await careClient();
    await editTask(s, "2026-12-01T07:30:00.000Z"); // 23:30 on the 30th local
    await editTask(s, "2026-12-01T08:30:00.000Z"); // 00:30 on 1 December local: December's
    await editTask(s, null); // still open
    const f = await facts(s);
    expect(f.edits).toEqual({ month: "2026-11", allowanceMinutes: 60, usedMinutes: 0, percent: 0, state: "ok", requestsDone: 1 });
  });

  it("only counts the client's own edit requests, never an ordinary task", async () => {
    const s = await careClient();
    const other = await careClient();
    await editTask(other, "2026-11-10T18:00:00.000Z");
    const [plain] = await insertTasks(env.DB, [newTask(s.project!.id, s.businessId, { editRequest: false, isStep: false, title: "Plain" })]);
    await env.DB.prepare(`UPDATE tasks SET status = 'done', done_at = '2026-11-10T18:00:00.000Z' WHERE id = ?`).bind(plain.id).run();
    expect((await facts(s)).edits).toMatchObject({ requestsDone: 0 });
  });
});

describe("buildFacts: renewals", () => {
  it("lists a certificate 59 days out and not one 61 days out, soonest first, with the window ending 60 days after today", async () => {
    const s = await careClient();
    const shop = await addSite(s, "https://ace-shop.com");
    await setCertExpiry(env.DB, s.site!.id, plus(TODAY, 59), NOW.toISOString());
    await setCertExpiry(env.DB, shop.id, plus(TODAY, 61), NOW.toISOString());
    await setDomainExpiry(env.DB, shop.id, plus(TODAY, 60), NOW.toISOString());
    await setDomainExpiry(env.DB, s.site!.id, plus(TODAY, 10), NOW.toISOString());
    const f = await facts(s);
    expect(f.renewals).toEqual([
      { what: "domain", domain: "ace.com", on: plus(TODAY, 10) },
      { what: "certificate", domain: "ace.com", on: plus(TODAY, 59) },
      { what: "domain", domain: "ace-shop.com", on: plus(TODAY, 60) },
    ]);
  });

  it("includes a subscription's term end inside the window, with no domain, and leaves out one that is past or beyond it", async () => {
    const a = await careClient([{ key: "care", monthlyCents: 12_900, termEndsOn: plus(TODAY, 20) }, { key: "website_subscription", monthlyCents: 9_900, termEndsOn: plus(TODAY, 90) }]);
    expect((await facts(a)).renewals).toEqual([{ what: "subscription_term", domain: null, on: plus(TODAY, 20) }]);
    const b = await careClient([{ key: "care", monthlyCents: 12_900, termEndsOn: plus(TODAY, -3) }]);
    expect((await facts(b)).renewals).toEqual([]);
  });

  it("keeps at most 10, the soonest", async () => {
    const s = await careClient();
    for (let i = 0; i < 12; i++) {
      const x = await addSite(s, `https://ace-${i}.com`);
      await setDomainExpiry(env.DB, x.id, plus(TODAY, 12 - i), NOW.toISOString());
    }
    const f = await facts(s);
    expect(f.renewals).toHaveLength(10);
    expect(f.renewals[0].on).toBe(plus(TODAY, 1));
    expect(f.renewals[9].on).toBe(plus(TODAY, 10));
  });
});

describe("buildFacts: speed", () => {
  const answer = () => new Response(JSON.stringify(psi), { status: 200 });

  it("is the mobile performance score when PageSpeed answers", async () => {
    const s = await careClient();
    fetchSpy.mockResolvedValue(answer());
    expect((await facts(s, { speed: true })).sites[0].speedScore).toBe(34);
    expect(String(fetchSpy.mock.calls[0][0])).toContain("pagespeedonline");
  });

  it("is null, not 0, when PageSpeed throws, answers with an error or has no key, and the report is still made", async () => {
    const s = await careClient();
    fetchSpy.mockRejectedValue(new Error("boom"));
    expect((await facts(s, { speed: true })).sites[0].speedScore).toBeNull();
    fetchSpy.mockResolvedValue(new Response("nope", { status: 500 }));
    expect((await facts(s, { speed: true })).sites[0].speedScore).toBeNull();
    fetchSpy.mockResolvedValue(new Response(JSON.stringify({}), { status: 200 }));
    expect((await facts(s, { speed: true })).sites[0].speedScore).toBeNull();
    fetchSpy.mockClear();
    fetchSpy.mockResolvedValue(answer());
    const f = await buildFacts({ ...env, PAGESPEED_API_KEY: "" }, s.businessId, "2026-11", NOW, { speed: true });
    expect(f.sites[0].speedScore).toBeNull();
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("asks PageSpeed about at most three sites at a time, and one site's failure leaves the others' scores", async () => {
    const s = await careClient();
    for (let i = 0; i < 6; i++) await addSite(s, `https://ace-${i}.com`);
    let open = 0, most = 0, n = 0;
    fetchSpy.mockImplementation(async () => {
      open++; most = Math.max(most, open);
      await new Promise((r) => setTimeout(r, 5));
      open--;
      if (++n === 2) throw new Error("one site fails");
      return answer();
    });
    const f = await facts(s, { speed: true });
    expect(most).toBe(3);
    expect(f.sites).toHaveLength(7);
    expect(f.sites.filter((x) => x.speedScore === null)).toHaveLength(1);
    expect(f.sites.filter((x) => x.speedScore === 34)).toHaveLength(6);
  });

  it("is not asked for at all when `speed` is false", async () => {
    const s = await careClient();
    fetchSpy.mockResolvedValue(answer());
    expect((await facts(s, { speed: false })).sites[0].speedScore).toBeNull();
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});

describe("what the facts never hold", () => {
  it("has no ssh alias, folder, backup name, plugin slug or name, vault item or incident sentence anywhere in its JSON", async () => {
    const s = await careClient();
    const id = s.site!.id;
    await updateSite(env.DB, id, { wpSshAlias: "mac-ssh-alias-7", wpPath: "/var/www/ace-wp" }, NOW.toISOString());
    await env.DB.prepare(`UPDATE site_access_items SET vault_item = 'Ace Hosting Login', note = 'ask Pat for the second factor' WHERE site_id = ? AND key = 'hosting'`).bind(id).run();
    await run(id, "2026-11-12T18:00:00.000Z", { status: "rolled_back", backup: "siteline-backups/ace-2026-11-12.tar.gz", updates: [{ slug: "woo-secret-plugin-slug", outcome: "rolled_back" }, { slug: "seo-pack", outcome: "applied" }] });
    await openIncident(env.DB, { siteId: id, businessId: s.businessId, kind: "down", detail: "The shop returned HTTP 500 on /checkout, secret-incident-sentence", now: "2026-11-05T10:00:00.000Z" });
    await closeIncident(env.DB, id, "down", "2026-11-05T10:20:00.000Z");
    await days(id, "2026-11-01", "2026-11-30", 1);
    const f = await facts(s);
    const json = JSON.stringify(f) + plainSummary(f);
    for (const banned of [
      "alias", "wp_path", "wpPath", "mac-ssh-alias-7", "/var/www", "siteline-backups", "tar.gz", "woo-secret-plugin-slug", "Name of woo", "seo-pack", "Ace Hosting Login", "second factor",
      "secret-incident-sentence", "HTTP 500", "checkout",
    ]) expect(json, banned).not.toContain(banned);
    expect(f.sites[0]).toMatchObject({ incidents: 1, longestOutageMinutes: 20, updatesApplied: 1, updatesRolledBack: 1, backups: 1 });
  });
});

describe("plainSummary", () => {
  const base = (): ReportFacts => ({
    version: 1, period: "2026-11", label: "November 2026", from: "2026-11-01T07:00:00.000Z", to: "2026-12-01T08:00:00.000Z", clientName: "Ace Plumbing", generatedAt: NOW.toISOString(),
    sites: [{ domain: "ace.com", monitoredSince: "2026-11-01", uptimePercent: 99.9, coveredDays: 30, incidents: 1, longestOutageMinutes: 14, updatesApplied: 5, updatesRolledBack: 1, updatesFailed: 0, updatesTracked: true, backups: 2, speedScore: 71 }],
    edits: { month: "2026-11", allowanceMinutes: 60, usedMinutes: 45, percent: 75, state: "ok", requestsDone: 3 },
    renewals: [{ what: "domain", domain: "ace.com", on: "2027-01-10" }],
  });

  it("is plain sentences written from the numbers", () => {
    const text = plainSummary(base());
    expect(text).toContain("November 2026");
    expect(text).toContain("ace.com was up 99.9% of the time");
    expect(text).toMatch(/went down once, for about 14 minutes/);
    expect(text).toMatch(/5 updates were applied/);
    expect(text).toMatch(/1 was rolled back/);
    expect(text).toMatch(/45 of 60 edit minutes/);
    expect(text).toMatch(/3 edit requests/);
    expect(text).toMatch(/1 renewal/);
    expect(text).not.toContain("http");
  });

  it("says what it cannot measure by leaving it out, and says so plainly when nothing was done", () => {
    const f = base();
    f.sites = [{ domain: "ace.com", monitoredSince: null, uptimePercent: null, coveredDays: 0, incidents: 0, longestOutageMinutes: null, updatesApplied: 0, updatesRolledBack: 0, updatesFailed: 0, updatesTracked: true, backups: 0, speedScore: null }];
    f.edits = null;
    f.renewals = [];
    const text = plainSummary(f);
    expect(text).not.toMatch(/uptime|was up|%|speed|edit|renewal|backup/i);
    expect(text).toMatch(/no updates/i);
  });

  it("leaves the update sentence out for a site no update run ever covered (it was not measured, so it is not zero)", () => {
    const f = base();
    f.sites = [{ ...f.sites[0], updatesApplied: 0, updatesRolledBack: 0, updatesTracked: false, backups: 0 }];
    expect(plainSummary(f)).not.toMatch(/update|backup/i);
    delete f.sites[0].updatesTracked; // an older report has no such field: it reads as not tracked
    expect(plainSummary(f)).not.toMatch(/update/i);
    f.sites = [{ ...f.sites[0], updatesTracked: true }, { ...f.sites[0], domain: "shop.ace.com", updatesApplied: 7, updatesTracked: false }];
    expect(plainSummary(f)).toMatch(/0 updates were applied|No updates were applied/); // only the tracked site's figures are counted
  });

  it("stays under 600 characters with ten sites, and is the same for the same facts", () => {
    const f = base();
    f.sites = Array.from({ length: 10 }, (_, i) => ({ ...f.sites[0], domain: `a-rather-long-client-domain-name-${i}.example.com`, incidents: 2 }));
    f.renewals = Array.from({ length: 10 }, (_, i) => ({ what: "certificate" as const, domain: `d${i}.com`, on: "2027-01-10" }));
    const text = plainSummary(f);
    expect(text.length).toBeLessThanOrEqual(600);
    expect(text).not.toContain("http");
    expect(plainSummary(f)).toBe(text);
  });

  it("is under 600 characters and has no http for what buildFacts makes", async () => {
    const s = await careClient();
    await days(s.site!.id, "2026-11-01", "2026-11-30");
    const text = plainSummary(await facts(s));
    expect(text.length).toBeLessThan(600);
    expect(text).not.toContain("http");
  });
});
