import { env } from "cloudflare:test";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { getReport, insertReport } from "../src/worker/db/careReports";
import { completeTask, expireOldTasks, finishClaudeTask, getTask } from "../src/worker/queue/db";
import { CARE_REPORT_KIND, CareReportResult, queueReport } from "../src/worker/queue/careReport";
import { getTaskKind } from "../src/worker/queue/registry";
import "../src/worker/queue/kinds";
import { seedClient } from "./fixtures/clients";
import { claimById } from "./fixtures/draftTask";

import * as approvalMod from "../src/worker/approvals/careReport";

// The real proposal lands with the report approval; here it is a stand-in that, like it, gives one approval per report.
const proposed = new Map<string, string>();
const standIn = async (_env: unknown, report: { id: string }) => {
  if (!proposed.has(report.id)) proposed.set(report.id, `approval-${proposed.size + 1}`);
  return proposed.get(report.id)!;
};

const NOW = "2026-12-01T10:00:00.000Z";
const site = (domain: string, over: Record<string, unknown> = {}) => ({
  domain, monitoredSince: "2026-10-03", uptimePercent: 99.9, coveredDays: 30, incidents: 0, longestOutageMinutes: null,
  updatesApplied: 4, updatesRolledBack: 0, updatesFailed: 0, updatesTracked: true, backups: 2, speedScore: 81, ...over,
});
const FACTS = {
  version: 1, period: "2026-11", label: "November 2026", from: "2026-11-01T08:00:00.000Z", to: "2026-12-01T08:00:00.000Z", clientName: "Acme Dental",
  sites: [site("acme-dental.example"), site("shop.acme-dental.example", { incidents: 2, longestOutageMinutes: 12, speedScore: null })],
  edits: { month: "2026-11", allowanceMinutes: 60, usedMinutes: 30, percent: 50, state: "ok", requestsDone: 3 },
  renewals: [{ what: "certificate", domain: "acme-dental.example", on: "2026-12-20" }], generatedAt: NOW,
};

let n = 0;
async function made(facts: unknown = FACTS) {
  const s = await seedClient();
  const { report } = await insertReport(env.DB, { businessId: s.businessId, period: "2026-11", token: `tok-care-report-${++n}`, facts, test: false, now: NOW });
  return report;
}
const kind = () => getTaskKind(CARE_REPORT_KIND)!;
const tasksOf = (reportId: string) => env.DB.prepare(`SELECT id, status, dedupe_key, target_type, target_id, payload FROM claude_tasks WHERE kind = 'care.report' AND target_id = ?`)
  .bind(reportId).all<{ id: string; status: string; dedupe_key: string; target_type: string; target_id: string; payload: string }>().then((r) => r.results);
async function claim(reportId: string) {
  await queueReport(env, reportId);
  return claimById((await tasksOf(reportId))[0].id);
}
const GOOD = { summary: "The site was up almost all month and four updates went in.", recommendation: "Look at why the shop site went down twice." };

beforeEach(() => { proposed.clear(); vi.spyOn(approvalMod, "proposeReportApproval").mockImplementation(standIn as typeof approvalMod.proposeReportApproval); });
afterEach(() => { vi.restoreAllMocks(); });

describe("the care.report kind", () => {
  it("is registered on Sonnet", () => {
    expect(kind()).toMatchObject({ kind: "care.report", suggestedModel: "sonnet" });
  });

  it("refuses a link, an address, an amount, markdown, a run of blank lines and too many characters, and trims", () => {
    const bad = ["see [here](x)", "# heading", "intro\n# heading", "- one\n- two", "* one", "intro\n  - one", "see https://x.example", "go to www.x.example", "write a@b.co", "it costs $99", "it costs $ 99", "this is **bold**", "## heading", "a\n\n\nb", "x".repeat(601)];
    for (const summary of bad) expect(CareReportResult.safeParse({ ...GOOD, summary }).success, summary).toBe(false);
    for (const recommendation of ["see https://x.example", "x".repeat(301), "  ", ""]) expect(CareReportResult.safeParse({ ...GOOD, recommendation }).success, recommendation).toBe(false);
    expect(CareReportResult.safeParse({ ...GOOD, summary: "" }).success).toBe(false);
    expect(CareReportResult.safeParse({ summary: "x".repeat(600), recommendation: "y".repeat(300) }).success).toBe(true);
    for (const recommendation of ["see [here](x)", "- do this"]) expect(CareReportResult.safeParse({ ...GOOD, recommendation }).success, recommendation).toBe(false);
    expect(CareReportResult.safeParse({ summary: "a\n\nb", recommendation: "ok" }).success).toBe(true);
    expect(CareReportResult.safeParse({ summary: "Uptime was 99.9% and it's fine - mostly. Two updates (both small) went in.", recommendation: "Ask about the shop's 2 outages." }).success).toBe(true);
    expect(CareReportResult.parse({ summary: "  hello  ", recommendation: " there " })).toEqual({ summary: "hello", recommendation: "there" });
  });

  it("queueReport queues one task per report and links it, however often it runs", async () => {
    const r = await made();
    await queueReport(env, r.id); await queueReport(env, r.id);
    const tasks = await tasksOf(r.id);
    expect(tasks).toMatchObject([{ status: "pending", dedupe_key: r.id, target_type: "care_report", target_id: r.id }]);
    expect((await getReport(env.DB, r.id))!.claudeTaskId).toBe(tasks[0].id);
  });

  it("queues nothing for a report that is not collecting", async () => {
    const r = await made();
    await env.DB.prepare(`UPDATE care_reports SET status = 'cancelled' WHERE id = ?`).bind(r.id).run();
    await queueReport(env, r.id);
    expect(await tasksOf(r.id)).toEqual([]);
  });

  it("build puts the numbers and the domain names in the untrusted block and none of them in the fixed instructions", async () => {
    const r = await made();
    const task = await claim(r.id);
    const built = await kind().build(env, task.payload, task);
    if ("stale" in built) throw new Error(built.stale);
    const text = built.untrusted.map((p) => (p as { text: string }).text).join("\n");
    for (const w of ["acme-dental.example", "shop.acme-dental.example", "Acme Dental", "November 2026", "incidents 2", "longest outage 12 minutes", "mobile speed score not measured", "99.9%", "30 of 60", "certificate"]) expect(text).toContain(w);
    for (const w of ["acme-dental", "Acme", "November", "99.9"]) expect(built.instructions).not.toContain(w);
    expect(built.instructions).toMatch(/Uptime and incidents come from different sources/);
    expect(built.instructions).toMatch(/incidents is above 0/);
    expect(built.instructions).toMatch(/Write nothing about anything that is not in them/);
    expect(built.instructions).toMatch(/never mention prices/);
    expect(built.instructions).toMatch(/Never promise results/);
    expect(built.instructions).toMatch(/ONE recommendation/);
  });

  it("build gives Claude no update or backup line for a site no update run covered (not measured, so not zero)", async () => {
    const r = await made({ ...FACTS, sites: [site("acme-dental.example"), site("shop.acme-dental.example", { updatesTracked: false, updatesApplied: 0, backups: 0 })] });
    const task = await claim(r.id);
    const built = await kind().build(env, task.payload, task);
    if ("stale" in built) throw new Error(built.stale);
    const lines = built.untrusted.map((p) => (p as { text: string }).text).join("\n").split("\n");
    expect(lines.find((l) => l.startsWith("Site acme-dental.example"))).toMatch(/updates applied 4/);
    const shop = lines.find((l) => l.startsWith("Site shop.acme-dental.example"))!;
    expect(shop).toContain("incidents 0");
    expect(shop).not.toMatch(/updates|backups/);
    expect(shop).toMatch(/mobile speed score 81 out of 100/);
  });

  it("build is stale once the report has its words, is gone, or has numbers that cannot be read", async () => {
    const r = await made();
    const task = await claim(r.id);
    await env.DB.prepare(`UPDATE care_reports SET status = 'ready' WHERE id = ?`).bind(r.id).run();
    expect(await kind().build(env, task.payload, task)).toEqual({ stale: expect.any(String) });
    expect(await kind().build(env, { reportId: "nope" }, task)).toEqual({ stale: expect.any(String) });
    const bad = await made({ nonsense: true });
    expect(await kind().build(env, { reportId: bad.id }, task)).toEqual({ stale: expect.any(String) });
  });

  it("build settles a report it cannot brief: the approval for stored words that have none, the plain summary for numbers that cannot be read", async () => {
    const r = await made();
    const task = await claim(r.id);
    await env.DB.prepare(`UPDATE care_reports SET status = 'ready', summary_source = 'claude', summary = ?, recommendation = ?, ready_at = ? WHERE id = ?`).bind(GOOD.summary, GOOD.recommendation, NOW, r.id).run();
    expect(await kind().build(env, task.payload, task)).toEqual({ stale: expect.any(String) });
    expect(await getReport(env.DB, r.id)).toMatchObject({ status: "ready", summary: GOOD.summary, summarySource: "claude", approvalId: "approval-1" });
    expect(await kind().build(env, task.payload, task)).toEqual({ stale: expect.any(String) });
    expect(proposed.size).toBe(1);

    const bad = await made({ version: 2 });
    expect(await kind().build(env, { reportId: bad.id }, task)).toEqual({ stale: expect.any(String) });
    const got = (await getReport(env.DB, bad.id))!;
    expect(got).toMatchObject({ status: "ready", summarySource: "plain", summary: "Care report for 2026-11.", recommendation: "", approvalId: "approval-2" });
  });

  it("a good result makes the report ready with Claude's words and one approval, and a second apply changes nothing", async () => {
    const r = await made();
    const task = await claim(r.id);
    expect(await completeTask(env, task.id, GOOD)).toEqual({ ok: true });
    const done = (await getReport(env.DB, r.id))!;
    expect(done).toMatchObject({ status: "ready", summarySource: "claude", summary: GOOD.summary, recommendation: GOOD.recommendation, approvalId: "approval-1" });
    expect(done.readyAt).not.toBeNull();
    expect(await completeTask(env, task.id, GOOD)).toMatchObject({ ok: false });
    expect(await kind().apply(env, { reportId: r.id }, { summary: "other words", recommendation: "other" }, task)).toEqual({ stale: expect.any(String) });
    expect(await getReport(env.DB, r.id)).toEqual(done);
    expect(proposed.size).toBe(1);
  });

  it("a refused result changes nothing and leaves the task claimed", async () => {
    const r = await made();
    const task = await claim(r.id);
    const res = await completeTask(env, task.id, { ...GOOD, summary: "Read more at https://x.example" });
    expect(res).toMatchObject({ ok: false });
    expect((await getReport(env.DB, r.id))!.status).toBe("collecting");
    expect((await getTask(env.DB, task.id))!.status).toBe("claimed");
    expect(proposed.size).toBe(0);
  });

  it("an apply that crashed after storing the words only proposes the approval when run again", async () => {
    const r = await made();
    const task = await claim(r.id);
    await env.DB.prepare(`UPDATE care_reports SET status = 'ready', summary_source = 'claude', summary = ?, recommendation = ?, ready_at = ? WHERE id = ?`).bind(GOOD.summary, GOOD.recommendation, NOW, r.id).run();
    expect(await completeTask(env, task.id, GOOD)).toEqual({ ok: true });
    expect(await getReport(env.DB, r.id)).toMatchObject({ approvalId: "approval-1", summary: GOOD.summary });
    expect(proposed.size).toBe(1);
  });

  it("an apply that crashed while Logan edited the words still proposes, and leaves his words", async () => {
    const r = await made();
    const task = await claim(r.id);
    await env.DB.prepare(`UPDATE care_reports SET status = 'ready', summary_source = 'logan', summary = 'mine', recommendation = 'his', ready_at = ? WHERE id = ?`).bind(NOW, r.id).run();
    expect(await completeTask(env, task.id, GOOD)).toEqual({ ok: true });
    expect(await getReport(env.DB, r.id)).toMatchObject({ summary: "mine", summarySource: "logan", approvalId: "approval-1" });
  });

  it("apply is stale for a report that was cancelled, and Logan's edited words are not overwritten", async () => {
    const r = await made();
    const task = await claim(r.id);
    await env.DB.prepare(`UPDATE care_reports SET status = 'cancelled' WHERE id = ?`).bind(r.id).run();
    expect(await completeTask(env, task.id, GOOD)).toEqual({ ok: true });
    expect(await getReport(env.DB, r.id)).toMatchObject({ status: "cancelled", summary: "", approvalId: null });
    expect((await getTask(env.DB, task.id))!.status).toBe("stale");
    const l = await made();
    const t2 = await claim(l.id);
    await env.DB.prepare(`UPDATE care_reports SET status = 'ready', summary_source = 'logan', summary = 'mine', approval_id = 'a' WHERE id = ?`).bind(l.id).run();
    expect(await completeTask(env, t2.id, GOOD)).toEqual({ ok: true });
    expect(await getReport(env.DB, l.id)).toMatchObject({ summary: "mine", summarySource: "logan" });
  });

  it("onExpire makes the report ready with the plain summary and one approval", async () => {
    const r = await made();
    await queueReport(env, r.id);
    await env.DB.prepare(`UPDATE claude_tasks SET created_at = '2020-01-01T00:00:00.000Z' WHERE kind = 'care.report' AND target_id = ?`).bind(r.id).run();
    await expireOldTasks(env, new Date());
    const done = (await getReport(env.DB, r.id))!;
    expect(done).toMatchObject({ status: "ready", summarySource: "plain", recommendation: "", approvalId: "approval-1" });
    expect(done.summary).toContain("Care report for November 2026.");
    expect(proposed.size).toBe(1);
    await kind().onExpire!(env, { reportId: r.id });
    expect(await getReport(env.DB, r.id)).toEqual(done);
    expect(proposed.size).toBe(1);
  });

  it("onFail does the same, and with numbers that cannot be read still leaves a non-empty summary", async () => {
    const r = await made();
    await kind().onFail!(env, { reportId: r.id }, "gave up", (await claim(r.id)));
    expect(await getReport(env.DB, r.id)).toMatchObject({ status: "ready", summarySource: "plain", approvalId: "approval-1" });
    const bad = await made({ nonsense: true });
    await kind().onFail!(env, { reportId: bad.id }, "gave up", (await claim(bad.id)));
    const got = (await getReport(env.DB, bad.id))!;
    expect(got.status).toBe("ready");
    expect(got.summary.length).toBeGreaterThan(0);
  });

  it("a task that ends failed in the queue settles the report", async () => {
    const r = await made();
    const task = await claim(r.id);
    await finishClaudeTask(env, task.id, "failed", "gave up");
    expect((await getReport(env.DB, r.id))!.status).toBe("ready");
  });
});
