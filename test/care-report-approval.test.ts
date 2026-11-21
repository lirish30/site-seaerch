import { env } from "cloudflare:test";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { proposeReportApproval } from "../src/worker/approvals/careReport";
import { approve, reject } from "../src/worker/approvals/decide";
import { getHandler } from "../src/worker/approvals/registry";
import { reportLink, renderReportMail } from "../src/worker/care/reportMail";
import * as reportsDb from "../src/worker/db/careReports";
import { getReport, insertReport, revoke, cancel, setSummary, type CareReport } from "../src/worker/db/careReports";
import { listActivity } from "../src/worker/db/activity";
import { addDoNotContact } from "../src/worker/db/doNotContact";
import { activeHolds, liftHold, placeHold } from "../src/worker/db/holds";
import { addCadence, setProjectStatus } from "../src/worker/db/projects";
import { markSubscription } from "../src/worker/db/subscriptions";
import { saveSettings } from "../src/worker/db/settings";
import { ensureSeedSops } from "../src/worker/db/sops";
import { listTasks } from "../src/worker/db/tasks";
import type { Env } from "../src/worker/env";
import { setMailDeps } from "../src/worker/mail/deps";
import { generateRecurring } from "../src/worker/projects/sweep";
import "../src/worker/queue/kinds";
import { seedClient } from "./fixtures/clients";
import { OWNER_EMAIL, readyToSend } from "./fixtures/documents";
import { tool } from "./fixtures/mcp";
import { resetProjectWork } from "./fixtures/projects";

// The mail goes out at 2026-12-01 09:00 in Los Angeles (readyToSend's clock): the CARE-4 task of 2026-12 is the one that is ticked, and the report is of November.
const NOW = new Date("2026-12-02T14:00:00.000Z");
const CARE = [{ key: "care" as const, monthlyCents: 12_900 }];
const BASE = "https://clients.hellositeline.test";
const e = env as Env;
const SUMMARY = "The site was up almost all month and four updates went in.";
const RECOMMENDATION = "Look at why the shop site went down twice.";
const site = (domain: string, over: Record<string, unknown> = {}) => ({
  domain, monitoredSince: "2026-10-03", uptimePercent: 99.9, coveredDays: 30, incidents: 0, longestOutageMinutes: null,
  updatesApplied: 4, updatesRolledBack: 0, updatesFailed: 0, backups: 2, speedScore: 81, ...over,
});
const FACTS = {
  version: 1, period: "2026-11", label: "November 2026", from: "2026-11-01T08:00:00.000Z", to: "2026-12-01T08:00:00.000Z", clientName: "Ace Plumbing",
  sites: [site("ace.com"), site("shop.ace.com", { incidents: 2, longestOutageMinutes: 12, speedScore: null })],
  edits: { month: "2026-11", allowanceMinutes: 60, usedMinutes: 30, percent: 50, state: "ok", requestsDone: 3 },
  renewals: [{ what: "certificate", domain: "ace.com", on: "2026-12-20" }], generatedAt: NOW.toISOString(),
};

let mail: Awaited<ReturnType<typeof readyToSend>>;
let errors: ReturnType<typeof vi.spyOn>;
beforeEach(async () => {
  errors = vi.spyOn(console, "error").mockImplementation(() => {});
  vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("no network in tests"));
  for (const t of ["site_incidents", "site_checks", "site_uptime_days", "care_reports", "care_page_checks", "care_runs", "care_batches", "care_updates", "helper_jobs"]) await env.DB.prepare(`DELETE FROM ${t}`).run();
  await resetProjectWork();
  for (const t of ["billing_holds", "invoice_nudges", "invoices", "subscriptions", "document_views", "document_signatures", "documents", "deals", "activity", "drafts", "audits", "search_results", "businesses", "suppressions", "do_not_contact", "messages"])
    await env.DB.prepare(`DELETE FROM ${t}`).run();
  await env.DB.prepare(`DELETE FROM approvals WHERE kind = 'care.report'`).run();
  await env.DB.batch([env.DB.prepare(`DELETE FROM sop_template_steps`), env.DB.prepare(`DELETE FROM sop_templates`)]);
  await ensureSeedSops(env.DB);
  mail = await readyToSend();
});
afterEach(() => { vi.restoreAllMocks(); setMailDeps(null); });

/** A client with live Care, the monthly report cadence on its project and its CARE-4 task of December. */
async function careClient(o: { test?: boolean } = {}) {
  const s = await seedClient({ subs: CARE, test: o.test });
  await addCadence(env.DB, s.project!.id, "CARE-4");
  await env.DB.prepare(`UPDATE project_cadences SET created_at = '2026-10-15T17:00:00.000Z' WHERE project_id = ? AND template_key = 'CARE-4'`).bind(s.project!.id).run();
  await generateRecurring(e, NOW);
  return s;
}
let n = 0;
/** A `ready` report for the client, with the words stored. */
async function readyReport(s: { businessId: string }, o: { test?: boolean; source?: "claude" | "plain" | "logan"; summary?: string } = {}): Promise<CareReport> {
  const { report } = await insertReport(env.DB, { businessId: s.businessId, period: "2026-11", token: `tok-care-report-approval-${++n}-${"x".repeat(20)}`, facts: FACTS, test: o.test ?? false, now: "2026-12-02T14:00:00.000Z" });
  expect(await setSummary(env.DB, report.id, ["collecting"], { summary: o.summary ?? SUMMARY, recommendation: RECOMMENDATION, source: o.source ?? "claude", now: "2026-12-02T15:00:00.000Z" })).toBe(true);
  return (await getReport(env.DB, report.id))!;
}
async function proposed(s: { businessId: string }, o: Parameters<typeof readyReport>[1] = {}) {
  const report = await readyReport(s, o);
  const id = await proposeReportApproval(e, report);
  expect(id).not.toBeNull();
  return { report, id: id! };
}
const ask = (over: Partial<Env> = {}) => ({ ...env, ...over }) as Env;
const approvalRow = (id: string) => env.DB.prepare(`SELECT * FROM approvals WHERE id = ?`).bind(id).first<{ status: string; error: string | null; preview: string; kind: string; title: string; record_type: string; record_id: string; drafted_by: string }>();
const lines = async (businessId: string, kind: string) => (await listActivity(env.DB, businessId, 100)).filter((a) => a.kind === kind).map((a) => a.detail ?? "");
/** What the approval said when it refused (the mail itself logs its own "Email sent" note). */
const refusals = async (businessId: string) => (await lines(businessId, "note")).filter((d) => d.startsWith("monthly report not sent"));
const checklist = async (projectId: string) => (await listTasks(env.DB, projectId)).filter((t) => t.cadenceKey === "CARE-4").map((t) => t.checklist.map((c) => c.done));

describe("reportLink and renderReportMail", () => {
  it("links the report page on an https base, never workers.dev, and not at all without one", () => {
    expect(reportLink("https://clients.example.com", "tok")).toBe("https://clients.example.com/m/tok");
    expect(reportLink("https://clients.example.com/", "tok")).toBe("https://clients.example.com/m/tok");
    for (const base of [undefined, "", "http://clients.example.com", "https://app.workers.dev", "not a url"]) expect(reportLink(base, "tok")).toBeNull();
  });

  it("is a fixed template: the greeting, the summary, the link and the sign-off, with no figure of its own", () => {
    const m = renderReportMail({ clientName: "Ace Plumbing", contactName: "Pat Jones", yourName: "Logan Irish", summary: SUMMARY, link: "https://clients.example.com/m/tok", period: "November 2026" });
    expect(m.subject).toBe("Your site's report for November 2026");
    expect(m.body).toBe([
      "Hi Pat,", "Here is the November 2026 Care report for Ace Plumbing.", SUMMARY, "You can read the whole report here:", "https://clients.example.com/m/tok",
      "Reply to this email if you have a question.", "Thanks,\nLogan Irish",
    ].join("\n\n"));
    expect(m.body).not.toMatch(/\d{2,}%|\$\d/);
    // No contact name: a plain greeting. A saved signature follows the body when there is one, so the name is then left off.
    const bare = renderReportMail({ clientName: "Ace", contactName: " ", yourName: "", summary: SUMMARY, link: "https://x.example/m/t", period: "May 2026" });
    expect(bare.body.startsWith("Hi,\n\n")).toBe(true);
    expect(bare.body.endsWith("Thanks,")).toBe(true);
  });
});

describe("proposeReportApproval", () => {
  it("makes one approval for a ready report however often it is asked, and records it on the report", async () => {
    const s = await careClient();
    const report = await readyReport(s);
    const first = await proposeReportApproval(e, report);
    expect(first).toEqual(expect.any(String));
    expect(await proposeReportApproval(e, report)).toBe(first);
    expect(await Promise.all([proposeReportApproval(e, report), proposeReportApproval(e, report)])).toEqual([first, first]);
    expect((await env.DB.prepare(`SELECT COUNT(*) AS n FROM approvals WHERE kind = 'care.report'`).first<{ n: number }>())!.n).toBe(1);
    expect((await getReport(env.DB, report.id))!.approvalId).toBe(first);
    expect(await approvalRow(first!)).toMatchObject({ kind: "care.report", status: "pending", record_type: "business", record_id: s.businessId, drafted_by: "logan" });
    expect(getHandler("care.report")!.parse({ reportId: "r" })).toEqual({ reportId: "r" });
    expect(getHandler("care.report")!.label).toBe("Send monthly report");
  });

  it("records an approval that exists but was never linked, and returns it after a decision too, never a second one", async () => {
    const s = await careClient();
    const report = await readyReport(s);
    const id = (await proposeReportApproval(e, report))!;
    await env.DB.prepare(`UPDATE care_reports SET approval_id = NULL WHERE id = ?`).bind(report.id).run();
    expect(await proposeReportApproval(e, report)).toBe(id);
    expect((await getReport(env.DB, report.id))!.approvalId).toBe(id);
    expect(await reject(env.DB, id, "not this month")).toBe(true);
    expect(await proposeReportApproval(e, report)).toBe(id);
    expect((await env.DB.prepare(`SELECT COUNT(*) AS n FROM approvals WHERE kind = 'care.report'`).first<{ n: number }>())!.n).toBe(1);
  });

  it("returns null for a report that is not ready, and makes nothing", async () => {
    const s = await careClient();
    const { report } = await insertReport(env.DB, { businessId: s.businessId, period: "2026-11", token: "tok-collecting-report-approval-xxxxxxxxxxxxxxxxx", facts: FACTS, test: false, now: NOW.toISOString() });
    expect(await proposeReportApproval(e, report)).toBeNull();
    const ready = await readyReport(await careClient());
    await cancel(env.DB, ready.id);
    expect(await proposeReportApproval(e, (await getReport(env.DB, ready.id))!)).toBeNull();
    expect((await env.DB.prepare(`SELECT COUNT(*) AS n FROM approvals WHERE kind = 'care.report'`).first<{ n: number }>())!.n).toBe(0);
  });

  it("shows Logan what the client gets: who, the subject, the summary, the link, the recommendation and the headline numbers", async () => {
    const s = await careClient();
    const { report, id } = await proposed(s);
    const a = (await approvalRow(id))!;
    expect(a.title).toContain("Ace Plumbing");
    expect(a.title).toContain("November 2026");
    for (const part of ["Pat Jones <pat@ace.test>", "Your site's report for November 2026", SUMMARY, `${BASE}/m/${report.token}`, RECOMMENDATION, "ace.com", "99.9%", "shop.ace.com", "2 incidents", "4 updates applied", "30 of 60 edit minutes", "Nothing is mailed until you approve"]) {
      expect(a.preview, part).toContain(part);
    }
    expect(a.preview).not.toContain("not written by Claude");
  });

  it("says plainly when the summary was written by the code and not by Claude, and who edited it", async () => {
    const plain = await proposed(await careClient(), { source: "plain" });
    expect((await approvalRow(plain.id))!.preview).toMatch(/not written by Claude/i);
    const mine = await proposed(await careClient(), { source: "logan" });
    expect((await approvalRow(mine.id))!.preview).toMatch(/your own words/i);
  });

  it("makes a card for a test report that says nothing goes to the client, and for a client with no usable link or contact", async () => {
    const test = await proposed(await careClient({ test: true }), { test: true });
    expect((await approvalRow(test.id))!.preview).toContain(`${OWNER_EMAIL}`);
    expect((await approvalRow(test.id))!.preview).toMatch(/a test/i);

    const s = await careClient();
    await env.DB.prepare(`DELETE FROM people WHERE business_id = ?`).bind(s.businessId).run();
    const report = await readyReport(s);
    const id = await proposeReportApproval(ask({ CLIENT_LINK_BASE: "https://x.workers.dev" }), report);
    expect(id).not.toBeNull(); // never null for a ready report
    const a = (await approvalRow(id!))!;
    expect(a.preview).toMatch(/CLIENT_LINK_BASE/);
    expect(a.preview).toMatch(/nobody to go to|contact email/i);
    expect(a.preview).not.toContain(report.token);
  });
});

describe("approving a care.report", () => {
  it("mails the summary and the one link, marks the report sent, logs once and ticks 1.2 and 1.3", async () => {
    const s = await careClient();
    const { report, id } = await proposed(s);
    expect(await checklist(s.project!.id)).toEqual([[false, false, false, false, false, false]]);
    expect(await approve(ask(), id)).toEqual({ ok: true });

    expect(mail.sent).toHaveLength(1);
    expect(mail.sent[0]).toMatchObject({ to: "pat@ace.test", subject: "Your site's report for November 2026" });
    const text = mail.sent[0].text;
    expect(text).toContain(SUMMARY);
    expect(text).toContain(`${BASE}/m/${report.token}`);
    expect(text).not.toContain(RECOMMENDATION); // it is on the report page, not in the mail
    expect([...text.matchAll(/https?:\/\/\S+/g)].map((m) => m[0])).toEqual([`${BASE}/m/${report.token}`]);
    for (const leak of [/siteline-backups/i, /\bssh\b/i, /alias/i, /wp-content/i]) expect(text).not.toMatch(leak);
    expect(text.replace(`${BASE}/m/${report.token}`, "")).not.toMatch(/[A-Za-z0-9_-]{30,}/); // no other token, id or file name

    const after = (await getReport(env.DB, report.id))!;
    expect(after.status).toBe("sent");
    expect(after.sentAt).toBe("2026-12-01T17:00:00.000Z");
    expect(await lines(s.businessId, "care_report_sent")).toEqual(["November 2026 report sent to pat@ace.test"]);
    // 1.2 and 1.3 of the CARE-4 task of the month the mail went out in.
    expect(await checklist(s.project!.id)).toEqual([[false, true, true, false, false, false]]);
    expect(await approvalRow(id)).toMatchObject({ status: "approved", error: null });
  });

  it("approving the same approval twice, or running its handler again, sends once and logs once", async () => {
    const s = await careClient();
    const { report, id } = await proposed(s);
    expect(await approve(ask(), id)).toEqual({ ok: true });
    expect(await approve(ask(), id)).toMatchObject({ ok: false, status: 409 });
    const handler = getHandler("care.report")!;
    const row = (await approvalRow(id))!;
    await handler.execute(ask(), { reportId: report.id }, { ...row, id, payload: { reportId: report.id } } as never);
    expect(mail.sent).toHaveLength(1);
    expect(await lines(s.businessId, "care_report_sent")).toHaveLength(1);
    expect(await refusals(s.businessId)).toEqual([]);
  });

  it("a retry after the mail went but before the report was marked sent marks it and mails nothing", async () => {
    const s = await careClient();
    const { report, id } = await proposed(s);
    const spy = vi.spyOn(reportsDb, "markSent").mockRejectedValueOnce(new Error("database is busy"));
    const first = await approve(ask(), id);
    expect(first).toMatchObject({ ok: false, error: "database is busy" });
    spy.mockRestore();
    expect(mail.sent).toHaveLength(1);
    expect((await getReport(env.DB, report.id))!.status).toBe("ready");
    expect(await approvalRow(id)).toMatchObject({ status: "pending", error: "database is busy" });
    expect(await lines(s.businessId, "care_report_sent")).toHaveLength(0);

    expect(await approve(ask(), id)).toEqual({ ok: true });
    expect(mail.sent).toHaveLength(1);
    expect((await getReport(env.DB, report.id))!.status).toBe("sent");
    expect(await lines(s.businessId, "care_report_sent")).toHaveLength(1);
    expect(await checklist(s.project!.id)).toEqual([[false, true, true, false, false, false]]);
  });

  it("a retry across a month boundary keeps the mail's own sent time and ticks the task of the month it went in, not the next month's", async () => {
    const s = await careClient();
    const { report, id } = await proposed(s);
    const spy = vi.spyOn(reportsDb, "markSent").mockRejectedValueOnce(new Error("database is busy"));
    expect(await approve(ask(), id)).toMatchObject({ ok: false });
    spy.mockRestore();
    expect(mail.sent).toHaveLength(1);
    // The task of January exists too; the retry comes in January (Los Angeles), the mail went in December.
    await generateRecurring(e, new Date("2027-01-04T14:00:00.000Z"));
    setMailDeps({ smtp: async () => { throw new Error("must not send"); }, now: () => new Date("2027-01-04T14:00:00.000Z") });
    expect(await approve(ask(), id)).toEqual({ ok: true });
    expect(mail.sent).toHaveLength(1);
    expect((await getReport(env.DB, report.id))!.sentAt).toBe("2026-12-01T17:00:00.000Z");
    const tasks = (await listTasks(env.DB, s.project!.id)).filter((t) => t.cadenceKey === "CARE-4").sort((x, y) => x.periodKey!.localeCompare(y.periodKey!));
    expect(tasks.map((t) => t.periodKey)).toEqual(["2026-12", "2027-01"]);
    expect(tasks.map((t) => t.checklist.map((c) => c.done))).toEqual([[false, true, true, false, false, false], [false, false, false, false, false, false]]);
  });

  it("a revoked, a cancelled and a sent report send nothing and say why on the timeline", async () => {
    const cases: [string, (id: string) => Promise<unknown>, RegExp][] = [
      ["revoked", (id) => revoke(env.DB, id, NOW.toISOString()), /taken back/],
      ["cancelled", (id) => cancel(env.DB, id), /cancelled/],
      ["sent", (id) => reportsDb.markSent(env.DB, id, NOW.toISOString()), /already sent/],
    ];
    for (const [status, change, why] of cases) {
      const s = await careClient();
      const { report, id } = await proposed(s);
      await change(report.id);
      expect(await approve(ask(), id), status).toEqual({ ok: true });
      expect(mail.sent, status).toHaveLength(0);
      expect((await getReport(env.DB, report.id))!.status).toBe(status);
      const notes = await refusals(s.businessId);
      expect(notes, status).toHaveLength(1);
      expect(notes[0]).toMatch(/^monthly report not sent: November 2026/);
      expect(notes[0]).toMatch(why);
      expect(await lines(s.businessId, "care_report_sent")).toHaveLength(0);
      expect(await checklist(s.project!.id)).toEqual([[false, false, false, false, false, false]]);
    }
  });

  it("a client now on billing hold sends nothing and the approval stays pending, so it can be approved again once the hold is lifted", async () => {
    const s = await seedClient({ subs: CARE, invoice: { cents: 5000 } });
    await addCadence(env.DB, s.project!.id, "CARE-4");
    await generateRecurring(e, NOW);
    const { report, id } = await proposed(s);
    expect(await placeHold(env.DB, { businessId: s.businessId, invoiceId: s.invoice!.id, now: NOW.toISOString() })).toBe(true);
    const held = await approve(ask(), id);
    expect(held).toMatchObject({ ok: false, status: 502 });
    expect((held as { error: string }).error).toMatch(/billing hold/);
    expect(mail.sent).toHaveLength(0);
    expect(await approvalRow(id)).toMatchObject({ status: "pending" });
    expect((await getReport(env.DB, report.id))!.status).toBe("ready");
    expect(await refusals(s.businessId)).toEqual([]);

    const [hold] = await activeHolds(env.DB, s.businessId);
    expect(await liftHold(env.DB, hold.id, "manual", NOW.toISOString())).toBe(true);
    expect(await approve(ask(), id)).toEqual({ ok: true });
    expect(mail.sent).toHaveLength(1);
    expect((await getReport(env.DB, report.id))!.status).toBe("sent");
  });

  it("a client whose Care project ended, or whose Care subscription is no longer live, gets nothing", async () => {
    const ended = await careClient();
    const e1 = await proposed(ended);
    await setProjectStatus(env.DB, ended.project!.id, "cancelled");
    expect(await approve(ask(), e1.id)).toEqual({ ok: true });
    expect((await refusals(ended.businessId))[0]).toMatch(/no live Care project/);

    const lapsed = await careClient();
    const e2 = await proposed(lapsed);
    await markSubscription(env.DB, lapsed.subIds[0], { status: "cancelled" });
    expect(await approve(ask(), e2.id)).toEqual({ ok: true });
    expect((await refusals(lapsed.businessId))[0]).toMatch(/Care subscription/);

    expect(mail.sent).toHaveLength(0);
    for (const x of [e1, e2]) expect((await getReport(env.DB, x.report.id))!.status).toBe("ready");
  });

  it("an unusable link base sends nothing and the approval stays pending, so it can be approved again once the base is fixed", async () => {
    for (const [i, base] of [undefined, "https://app.workers.dev", "http://clients.example.com", ""].entries()) {
      const s = await careClient();
      const { report, id } = await proposed(s);
      const r = await approve(ask({ CLIENT_LINK_BASE: base }), id);
      expect(r, String(base)).toMatchObject({ ok: false, status: 502 });
      expect((r as { error: string }).error).toMatch(/CLIENT_LINK_BASE/);
      expect(mail.sent).toHaveLength(i); // only the earlier rounds' mails, none from this one
      expect(await approvalRow(id)).toMatchObject({ status: "pending" });
      expect((await getReport(env.DB, report.id))!.status).toBe("ready");
      expect(await refusals(s.businessId)).toEqual([]);
      expect(await approve(ask(), id)).toEqual({ ok: true }); // the base is fixed
      expect((await getReport(env.DB, report.id))!.status).toBe("sent");
    }
    expect(mail.sent).toHaveLength(4);
  });

  it("a mailbox that cannot send leaves the approval pending and the report ready, and approving again later sends it", async () => {
    const s = await careClient();
    const { report, id } = await proposed(s);
    await readyToSend({ mailbox: false });
    const off = await approve(ask(), id);
    expect(off).toMatchObject({ ok: false, status: 502 });
    expect((off as { error: string }).error).toMatch(/main mailbox cannot send/);
    expect(await approvalRow(id)).toMatchObject({ status: "pending" });
    expect((await getReport(env.DB, report.id))!.status).toBe("ready");

    mail = await readyToSend();
    mail.failures.push(new Error("smtp down"));
    expect(await approve(ask(), id)).toMatchObject({ ok: false });
    expect(mail.sent).toHaveLength(0);
    expect((await getReport(env.DB, report.id))!.status).toBe("ready");
    expect(await approve(ask(), id)).toEqual({ ok: true });
    expect(mail.sent).toHaveLength(1);
    expect((await getReport(env.DB, report.id))!.status).toBe("sent");
  });

  it("a contact with no email, or a do-not-contact hit, throws so the approval stays pending", async () => {
    const none = await careClient();
    const a = await proposed(none);
    await env.DB.prepare(`DELETE FROM people WHERE business_id = ?`).bind(none.businessId).run();
    const r1 = await approve(ask(), a.id);
    expect(r1).toMatchObject({ ok: false, status: 502 });
    expect((r1 as { error: string }).error).toMatch(/nobody to go to/);

    const listed = await careClient();
    const b = await proposed(listed);
    await addDoNotContact(env.DB, { kind: "email", value: "pat@ace.test", reason: "opt_out" });
    const r2 = await approve(ask(), b.id);
    expect(r2).toMatchObject({ ok: false, status: 502 });
    expect((r2 as { error: string }).error).toMatch(/^Blocked: .*do-not-contact/);
    expect(mail.sent).toHaveLength(0);
    for (const x of [a, b]) {
      expect(await approvalRow(x.id)).toMatchObject({ status: "pending" });
      expect((await getReport(env.DB, x.report.id))!.status).toBe("ready");
    }
  });

  it("an existing client (a won lead) is not blocked for being a client", async () => {
    const s = await careClient();
    const { id } = await proposed(s);
    expect((await env.DB.prepare(`SELECT lead_status FROM businesses WHERE id = ?`).bind(s.businessId).first<{ lead_status: string }>())!.lead_status).toBe("won");
    expect(await approve(ask(), id)).toEqual({ ok: true });
    expect(mail.sent).toHaveLength(1);
  });

  it("a test report mails the owner only, with [Test] on the subject, and never the contact", async () => {
    const s = await careClient({ test: true });
    const { report, id } = await proposed(s, { test: true });
    expect(report.test).toBe(true);
    expect(await approve(ask(), id)).toEqual({ ok: true });
    expect(mail.sent).toHaveLength(1);
    expect(mail.sent[0]).toMatchObject({ to: OWNER_EMAIL, subject: "[Test] Your site's report for November 2026" });
    expect(JSON.stringify(mail.sent[0])).not.toContain("pat@ace.test");
    expect((await getReport(env.DB, report.id))!.status).toBe("sent");
    expect(await lines(s.businessId, "care_report_sent")).toEqual([`November 2026 report sent to ${OWNER_EMAIL} (test)`]);
  });

  it("a test report with no owner email set throws and sends nothing", async () => {
    const s = await careClient({ test: true });
    const { id } = await proposed(s, { test: true });
    await saveSettings(env.DB, { contact_email: "" });
    const r = await approve(ask(), id);
    expect(r).toMatchObject({ ok: false, status: 502 });
    expect((r as { error: string }).error).toMatch(/contact email in Settings/);
    expect(mail.sent).toHaveLength(0);
  });

  it("a report that is gone throws", async () => {
    const s = await careClient();
    const { report, id } = await proposed(s);
    await env.DB.prepare(`DELETE FROM care_reports WHERE id = ?`).bind(report.id).run();
    expect(await approve(ask(), id)).toMatchObject({ ok: false, error: "This report was not found." });
  });
});

describe("the agent", () => {
  it("cannot propose care.report: only the app does, and nothing is written", async () => {
    const count = async () => (await env.DB.prepare(`SELECT COUNT(*) AS n FROM approvals WHERE kind = 'care.report'`).first<{ n: number }>())!.n;
    const before = await count();
    const r = await tool("propose_approval", { kind: "care.report", title: "Send the report", preview: "x", payload: { reportId: "r1" } });
    expect(r.isError).toBe(true);
    expect(r.text).toMatch(/care\.report/);
    expect(r.text).toMatch(/app proposes it itself/);
    expect(await count()).toBe(before);
    expect((await env.DB.prepare(`SELECT COUNT(*) AS n FROM agent_actions WHERE tool = 'propose_approval' AND summary LIKE '%refused care.report%'`).first<{ n: number }>())!.n).toBeGreaterThan(0);
  });
});
