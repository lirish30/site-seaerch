import { env } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import {
  cancel, editSummary, getReport, getReportByToken, getReportFor, insertReport, listReports, markSent, recordView, revoke, setSummary, setTaskAndApproval, uptimeDays, upsertUptimeDay,
} from "../src/worker/db/careReports";
import { getTask, insertTasks } from "../src/worker/db/tasks";
import { seedClient } from "./fixtures/clients";
import { newTask, seedProject } from "./fixtures/projects";

const T0 = "2026-12-01T10:00:00.000Z";
const T1 = "2026-12-01T11:00:00.000Z";
const T2 = "2026-12-01T12:00:00.000Z";
const P = "2026-11";

let n = 0;
async function made(o: { period?: string; test?: boolean } = {}) {
  const s = await seedClient();
  const { report } = await insertReport(env.DB, { businessId: s.businessId, period: o.period ?? P, token: `tok-${++n}`, facts: { a: 1 }, test: o.test ?? false, now: T0 });
  return { s, report };
}

describe("insertReport and reads", () => {
  it("is idempotent on (business, period): created true then false, one row, the first token and facts kept", async () => {
    const s = await seedClient();
    const first = await insertReport(env.DB, { businessId: s.businessId, period: P, token: "tok-a", facts: { a: 1 }, test: false, now: T0 });
    const again = await insertReport(env.DB, { businessId: s.businessId, period: P, token: "tok-b", facts: { a: 2 }, test: false, now: T1 });
    expect(first.created).toBe(true);
    expect(again.created).toBe(false);
    expect(again.report).toEqual(first.report);
    expect((await env.DB.prepare(`SELECT COUNT(*) AS n FROM care_reports WHERE business_id = ?`).bind(s.businessId).first<{ n: number }>())!.n).toBe(1);
    expect(first.report).toMatchObject({
      businessId: s.businessId, period: P, status: "collecting", token: "tok-a", facts: { a: 1 }, summary: "", recommendation: "", summarySource: "none", claudeTaskId: null, approvalId: null,
      test: false, createdAt: T0, readyAt: null, sentAt: null, firstViewedAt: null, viewCount: 0, revokedAt: null,
    });
  });

  it("reads by id, token and (business, period), and lists by period and status", async () => {
    const a = await made();
    const b = await made({ period: "2026-10" });
    expect(await getReport(env.DB, a.report.id)).toEqual(a.report);
    expect(await getReport(env.DB, "nope")).toBeNull();
    expect(await getReportByToken(env.DB, a.report.token)).toEqual(a.report);
    expect(await getReportByToken(env.DB, "nope")).toBeNull();
    expect(await getReportFor(env.DB, b.s.businessId, "2026-10")).toEqual(b.report);
    expect(await getReportFor(env.DB, b.s.businessId, P)).toBeNull();
    expect((await listReports(env.DB, { period: "2026-10" })).map((r) => r.id)).toContain(b.report.id);
    expect((await listReports(env.DB, { period: "2026-10" })).map((r) => r.id)).not.toContain(a.report.id);
    await setSummary(env.DB, a.report.id, ["collecting"], { summary: "s", recommendation: "r", source: "plain", now: T1 });
    const ready = await listReports(env.DB, { status: ["ready"] });
    expect(ready.map((r) => r.id)).toContain(a.report.id);
    expect(ready.map((r) => r.id)).not.toContain(b.report.id);
    expect((await listReports(env.DB, { status: [] })).length).toBe(0);
  });
});

describe("setSummary and editSummary", () => {
  it("setSummary from collecting makes the report ready with ready_at; a wrong from changes nothing", async () => {
    const { report } = await made();
    expect(await setSummary(env.DB, report.id, ["ready"], { summary: "x", recommendation: "y", source: "claude", now: T1 })).toBe(false);
    expect(await getReport(env.DB, report.id)).toEqual(report);
    expect(await setSummary(env.DB, report.id, ["collecting"], { summary: "All fine", recommendation: "Keep going", source: "claude", now: T1 })).toBe(true);
    expect(await getReport(env.DB, report.id)).toMatchObject({ status: "ready", readyAt: T1, summary: "All fine", recommendation: "Keep going", summarySource: "claude" });
  });

  it("setSummary from ready rewrites the text but keeps the first ready_at", async () => {
    const { report } = await made();
    await setSummary(env.DB, report.id, ["collecting"], { summary: "one", recommendation: "", source: "plain", now: T1 });
    expect(await setSummary(env.DB, report.id, ["ready"], { summary: "two", recommendation: "r", source: "claude", now: T2 })).toBe(true);
    expect(await getReport(env.DB, report.id)).toMatchObject({ status: "ready", readyAt: T1, summary: "two", summarySource: "claude" });
  });

  it("editSummary works only while ready, and marks the text as Logan's", async () => {
    const { report } = await made();
    expect(await editSummary(env.DB, report.id, { summary: "early", recommendation: "" })).toBe(false);
    await setSummary(env.DB, report.id, ["collecting"], { summary: "draft", recommendation: "d", source: "claude", now: T1 });
    expect(await editSummary(env.DB, report.id, { summary: "mine", recommendation: "my plan" })).toBe(true);
    expect(await getReport(env.DB, report.id)).toMatchObject({ summary: "mine", recommendation: "my plan", summarySource: "logan", status: "ready" });
    await markSent(env.DB, report.id, T2);
    expect(await editSummary(env.DB, report.id, { summary: "late", recommendation: "" })).toBe(false);
    expect((await getReport(env.DB, report.id))!.summary).toBe("mine");
  });

  it("setTaskAndApproval sets only the fields given", async () => {
    const { report } = await made();
    await setTaskAndApproval(env.DB, report.id, { claudeTaskId: "ct1" });
    expect(await getReport(env.DB, report.id)).toMatchObject({ claudeTaskId: "ct1", approvalId: null });
    await setTaskAndApproval(env.DB, report.id, { approvalId: "ap1" });
    expect(await getReport(env.DB, report.id)).toMatchObject({ claudeTaskId: "ct1", approvalId: "ap1" });
    await setTaskAndApproval(env.DB, report.id, {});
    expect(await getReport(env.DB, report.id)).toMatchObject({ claudeTaskId: "ct1", approvalId: "ap1" });
  });
});

describe("markSent, revoke, cancel, recordView", () => {
  it("markSent works from ready only, once", async () => {
    const { report } = await made();
    expect(await markSent(env.DB, report.id, T1)).toBe(false);
    await setSummary(env.DB, report.id, ["collecting"], { summary: "s", recommendation: "", source: "plain", now: T1 });
    expect(await markSent(env.DB, report.id, T2)).toBe(true);
    expect(await markSent(env.DB, report.id, T2)).toBe(false);
    expect(await getReport(env.DB, report.id)).toMatchObject({ status: "sent", sentAt: T2 });
  });

  it("revoke works from ready or sent, not from collecting", async () => {
    const a = await made();
    expect(await revoke(env.DB, a.report.id, T1)).toBe(false);
    expect((await getReport(env.DB, a.report.id))!.status).toBe("collecting");
    await setSummary(env.DB, a.report.id, ["collecting"], { summary: "s", recommendation: "", source: "plain", now: T1 });
    expect(await revoke(env.DB, a.report.id, T2)).toBe(true);
    expect(await getReport(env.DB, a.report.id)).toMatchObject({ status: "revoked", revokedAt: T2 });
    expect(await revoke(env.DB, a.report.id, T2)).toBe(false);
    const b = await made();
    await setSummary(env.DB, b.report.id, ["collecting"], { summary: "s", recommendation: "", source: "plain", now: T1 });
    await markSent(env.DB, b.report.id, T1);
    expect(await revoke(env.DB, b.report.id, T2)).toBe(true);
  });

  it("cancel works from collecting or ready, not once sent", async () => {
    const a = await made();
    expect(await cancel(env.DB, a.report.id)).toBe(true);
    expect((await getReport(env.DB, a.report.id))!.status).toBe("cancelled");
    expect(await cancel(env.DB, a.report.id)).toBe(false);
    const b = await made();
    await setSummary(env.DB, b.report.id, ["collecting"], { summary: "s", recommendation: "", source: "plain", now: T1 });
    expect(await cancel(env.DB, b.report.id)).toBe(true);
    const c = await made();
    await setSummary(env.DB, c.report.id, ["collecting"], { summary: "s", recommendation: "", source: "plain", now: T1 });
    await markSent(env.DB, c.report.id, T1);
    expect(await cancel(env.DB, c.report.id)).toBe(false);
  });

  it("recordView three times counts 3 and keeps the first view time", async () => {
    const { report } = await made();
    await recordView(env.DB, report.id, T0);
    await recordView(env.DB, report.id, T1);
    await recordView(env.DB, report.id, T2);
    expect(await getReport(env.DB, report.id)).toMatchObject({ viewCount: 3, firstViewedAt: T0 });
  });
});

describe("uptime days", () => {
  it("upsertUptimeDay twice for one day keeps one row with the latest numbers; reads are a range in day order", async () => {
    const s = await seedClient();
    const id = s.site!.id;
    await upsertUptimeDay(env.DB, id, "2026-11-02", 100, 99);
    await upsertUptimeDay(env.DB, id, "2026-11-02", 288, 280);
    await upsertUptimeDay(env.DB, id, "2026-11-01", 10, 10);
    await upsertUptimeDay(env.DB, id, "2026-11-30", 5, 4);
    await upsertUptimeDay(env.DB, id, "2026-12-01", 5, 5);
    expect((await env.DB.prepare(`SELECT COUNT(*) AS n FROM site_uptime_days WHERE site_id = ? AND day = '2026-11-02'`).bind(id).first<{ n: number }>())!.n).toBe(1);
    expect(await uptimeDays(env.DB, id, "2026-11-01", "2026-11-30")).toEqual([
      { day: "2026-11-01", checks: 10, okChecks: 10 }, { day: "2026-11-02", checks: 288, okChecks: 280 }, { day: "2026-11-30", checks: 5, okChecks: 4 },
    ]);
    expect(await uptimeDays(env.DB, "other-site", "2026-11-01", "2026-11-30")).toEqual([]);
  });
});

describe("the edit_request task flag", () => {
  it("round-trips through insertTasks and getTask, and defaults to false", async () => {
    const s = await seedProject();
    const [plain, flagged] = await insertTasks(env.DB, [
      newTask(s.project.id, s.businessId, { stepKey: "a", position: 0 }), newTask(s.project.id, s.businessId, { stepKey: "b", position: 1, editRequest: true }),
    ]);
    expect(plain.editRequest).toBe(false);
    expect(flagged.editRequest).toBe(true);
    expect((await getTask(env.DB, plain.id))!.editRequest).toBe(false);
    expect((await getTask(env.DB, flagged.id))!.editRequest).toBe(true);
    const raw = await env.DB.prepare(`SELECT edit_request FROM tasks WHERE id = ?`).bind(flagged.id).first<{ edit_request: number }>();
    expect(raw!.edit_request).toBe(1);
  });
});
