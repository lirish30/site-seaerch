import { createExecutionContext, env } from "cloudflare:test";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import worker from "../src/worker/index";
import { proposeReportApproval } from "../src/worker/approvals/careReport";
import { cancelReport } from "../src/worker/care/reportAdmin";
import { getReport, insertReport, markSent, setSummary, setTaskAndApproval, type CareReport } from "../src/worker/db/careReports";
import { createProject } from "../src/worker/db/projects";
import { ensureSeedSops } from "../src/worker/db/sops";
import type { Env } from "../src/worker/env";
import { enqueueTask } from "../src/worker/queue/db";
import "../src/worker/queue/kinds";
import { CARE_REPORT_KIND, CARE_REPORT_TARGET } from "../src/worker/queue/careReport";
import { seedClient } from "./fixtures/clients";
import { E } from "./fixtures/close";
import { resetProjectWork } from "./fixtures/projects";

// The owner's report routes (Plan 13): the list, Logan's edit of the words, the take-back, and the edit request. The clock: 2 December 2026, so last month is November.
const NOW = new Date("2026-12-02T18:00:00.000Z");
const CARE = [{ key: "care" as const, monthlyCents: 12_900 }];
const BASE = "https://clients.hellositeline.test";
const SUMMARY = "The site was up almost all month and four updates went in.";
const RECOMMENDATION = "Look at why the shop site went down twice.";
const FACTS = {
  version: 1, period: "2026-11", label: "November 2026", from: "2026-11-01T08:00:00.000Z", to: "2026-12-01T08:00:00.000Z", clientName: "Ace Plumbing",
  sites: [], edits: null, renewals: [], generatedAt: NOW.toISOString(),
};
const ctx = () => createExecutionContext();
const e = { ...E, CLIENT_LINK_BASE: BASE } as Env;

beforeEach(async () => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(NOW);
  vi.spyOn(console, "error").mockImplementation(() => {});
  for (const t of ["site_incidents", "site_checks", "site_uptime_days", "care_reports", "helper_jobs"]) await env.DB.prepare(`DELETE FROM ${t}`).run();
  await resetProjectWork();
  for (const t of ["billing_holds", "invoice_nudges", "invoices", "subscriptions", "document_views", "document_signatures", "documents", "deals", "activity", "drafts", "audits", "search_results", "businesses", "suppressions", "messages"])
    await env.DB.prepare(`DELETE FROM ${t}`).run();
  await env.DB.prepare(`DELETE FROM approvals WHERE kind = 'care.report'`).run();
  await env.DB.prepare(`DELETE FROM claude_tasks WHERE kind = 'care.report'`).run();
  await env.DB.batch([env.DB.prepare(`DELETE FROM sop_template_steps`), env.DB.prepare(`DELETE FROM sop_templates`)]);
  await ensureSeedSops(env.DB);
});
afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); });

let cookie = "";
async function signIn() {
  const login = await worker.fetch(new Request("https://x/api/login", { method: "POST", body: JSON.stringify({ password: "test-pass" }), headers: { "content-type": "application/json" } }), E, ctx());
  expect(login.status).toBe(200);
  cookie = login.headers.get("set-cookie")!.split(";")[0];
}
const call = async (method: string, path: string, body?: unknown, session = true) => {
  if (session && !cookie) await signIn();
  return worker.fetch(new Request(`https://x/api${path}`, {
    method, body: body === undefined ? undefined : JSON.stringify(body), headers: { ...(session ? { cookie } : {}), "content-type": "application/json" },
  }), e, ctx());
};
const json = async <T = any>(method: string, path: string, body?: unknown, status = 200): Promise<T> => {
  const r = await call(method, path, body);
  expect(r.status, `${method} ${path}`).toBe(status);
  return (await r.json()) as T;
};

let n = 0;
async function client(name = "Ace Plumbing", o: { care?: boolean } = {}) {
  const s = await seedClient({ subs: o.care === false ? [] : CARE });
  await env.DB.prepare(`UPDATE businesses SET name = ? WHERE id = ?`).bind(name, s.businessId).run();
  return s;
}
async function report(s: { businessId: string }, status: "collecting" | "ready" | "sent" | "revoked" | "cancelled" = "ready", o: { period?: string; test?: boolean } = {}): Promise<CareReport> {
  const { report: r } = await insertReport(env.DB, { businessId: s.businessId, period: o.period ?? "2026-11", token: `tok-routes-${++n}-${"x".repeat(24)}`, facts: FACTS, test: o.test ?? false, now: "2026-12-01T10:00:00.000Z" });
  if (status !== "collecting") expect(await setSummary(env.DB, r.id, ["collecting"], { summary: SUMMARY, recommendation: RECOMMENDATION, source: "claude", now: "2026-12-01T11:00:00.000Z" })).toBe(true);
  if (status === "sent") expect(await markSent(env.DB, r.id, "2026-12-01T17:00:00.000Z")).toBe(true);
  if (status === "revoked") await env.DB.prepare(`UPDATE care_reports SET status = 'revoked', revoked_at = '2026-12-02T10:00:00.000Z' WHERE id = ?`).bind(r.id).run();
  if (status === "cancelled") await env.DB.prepare(`UPDATE care_reports SET status = 'cancelled' WHERE id = ?`).bind(r.id).run();
  return (await getReport(env.DB, r.id))!;
}
const approvalOf = (id: string) => env.DB.prepare(`SELECT status, preview, decision_note, title FROM approvals WHERE id = ?`).bind(id).first<{ status: string; preview: string; decision_note: string | null; title: string }>();
const taskOf = (id: string) => env.DB.prepare(`SELECT status FROM claude_tasks WHERE id = ?`).bind(id).first<{ status: string }>();

describe("owner session", () => {
  it("every route is 401 without a session", async () => {
    const calls: [string, string, unknown?][] = [
      ["GET", "/care/reports"], ["PUT", "/care/reports/x", { summary: SUMMARY, recommendation: RECOMMENDATION }], ["POST", "/care/reports/x/revoke"], ["POST", "/clients/x/edit-requests", { title: "Edit" }],
    ];
    for (const [m, p, b] of calls) expect((await call(m, p, b, false)).status, `${m} ${p}`).toBe(401);
  });
});

describe("GET /care/reports", () => {
  it("lists last month's reports with the client, status, words, link and edit hours, and a link only for ready and sent", async () => {
    const a = await client("Ace Plumbing");
    const b = await client("Bay Roofing");
    const c = await client("Cedar Dental");
    const d = await client("Delta Auto");
    const x = await client("Echo Fencing");
    const ready = await report(a, "ready");
    const sent = await report(b, "sent");
    const collecting = await report(c, "collecting");
    const revoked = await report(d, "revoked");
    const cancelled = await report(x, "cancelled");
    await report(a, "ready", { period: "2026-10" });

    const body = await json<{ period: string; reports: any[] }>("GET", "/care/reports");
    expect(body.period).toBe("2026-11");
    expect(body.reports).toHaveLength(5);
    const by = (r: CareReport) => body.reports.find((x) => x.id === r.id);
    expect(by(ready)).toEqual({
      id: ready.id, client: "Ace Plumbing", clientId: a.businessId, period: "2026-11", status: "ready", summary: SUMMARY, recommendation: RECOMMENDATION, source: "claude", sentOn: null, views: 0, test: false,
      link: `${BASE}/m/${ready.token}`, ledger: { month: "2026-11", allowanceMinutes: 60, usedMinutes: 0, percent: 0, state: "ok" },
    });
    expect(by(sent)).toMatchObject({ status: "sent", sentOn: "2026-12-01", link: `${BASE}/m/${sent.token}` });
    for (const r of [collecting, revoked, cancelled]) expect(by(r).link, r.status).toBeNull();
    expect(by(collecting)).toMatchObject({ status: "collecting", summary: "", source: "none" });
    // A token appears only inside the link of a ready or sent report, never alone and never for another status.
    const text = JSON.stringify(body);
    for (const r of [collecting, revoked, cancelled]) expect(text).not.toContain(r.token);
    expect(text.split(ready.token)).toHaveLength(2);
    for (const r of body.reports) expect(Object.keys(r).sort()).toEqual(["client", "clientId", "id", "ledger", "link", "period", "recommendation", "sentOn", "source", "status", "summary", "test", "views"]);
  });

  it("takes ?period, answers an empty list for a month with none and refuses a bad month", async () => {
    const a = await client();
    const old = await report(a, "ready", { period: "2026-10" });
    expect((await json<{ period: string; reports: { id: string }[] }>("GET", "/care/reports?period=2026-10"))).toMatchObject({ period: "2026-10", reports: [{ id: old.id, ledger: { month: "2026-10" } }] });
    expect(await json("GET", "/care/reports?period=2026-09")).toEqual({ period: "2026-09", reports: [] });
    for (const bad of ["2026-13", "november", "2026-1", "2026-11-01", ""]) expect((await call("GET", `/care/reports?period=${bad}`)).status, bad).toBe(400);
  });

  it("narrows to one client with ?clientId, every month of theirs newest first when no period is given", async () => {
    const a = await client("Ace Plumbing");
    const b = await client("Bay Roofing");
    const nov = await report(a, "sent");
    const oct = await report(a, "sent", { period: "2026-10" });
    await report(b, "ready");
    const all = await json<{ period: string | null; reports: { id: string; ledger: { month: string } }[] }>("GET", `/care/reports?clientId=${a.businessId}`);
    expect(all.period).toBeNull();
    expect(all.reports.map((r) => [r.id, r.ledger.month])).toEqual([[nov.id, "2026-11"], [oct.id, "2026-10"]]);
    expect((await json<{ reports: { id: string }[] }>("GET", `/care/reports?clientId=${a.businessId}&period=2026-10`)).reports.map((r) => r.id)).toEqual([oct.id]);
    expect((await json<{ reports: unknown[] }>("GET", "/care/reports?clientId=nope")).reports).toEqual([]);
  });

  it("gives a null ledger for a client with no live Care plan and a count of views", async () => {
    const a = await client("No Plan", { care: false });
    const r = await report(a, "sent");
    await env.DB.prepare(`UPDATE care_reports SET view_count = 3 WHERE id = ?`).bind(r.id).run();
    const row = (await json<{ reports: any[] }>("GET", "/care/reports")).reports[0];
    expect(row).toMatchObject({ ledger: null, views: 3 });
  });
});

describe("PUT /care/reports/:id", () => {
  it("edits the summary and the recommendation of a ready report; the words become Logan's", async () => {
    const r = await report(await client(), "ready");
    const out = await json<{ report: any }>("PUT", `/care/reports/${r.id}`, { summary: "  Up all month, and five updates went in.  ", recommendation: "Nothing to fix right now." });
    expect(out.report).toMatchObject({ id: r.id, status: "ready", summary: "Up all month, and five updates went in.", recommendation: "Nothing to fix right now.", source: "logan" });
    expect(await getReport(env.DB, r.id)).toMatchObject({ summary: "Up all month, and five updates went in.", summarySource: "logan", status: "ready" });
  });

  it("refuses a sent, revoked, cancelled and collecting report with a plain sentence and changes nothing", async () => {
    const a = await client();
    for (const status of ["sent", "revoked", "cancelled", "collecting"] as const) {
      const r = await report(a, status, { period: `2026-0${["sent", "revoked", "cancelled", "collecting"].indexOf(status) + 1}` });
      const res = await call("PUT", `/care/reports/${r.id}`, { summary: "A new summary.", recommendation: "A new thing." });
      expect(res.status, status).toBe(409);
      expect(((await res.json()) as { error: string }).error).toMatch(/ready/);
      expect((await getReport(env.DB, r.id))!.summary, status).toBe(status === "collecting" ? "" : SUMMARY);
    }
  });

  it("refuses words that break the text rules (a link, an address, a price, markdown, a blank, too long) with a sentence naming the field", async () => {
    const r = await report(await client(), "ready");
    const bad: [string, string, string][] = [
      ["summary", "See https://evil.example for more.", "summary"], ["summary", "Write to me@ace.com.", "summary"], ["summary", "It costs $50 a month.", "summary"], ["summary", "**Bold** words.", "summary"],
      ["summary", "   ", "summary"], ["summary", "x".repeat(601), "summary"], ["summary", "One.\n\n\n\nTwo.", "summary"],
      ["recommendation", "Visit www.ace.com now.", "recommendation"], ["recommendation", "- a bullet", "recommendation"], ["recommendation", "y".repeat(301), "recommendation"],
    ];
    for (const [field, value, name] of bad) {
      const body = { summary: SUMMARY, recommendation: RECOMMENDATION, [field]: value };
      const res = await call("PUT", `/care/reports/${r.id}`, body);
      expect(res.status, `${field} ${value.slice(0, 20)}`).toBe(400);
      expect(((await res.json()) as { error: string }).error.toLowerCase()).toContain(name);
    }
    expect(await getReport(env.DB, r.id)).toMatchObject({ summary: SUMMARY, recommendation: RECOMMENDATION, summarySource: "claude" });
    expect((await call("PUT", `/care/reports/${r.id}`, { summary: SUMMARY })).status).toBe(400); // the recommendation is part of it
    expect((await call("PUT", `/care/reports/${r.id}`, { summary: SUMMARY, recommendation: RECOMMENDATION, status: "sent" })).status).toBe(400);
  });

  it("allows an empty recommendation (a plain summary has none)", async () => {
    const r = await report(await client(), "ready");
    expect((await call("PUT", `/care/reports/${r.id}`, { summary: SUMMARY, recommendation: "" })).status).toBe(200);
    expect((await getReport(env.DB, r.id))!.recommendation).toBe("");
  });

  it("404 for a report nobody has", async () => {
    expect((await call("PUT", "/care/reports/nope", { summary: SUMMARY, recommendation: RECOMMENDATION })).status).toBe(404);
  });

  it("rewrites the pending approval's card, so Logan approves the words the card shows", async () => {
    const r = await report(await client(), "ready");
    const approvalId = (await proposeReportApproval(e, r))!;
    expect((await approvalOf(approvalId))!.preview).toContain(SUMMARY);

    await json("PUT", `/care/reports/${r.id}`, { summary: "A brand new summary written by Logan.", recommendation: "A brand new recommendation." });
    const after = (await approvalOf(approvalId))!;
    expect(after.status).toBe("pending");
    expect(after.preview).toContain("A brand new summary written by Logan.");
    expect(after.preview).toContain("A brand new recommendation.");
    expect(after.preview).toContain("you edited it");
    expect(after.preview).not.toContain(SUMMARY);
    expect(after.preview).not.toContain(RECOMMENDATION);
    expect(after.title).toMatch(/November 2026 report/);
  });

  it("leaves a decided approval alone", async () => {
    const r = await report(await client(), "ready");
    const approvalId = (await proposeReportApproval(e, r))!;
    await env.DB.prepare(`UPDATE approvals SET status = 'rejected' WHERE id = ?`).bind(approvalId).run();
    const before = (await approvalOf(approvalId))!.preview;
    await json("PUT", `/care/reports/${r.id}`, { summary: "Words after the decision.", recommendation: "More words." });
    expect((await approvalOf(approvalId))!.preview).toBe(before);
  });
});

describe("POST /care/reports/:id/revoke", () => {
  it("takes back a ready report: it is revoked, its queued Claude task is closed and its pending approval is rejected with a note", async () => {
    const r = await report(await client(), "ready");
    const approvalId = (await proposeReportApproval(e, r))!;
    const { id: taskId } = await enqueueTask(env.DB, CARE_REPORT_KIND, { reportId: r.id }, { dedupeKey: r.id, targetType: CARE_REPORT_TARGET, targetId: r.id });
    await setTaskAndApproval(env.DB, r.id, { claudeTaskId: taskId });

    const out = await json<{ report: any }>("POST", `/care/reports/${r.id}/revoke`);
    expect(out.report).toMatchObject({ id: r.id, status: "revoked", link: null });
    expect(await getReport(env.DB, r.id)).toMatchObject({ status: "revoked" });
    expect((await taskOf(taskId))!.status).toBe("stale");
    expect(await approvalOf(approvalId)).toMatchObject({ status: "rejected", decision_note: "the report was revoked" });
  });

  it("takes back a sent report; its approval, already used, stays as it was", async () => {
    const r = await report(await client(), "ready");
    const approvalId = (await proposeReportApproval(e, r))!;
    await env.DB.prepare(`UPDATE approvals SET status = 'approved' WHERE id = ?`).bind(approvalId).run();
    expect(await markSent(env.DB, r.id, "2026-12-01T17:00:00.000Z")).toBe(true);
    expect((await json<{ report: any }>("POST", `/care/reports/${r.id}/revoke`)).report).toMatchObject({ status: "revoked", link: null });
    expect((await approvalOf(approvalId))!.status).toBe("approved");
  });

  it("refuses a collecting, revoked or cancelled report and an unknown one", async () => {
    const a = await client();
    for (const [i, status] of (["collecting", "revoked", "cancelled"] as const).entries()) {
      const r = await report(a, status, { period: `2026-0${i + 1}` });
      const res = await call("POST", `/care/reports/${r.id}/revoke`);
      expect(res.status, status).toBe(409);
      expect(((await res.json()) as { error: string }).error).toMatch(/ready or sent/);
      expect((await getReport(env.DB, r.id))!.status).toBe(status);
    }
    expect((await call("POST", "/care/reports/nope/revoke")).status).toBe(404);
  });
});

describe("cancelReport", () => {
  it("drops a report that was never sent and takes back its task and its pending approval", async () => {
    const a = await client();
    const collecting = await report(a, "collecting", { period: "2026-09" });
    const { id: t1 } = await enqueueTask(env.DB, CARE_REPORT_KIND, { reportId: collecting.id }, { dedupeKey: collecting.id, targetType: CARE_REPORT_TARGET, targetId: collecting.id });
    expect(await cancelReport(e, collecting.id)).toBe(true);
    expect((await getReport(env.DB, collecting.id))!.status).toBe("cancelled");
    expect((await taskOf(t1))!.status).toBe("stale");

    const ready = await report(a, "ready");
    const approvalId = (await proposeReportApproval(e, ready))!;
    expect(await cancelReport(e, ready.id)).toBe(true);
    expect(await approvalOf(approvalId)).toMatchObject({ status: "rejected", decision_note: "the report was cancelled" });

    const sent = await report(a, "sent", { period: "2026-08" });
    expect(await cancelReport(e, sent.id)).toBe(false);
    expect((await getReport(env.DB, sent.id))!.status).toBe("sent");
  });
});

describe("POST /clients/:id/edit-requests", () => {
  async function careClient() {
    const s = await client();
    await createProject(env.DB, {
      businessId: s.businessId, dealId: null, documentId: null, onboardingId: null, kind: "care_onboarding", name: "Care", test: false, templateKey: "CARE-0", templateVersion: 1, careDeferred: false,
      startedAt: "2026-10-01T10:00:00.000Z",
    });
    return s;
  }

  it("makes the task and answers 201 with its id", async () => {
    const s = await careClient();
    const out = await json<{ taskId: string }>("POST", `/clients/${s.businessId}/edit-requests`, { title: "Change the opening hours" }, 201);
    const row = await env.DB.prepare(`SELECT title, edit_request, billable, is_step FROM tasks WHERE id = ?`).bind(out.taskId).first<{ title: string; edit_request: number; billable: number; is_step: number }>();
    expect(row).toEqual({ title: "Change the opening hours", edit_request: 1, billable: 0, is_step: 0 });
  });

  it("is 409 with the sentence when it is refused, 400 for a missing or non-text title, 404 for an unknown client", async () => {
    const s = await client(); // no Care project
    const refused = await call("POST", `/clients/${s.businessId}/edit-requests`, { title: "Edit" });
    expect(refused.status).toBe(409);
    expect(((await refused.json()) as { error: string }).error).toMatch(/no live Care project/);
    const ok = await careClient();
    for (const body of [{}, { title: 5 }, { title: "Edit", extra: 1 }]) expect((await call("POST", `/clients/${ok.businessId}/edit-requests`, body)).status, JSON.stringify(body)).toBe(400);
    expect((await call("POST", `/clients/${ok.businessId}/edit-requests`, { title: "  " })).status).toBe(400);
    expect((await call("POST", "/clients/nope/edit-requests", { title: "Edit" })).status).toBe(404);
  });
});
