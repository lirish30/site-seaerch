import { env } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import {
  cancelSeoReport, editSeoSummary, getSeoReport, getSeoReportByToken, getSeoReportFor, insertSeoReport, listSeoReports, markSeoSent, recordSeoView, revokeSeoReport, setSeoSummary, setSeoTaskAndApproval,
} from "../src/worker/db/seoReports";
import { seedClient } from "./fixtures/clients";

const T0 = "2026-12-01T10:00:00.000Z";
const T1 = "2026-12-01T11:00:00.000Z";
const T2 = "2026-12-01T12:00:00.000Z";
const P = "2026-11";
const THREE = ["Answer the two low reviews", "Fix the phone number on the site", "Publish the drain page"];

let n = 0;
async function made(o: { period?: string; test?: boolean } = {}) {
  const s = await seedClient();
  const { report } = await insertSeoReport(env.DB, { businessId: s.businessId, period: o.period ?? P, token: `seo-tok-${++n}`, facts: { a: 1 }, test: o.test ?? false, now: T0 });
  return { s, report };
}
const words = (o: { source?: "claude" | "plain" | "logan"; priorities?: string[]; now?: string } = {}) => ({ summary: "s", recommendation: "r", priorities: o.priorities ?? [], source: o.source ?? "plain", now: o.now ?? T1 } as const);

describe("insertSeoReport and reads", () => {
  it("is idempotent on (business, period): created true then false, one row, the first token and facts kept", async () => {
    const s = await seedClient();
    const first = await insertSeoReport(env.DB, { businessId: s.businessId, period: P, token: "seo-a", facts: { a: 1 }, test: false, now: T0 });
    const again = await insertSeoReport(env.DB, { businessId: s.businessId, period: P, token: "seo-b", facts: { a: 2 }, test: false, now: T1 });
    expect(first.created).toBe(true);
    expect(again.created).toBe(false);
    expect(again.report).toEqual(first.report);
    expect((await env.DB.prepare(`SELECT COUNT(*) AS n FROM seo_reports WHERE business_id = ?`).bind(s.businessId).first<{ n: number }>())!.n).toBe(1);
    expect(first.report).toMatchObject({
      businessId: s.businessId, period: P, status: "collecting", token: "seo-a", facts: { a: 1 }, summary: "", recommendation: "", priorities: [], summarySource: "none", claudeTaskId: null, approvalId: null,
      test: false, createdAt: T0, readyAt: null, sentAt: null, firstViewedAt: null, viewCount: 0, revokedAt: null,
    });
  });

  it("reads by id, token and (business, period), and lists by period, client and status", async () => {
    const a = await made();
    const b = await made({ period: "2026-10" });
    expect(await getSeoReport(env.DB, a.report.id)).toEqual(a.report);
    expect(await getSeoReport(env.DB, "nope")).toBeNull();
    expect(await getSeoReportByToken(env.DB, a.report.token)).toEqual(a.report);
    expect(await getSeoReportByToken(env.DB, "nope")).toBeNull();
    expect(await getSeoReportFor(env.DB, b.s.businessId, "2026-10")).toEqual(b.report);
    expect(await getSeoReportFor(env.DB, b.s.businessId, P)).toBeNull();
    expect((await listSeoReports(env.DB, { period: "2026-10" })).map((r) => r.id)).toContain(b.report.id);
    expect((await listSeoReports(env.DB, { period: "2026-10" })).map((r) => r.id)).not.toContain(a.report.id);
    expect((await listSeoReports(env.DB, { businessId: a.s.businessId })).map((r) => r.id)).toEqual([a.report.id]);
    await setSeoSummary(env.DB, a.report.id, ["collecting"], words());
    const ready = await listSeoReports(env.DB, { status: ["ready"] });
    expect(ready.map((r) => r.id)).toContain(a.report.id);
    expect(ready.map((r) => r.id)).not.toContain(b.report.id);
    expect((await listSeoReports(env.DB, { status: [] })).length).toBe(0);
  });

  it("reads facts that are not JSON as null, and priorities that are not a list of strings as none", async () => {
    const { report } = await made();
    await env.DB.prepare(`UPDATE seo_reports SET facts = 'not json', priorities = '{"a":1}' WHERE id = ?`).bind(report.id).run();
    expect(await getSeoReport(env.DB, report.id)).toMatchObject({ facts: null, priorities: [] });
    await env.DB.prepare(`UPDATE seo_reports SET priorities = '["one", 2, "three"]' WHERE id = ?`).bind(report.id).run();
    expect((await getSeoReport(env.DB, report.id))!.priorities).toEqual(["one", "three"]);
  });
});

describe("setSeoSummary and editSeoSummary", () => {
  it("setSeoSummary from collecting makes the report ready with ready_at; a wrong from changes nothing", async () => {
    const { report } = await made();
    expect(await setSeoSummary(env.DB, report.id, ["ready"], words({ source: "claude" }))).toBe(false);
    expect(await setSeoSummary(env.DB, report.id, [], words({ source: "claude" }))).toBe(false);
    expect(await getSeoReport(env.DB, report.id)).toEqual(report);
    expect(await setSeoSummary(env.DB, report.id, ["collecting"], { summary: "All fine", recommendation: "Keep going", priorities: THREE, source: "claude", now: T1 })).toBe(true);
    expect(await getSeoReport(env.DB, report.id)).toMatchObject({ status: "ready", readyAt: T1, summary: "All fine", recommendation: "Keep going", priorities: THREE, summarySource: "claude" });
  });

  it("priorities round-trip as a JSON array, in order, and are stored as one", async () => {
    const { report } = await made();
    await setSeoSummary(env.DB, report.id, ["collecting"], words({ source: "claude", priorities: THREE }));
    expect((await getSeoReport(env.DB, report.id))!.priorities).toEqual(THREE);
    expect((await env.DB.prepare(`SELECT priorities FROM seo_reports WHERE id = ?`).bind(report.id).first<{ priorities: string }>())!.priorities).toBe(JSON.stringify(THREE));
    const plain = (await made()).report;
    await setSeoSummary(env.DB, plain.id, ["collecting"], words());
    expect((await getSeoReport(env.DB, plain.id))!.priorities).toEqual([]);
  });

  it("setSeoSummary from ready rewrites the text but keeps the first ready_at", async () => {
    const { report } = await made();
    await setSeoSummary(env.DB, report.id, ["collecting"], { ...words(), summary: "one" });
    expect(await setSeoSummary(env.DB, report.id, ["ready"], { summary: "two", recommendation: "r", priorities: THREE, source: "claude", now: T2 })).toBe(true);
    expect(await getSeoReport(env.DB, report.id)).toMatchObject({ status: "ready", readyAt: T1, summary: "two", summarySource: "claude", priorities: THREE });
  });

  it("editSeoSummary works only while ready, marks the text as Logan's, and leaves priorities alone when none are given", async () => {
    const { report } = await made();
    expect(await editSeoSummary(env.DB, report.id, { summary: "early", recommendation: "" })).toBe(false);
    await setSeoSummary(env.DB, report.id, ["collecting"], { summary: "draft", recommendation: "d", priorities: THREE, source: "claude", now: T1 });
    expect(await editSeoSummary(env.DB, report.id, { summary: "mine", recommendation: "my plan" })).toBe(true);
    expect(await getSeoReport(env.DB, report.id)).toMatchObject({ summary: "mine", recommendation: "my plan", summarySource: "logan", status: "ready", priorities: THREE });
    expect(await editSeoSummary(env.DB, report.id, { summary: "mine", recommendation: "my plan", priorities: ["only one"] })).toBe(true);
    expect((await getSeoReport(env.DB, report.id))!.priorities).toEqual(["only one"]);
    expect(await editSeoSummary(env.DB, report.id, { summary: "mine", recommendation: "my plan", priorities: [] })).toBe(true);
    expect((await getSeoReport(env.DB, report.id))!.priorities).toEqual([]);
    await markSeoSent(env.DB, report.id, T2);
    expect(await editSeoSummary(env.DB, report.id, { summary: "late", recommendation: "" })).toBe(false);
    expect((await getSeoReport(env.DB, report.id))!.summary).toBe("mine");
  });

  it("setSeoTaskAndApproval sets only the fields given", async () => {
    const { report } = await made();
    await setSeoTaskAndApproval(env.DB, report.id, { claudeTaskId: "ct1" });
    expect(await getSeoReport(env.DB, report.id)).toMatchObject({ claudeTaskId: "ct1", approvalId: null });
    await setSeoTaskAndApproval(env.DB, report.id, { approvalId: "ap1" });
    expect(await getSeoReport(env.DB, report.id)).toMatchObject({ claudeTaskId: "ct1", approvalId: "ap1" });
    await setSeoTaskAndApproval(env.DB, report.id, {});
    expect(await getSeoReport(env.DB, report.id)).toMatchObject({ claudeTaskId: "ct1", approvalId: "ap1" });
  });
});

describe("markSeoSent, revokeSeoReport, cancelSeoReport, recordSeoView", () => {
  it("markSeoSent works from ready only, once", async () => {
    const { report } = await made();
    expect(await markSeoSent(env.DB, report.id, T1)).toBe(false);
    await setSeoSummary(env.DB, report.id, ["collecting"], words());
    expect(await markSeoSent(env.DB, report.id, T2)).toBe(true);
    expect(await markSeoSent(env.DB, report.id, T2)).toBe(false);
    expect(await getSeoReport(env.DB, report.id)).toMatchObject({ status: "sent", sentAt: T2 });
  });

  it("revokeSeoReport works from ready or sent, not from collecting", async () => {
    const a = await made();
    expect(await revokeSeoReport(env.DB, a.report.id, T1)).toBe(false);
    expect((await getSeoReport(env.DB, a.report.id))!.status).toBe("collecting");
    await setSeoSummary(env.DB, a.report.id, ["collecting"], words());
    expect(await revokeSeoReport(env.DB, a.report.id, T2)).toBe(true);
    expect(await getSeoReport(env.DB, a.report.id)).toMatchObject({ status: "revoked", revokedAt: T2 });
    expect(await revokeSeoReport(env.DB, a.report.id, T2)).toBe(false);
    const b = await made();
    await setSeoSummary(env.DB, b.report.id, ["collecting"], words());
    await markSeoSent(env.DB, b.report.id, T1);
    expect(await revokeSeoReport(env.DB, b.report.id, T2)).toBe(true);
  });

  it("cancelSeoReport works from collecting or ready, not once sent", async () => {
    const a = await made();
    expect(await cancelSeoReport(env.DB, a.report.id)).toBe(true);
    expect((await getSeoReport(env.DB, a.report.id))!.status).toBe("cancelled");
    expect(await cancelSeoReport(env.DB, a.report.id)).toBe(false);
    const b = await made();
    await setSeoSummary(env.DB, b.report.id, ["collecting"], words());
    expect(await cancelSeoReport(env.DB, b.report.id)).toBe(true);
    const c = await made();
    await setSeoSummary(env.DB, c.report.id, ["collecting"], words());
    await markSeoSent(env.DB, c.report.id, T1);
    expect(await cancelSeoReport(env.DB, c.report.id)).toBe(false);
  });

  it("recordSeoView three times counts 3 and keeps the first view time", async () => {
    const { report } = await made();
    await recordSeoView(env.DB, report.id, T0);
    await recordSeoView(env.DB, report.id, T1);
    await recordSeoView(env.DB, report.id, T2);
    expect(await getSeoReport(env.DB, report.id)).toMatchObject({ viewCount: 3, firstViewedAt: T0 });
  });

  it("keeps a test report flagged", async () => {
    const { report } = await made({ test: true });
    expect(report.test).toBe(true);
  });
});
