import { env } from "cloudflare:test";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { proposeSeoReportApproval, refreshSeoReportApproval } from "../src/worker/approvals/seoReport";
import { approve, reject } from "../src/worker/approvals/decide";
import { getHandler } from "../src/worker/approvals/registry";
import { listActivity } from "../src/worker/db/activity";
import { addDoNotContact } from "../src/worker/db/doNotContact";
import { activeHolds, liftHold, placeHold } from "../src/worker/db/holds";
import { addCadence, setProjectStatus } from "../src/worker/db/projects";
import { saveSettings } from "../src/worker/db/settings";
import { ensureSeedSops } from "../src/worker/db/sops";
import * as seoDb from "../src/worker/db/seoReports";
import { cancelSeoReport, editSeoSummary, getSeoReport, insertSeoReport, revokeSeoReport, setSeoSummary, type SeoReport } from "../src/worker/db/seoReports";
import { listTasks } from "../src/worker/db/tasks";
import type { Env } from "../src/worker/env";
import { setMailDeps } from "../src/worker/mail/deps";
import { generateRecurring } from "../src/worker/projects/sweep";
import "../src/worker/queue/kinds";
import { renderSeoReportMail, seoReportLink } from "../src/worker/seo/reportMail";
import { seedClient } from "./fixtures/clients";
import { OWNER_EMAIL, readyToSend } from "./fixtures/documents";
import { tool } from "./fixtures/mcp";
import { resetProjectWork } from "./fixtures/projects";

// The mail goes out at 2026-12-01 09:00 in Los Angeles (readyToSend's clock): the SEO-1 task of 2026-12 is the one that is ticked, and the report is of November.
const NOW = new Date("2026-12-02T14:00:00.000Z");
const PLAN = [{ key: "local_seo" as const, monthlyCents: 60_000 }];
const BASE = "https://clients.hellositeline.test";
const e = env as Env;
const SUMMARY = "In our check the business showed in the top three at two of nine points for drain cleaning, and the profile gained three reviews.";
const RECOMMENDATION = "Ask recent customers to leave a review.";
const PRIORITIES = ["Answer the one low review", "Fix the address on the website", "Publish the water heater page"];
const nine = (top: number) => Array.from({ length: 9 }, (_, i) => ({ pos: i < top ? 2 : 9, ok: true }));
const FACTS = {
  version: 1, period: "2026-11", label: "November 2026", clientName: "Ace Plumbing", rankAsOf: "2026-12-01", previousRankAsOf: "2026-11-01",
  terms: [
    { term: "drain cleaning", town: "Tigard", points: nine(2), measured: 9, visible: 2, previousVisible: 5 },
    { term: "water heater repair", town: null, points: [...nine(3).slice(0, 6), { pos: null, ok: false }, { pos: null, ok: false }, { pos: null, ok: false }], measured: 6, visible: null, previousVisible: null },
  ],
  gbp: { rating: 4.7, reviewCount: 43, reviewsGained: 3, ratingChange: 0.2 }, reviews: { seen: 3, posted: 2, needsYou: 1 },
  content: { published: [{ kind: "page", title: "Drain cleaning in Tigard" }], drafted: 1, planned: 1 }, citations: { listed: 6, needsFix: 2, todo: 4 },
  nap: { phone: "match", address: "mismatch", name: "missing" }, generatedAt: NOW.toISOString(),
};

let mail: Awaited<ReturnType<typeof readyToSend>>;
let errors: ReturnType<typeof vi.spyOn>;
beforeEach(async () => {
  errors = vi.spyOn(console, "error").mockImplementation(() => {});
  vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("no network in tests"));
  await resetProjectWork();
  for (const t of ["seo_reports", "seo_content", "seo_rank_checks", "seo_keywords", "seo_profiles", "billing_holds", "invoice_nudges", "invoices", "subscriptions", "document_views", "document_signatures", "documents", "deals", "activity", "drafts", "audits", "search_results", "businesses", "suppressions", "do_not_contact", "messages"])
    await env.DB.prepare(`DELETE FROM ${t}`).run();
  await env.DB.prepare(`DELETE FROM approvals WHERE kind = 'seo.report'`).run();
  await env.DB.batch([env.DB.prepare(`DELETE FROM sop_template_steps`), env.DB.prepare(`DELETE FROM sop_templates`)]);
  await ensureSeedSops(env.DB);
  mail = await readyToSend();
});
afterEach(() => { vi.restoreAllMocks(); setMailDeps(null); });

/** A client with a live Local SEO project (the monthly SEO-1 cadence on it) and its SEO-1 task of December. */
async function seoClient(o: { test?: boolean } = {}) {
  const s = await seedClient({ subs: PLAN, test: o.test });
  await addCadence(env.DB, s.project!.id, "SEO-1");
  await env.DB.prepare(`UPDATE project_cadences SET created_at = '2026-10-15T17:00:00.000Z' WHERE project_id = ? AND template_key = 'SEO-1'`).bind(s.project!.id).run();
  await generateRecurring(e, NOW);
  return s;
}
let n = 0;
/** A `ready` report for the client, with the words stored. */
async function readyReport(s: { businessId: string }, o: { test?: boolean; source?: "claude" | "plain" | "logan"; summary?: string; facts?: unknown; priorities?: string[] } = {}): Promise<SeoReport> {
  const { report } = await insertSeoReport(env.DB, { businessId: s.businessId, period: "2026-11", token: `tok-seo-report-approval-${++n}-${"x".repeat(20)}`, facts: o.facts ?? FACTS, test: o.test ?? false, now: "2026-12-02T14:00:00.000Z" });
  expect(await setSeoSummary(env.DB, report.id, ["collecting"], { summary: o.summary ?? SUMMARY, recommendation: RECOMMENDATION, priorities: o.priorities ?? PRIORITIES, source: o.source ?? "claude", now: "2026-12-02T15:00:00.000Z" })).toBe(true);
  return (await getSeoReport(env.DB, report.id))!;
}
async function proposed(s: { businessId: string }, o: Parameters<typeof readyReport>[1] = {}) {
  const report = await readyReport(s, o);
  const id = await proposeSeoReportApproval(e, report);
  expect(id).toEqual(expect.any(String));
  return { report, id };
}
const ask = (over: Partial<Env> = {}) => ({ ...env, ...over }) as Env;
const approvalRow = (id: string) => env.DB.prepare(`SELECT * FROM approvals WHERE id = ?`).bind(id).first<{ status: string; error: string | null; preview: string; kind: string; title: string; record_type: string; record_id: string; drafted_by: string }>();
const lines = async (businessId: string, kind: string) => (await listActivity(env.DB, businessId, 100)).filter((a) => a.kind === kind).map((a) => a.detail ?? "");
/** What the approval said when it refused (the mail itself logs its own "Email sent" note). */
const refusals = async (businessId: string) => (await lines(businessId, "note")).filter((d) => d.startsWith("Local SEO report not sent"));
const checklist = async (projectId: string) => (await listTasks(env.DB, projectId)).filter((t) => t.cadenceKey === "SEO-1").map((t) => t.checklist.map((c) => c.done));
const count = async () => (await env.DB.prepare(`SELECT COUNT(*) AS n FROM approvals WHERE kind = 'seo.report'`).first<{ n: number }>())!.n;
const NOT_TICKED = [[false, false, false, false, false, false, false]];
const TICKED = [[false, false, false, false, false, false, true]];

describe("seoReportLink and renderSeoReportMail", () => {
  it("links the report page on an https base of its own, at /l/, never workers.dev, never the cold-email host, and not at all without one", () => {
    const withBase = (CLIENT_LINK_BASE: string | undefined, OUTREACH_LINK_BASE?: string) => ({ CLIENT_LINK_BASE, OUTREACH_LINK_BASE });
    expect(seoReportLink(withBase("https://clients.example.com"), "tok")).toBe("https://clients.example.com/l/tok");
    expect(seoReportLink(withBase("https://clients.example.com/"), "tok")).toBe("https://clients.example.com/l/tok");
    for (const base of [undefined, "", "http://clients.example.com", "https://app.workers.dev", "not a url"]) expect(seoReportLink(withBase(base), "tok"), String(base)).toBeNull();
    expect(seoReportLink(withBase("https://mail.example.com", "https://mail.example.com"), "tok")).toBeNull();
  });

  it("is a fixed template: the greeting, the summary, the link and the sign-off, with no figure of its own", () => {
    const m = renderSeoReportMail({ clientName: "Ace Plumbing", contactName: "Pat Jones", yourName: "Logan Irish", summary: SUMMARY, link: "https://clients.example.com/l/tok", period: "November 2026" });
    expect(m.subject).toBe("Your local search report for November 2026");
    expect(m.body).toBe([
      "Hi Pat,", "Here is the November 2026 Local SEO report for Ace Plumbing.", SUMMARY, "You can read the whole report here:", "https://clients.example.com/l/tok",
      "Reply to this email if you have a question.", "Thanks,\nLogan Irish",
    ].join("\n\n"));
    expect(m.body.replace("November 2026", "")).not.toMatch(/\d{2,}%|\$\d/);
    const bare = renderSeoReportMail({ clientName: "Ace", contactName: " ", yourName: "", summary: SUMMARY, link: "https://x.example/l/t", period: "May 2026" });
    expect(bare.body.startsWith("Hi,\n\n")).toBe(true);
    expect(bare.body.endsWith("Thanks,")).toBe(true);
  });
});

describe("proposeSeoReportApproval", () => {
  it("makes one approval for a ready report however often it is asked, and records it on the report", async () => {
    const s = await seoClient();
    const report = await readyReport(s);
    const first = await proposeSeoReportApproval(e, report);
    expect(first).toEqual(expect.any(String));
    expect(await proposeSeoReportApproval(e, report)).toBe(first);
    expect(await Promise.all([proposeSeoReportApproval(e, report), proposeSeoReportApproval(e, report)])).toEqual([first, first]);
    expect(await count()).toBe(1);
    expect((await getSeoReport(env.DB, report.id))!.approvalId).toBe(first);
    expect(await approvalRow(first)).toMatchObject({ kind: "seo.report", status: "pending", record_type: "business", record_id: s.businessId, drafted_by: "job" });
    expect(getHandler("seo.report")!.parse({ reportId: "r" })).toEqual({ reportId: "r" });
    expect(getHandler("seo.report")!.label).toBe("Send monthly Local SEO report");
  });

  it("records an approval that exists but was never linked, and returns it after a decision too, never a second one", async () => {
    const s = await seoClient();
    const report = await readyReport(s);
    const id = await proposeSeoReportApproval(e, report);
    await env.DB.prepare(`UPDATE seo_reports SET approval_id = NULL WHERE id = ?`).bind(report.id).run();
    expect(await proposeSeoReportApproval(e, report)).toBe(id);
    expect((await getSeoReport(env.DB, report.id))!.approvalId).toBe(id);
    expect(await reject(env.DB, id, "not this month")).toBe(true);
    expect(await proposeSeoReportApproval(e, report)).toBe(id);
    expect(await count()).toBe(1);
  });

  it("makes nothing for a report that is not ready, and says so", async () => {
    const s = await seoClient();
    const { report } = await insertSeoReport(env.DB, { businessId: s.businessId, period: "2026-11", token: "tok-collecting-seo-report-approval-xxxxxxxxxxxxx", facts: FACTS, test: false, now: NOW.toISOString() });
    await expect(proposeSeoReportApproval(e, report)).rejects.toThrow(/not ready/);
    const ready = await readyReport(await seoClient());
    await cancelSeoReport(env.DB, ready.id);
    await expect(proposeSeoReportApproval(e, (await getSeoReport(env.DB, ready.id))!)).rejects.toThrow(/not ready/);
    expect(await count()).toBe(0);
  });

  it("shows Logan what the client gets: who, the subject, the mail as it will read, the three priorities and the headline numbers", async () => {
    const s = await seoClient();
    const { report, id } = await proposed(s);
    const a = (await approvalRow(id))!;
    expect(a.title).toContain("Ace Plumbing");
    expect(a.title).toContain("November 2026");
    for (const part of [
      "To: Pat Jones <pat@ace.test>", "Subject: Your local search report for November 2026", "Hi Pat,", SUMMARY, `${BASE}/l/${report.token}`, "Thanks,",
      "Ask recent customers to leave a review.", ...PRIORITIES.map((p, i) => `${i + 1}. ${p}`),
      "in our check on December 1", "drain cleaning in Tigard", "2 of 9", "water heater repair", "not enough", "4.7 out of 5", "43 reviews", "gained 3", "2 replies", "Drain cleaning in Tigard", "6 listed", "Nothing is mailed until you approve",
    ]) expect(a.preview, part).toContain(part);
    expect(a.preview).not.toContain("not written by Claude");
  });

  it("shows no gain on the card of a first report (nothing to compare), and still shows it with a previous check", async () => {
    const first = await proposed(await seoClient(), { facts: { ...FACTS, previousRankAsOf: null, terms: FACTS.terms.map((t) => ({ ...t, previousVisible: null })), gbp: { ...FACTS.gbp, reviewsGained: null } } });
    expect((await approvalRow(first.id))!.preview).toContain("the first check, nothing earlier to compare with");
    expect((await approvalRow(first.id))!.preview).not.toMatch(/gained 3|since the previous check/);
    const second = await proposed(await seoClient());
    expect((await approvalRow(second.id))!.preview).toContain("gained 3 reviews since the previous check");
  });

  it("says plainly when the summary was written by the code and not by Claude, and who edited it", async () => {
    const plain = await proposed(await seoClient(), { source: "plain", priorities: [] });
    expect((await approvalRow(plain.id))!.preview).toMatch(/not written by Claude/i);
    expect((await approvalRow(plain.id))!.preview).toMatch(/no priorities/i);
    const mine = await proposed(await seoClient(), { source: "logan" });
    expect((await approvalRow(mine.id))!.preview).toMatch(/your own words/i);
  });

  it("says no check was available for a report with no rank date, and never shows a missing number as zero", async () => {
    const facts = { ...FACTS, rankAsOf: null, previousRankAsOf: null, terms: [], gbp: { rating: null, reviewCount: null, reviewsGained: null, ratingChange: null }, citations: null };
    const { id } = await proposed(await seoClient(), { facts });
    const p = (await approvalRow(id))!.preview;
    expect(p).toMatch(/no rank check/i);
    expect(p).toMatch(/not measured/i);
    expect(p).not.toMatch(/\b0 reviews\b|0 out of 5/);
  });

  it("makes a card for a test report that says nothing goes to the client, and for a client with no usable link or contact", async () => {
    const test = await proposed(await seoClient({ test: true }), { test: true });
    expect((await approvalRow(test.id))!.preview).toContain(OWNER_EMAIL);
    expect((await approvalRow(test.id))!.preview).toMatch(/a test/i);

    const s = await seoClient();
    await env.DB.prepare(`DELETE FROM people WHERE business_id = ?`).bind(s.businessId).run();
    const report = await readyReport(s);
    const id = await proposeSeoReportApproval(ask({ CLIENT_LINK_BASE: "https://x.workers.dev" }), report);
    const a = (await approvalRow(id))!;
    expect(a.preview).toMatch(/CLIENT_LINK_BASE/);
    expect(a.preview).toMatch(/nobody yet|contact email/i);
    expect(a.preview).not.toContain(report.token);
  });
});

describe("refreshSeoReportApproval", () => {
  it("rewrites the pending card from the words as they are now, and leaves a decided card or a report with no card alone", async () => {
    const s = await seoClient();
    const { report, id } = await proposed(s);
    expect(await editSeoSummary(env.DB, report.id, { summary: "My own words for Ace.", recommendation: "Do one thing.", priorities: ["First thing", "Second thing", "Third thing"] })).toBe(true);
    expect(await refreshSeoReportApproval(e, (await getSeoReport(env.DB, report.id))!)).toBe(true);
    const a = (await approvalRow(id))!;
    expect(a.preview).toContain("My own words for Ace.");
    expect(a.preview).toContain("1. First thing");
    expect(a.preview).toMatch(/your own words/i);
    expect(a.preview).not.toContain(SUMMARY);

    expect(await reject(env.DB, id, "no")).toBe(true);
    await editSeoSummary(env.DB, report.id, { summary: "Words after the decision.", recommendation: "More." });
    expect(await refreshSeoReportApproval(e, (await getSeoReport(env.DB, report.id))!)).toBe(false);
    expect((await approvalRow(id))!.preview).not.toContain("Words after the decision.");

    const bare = await readyReport(await seoClient());
    expect(await refreshSeoReportApproval(e, bare)).toBe(false);
  });
});

describe("approving a seo.report", () => {
  it("mails the summary and the one link, marks the report sent, logs once and ticks 1.7", async () => {
    const s = await seoClient();
    const { report, id } = await proposed(s);
    expect(await checklist(s.project!.id)).toEqual(NOT_TICKED);
    expect(await approve(ask(), id)).toEqual({ ok: true });

    expect(mail.sent).toHaveLength(1);
    expect(mail.sent[0]).toMatchObject({ to: "pat@ace.test", subject: "Your local search report for November 2026" });
    const text = mail.sent[0].text;
    expect(text).toContain(SUMMARY);
    expect(text).toContain(`${BASE}/l/${report.token}`);
    // The recommendation, the priorities, the search terms, the content titles and every figure are on the page, not in the mail.
    for (const left of [RECOMMENDATION, ...PRIORITIES, "water heater repair", "Drain cleaning in Tigard", "Tigard", "4.7", "43 reviews"]) expect(text, left).not.toContain(left);
    expect([...text.matchAll(/https?:\/\/\S+/g)].map((m) => m[0])).toEqual([`${BASE}/l/${report.token}`]);
    for (const leak of [/siteline-backups/i, /\bssh\b/i, /alias/i, /place/i, /vault/i]) expect(text).not.toMatch(leak);
    expect(text.replace(`${BASE}/l/${report.token}`, "")).not.toMatch(/[A-Za-z0-9_-]{30,}/);

    const after = (await getSeoReport(env.DB, report.id))!;
    expect(after.status).toBe("sent");
    expect(after.sentAt).toBe("2026-12-01T17:00:00.000Z");
    expect(await lines(s.businessId, "seo_report_sent")).toEqual(["November 2026 Local SEO report sent to pat@ace.test"]);
    expect(await checklist(s.project!.id)).toEqual(TICKED);
    expect(await approvalRow(id)).toMatchObject({ status: "approved", error: null });
  });

  it("approving the same approval twice, or running its handler again, sends once and logs once", async () => {
    const s = await seoClient();
    const { report, id } = await proposed(s);
    expect(await approve(ask(), id)).toEqual({ ok: true });
    expect(await approve(ask(), id)).toMatchObject({ ok: false, status: 409 });
    const row = (await approvalRow(id))!;
    await getHandler("seo.report")!.execute(ask(), { reportId: report.id }, { ...row, id, payload: { reportId: report.id } } as never);
    expect(mail.sent).toHaveLength(1);
    expect(await lines(s.businessId, "seo_report_sent")).toHaveLength(1);
    expect(await refusals(s.businessId)).toEqual([]);
  });

  it("a retry after the mail went but before the report was marked sent marks it and mails nothing", async () => {
    const s = await seoClient();
    const { report, id } = await proposed(s);
    const spy = vi.spyOn(seoDb, "markSeoSent").mockRejectedValueOnce(new Error("database is busy"));
    expect(await approve(ask(), id)).toMatchObject({ ok: false, error: "database is busy" });
    spy.mockRestore();
    expect(mail.sent).toHaveLength(1);
    expect((await getSeoReport(env.DB, report.id))!.status).toBe("ready");
    expect(await approvalRow(id)).toMatchObject({ status: "pending", error: "database is busy" });
    expect(await lines(s.businessId, "seo_report_sent")).toHaveLength(0);

    expect(await approve(ask(), id)).toEqual({ ok: true });
    expect(mail.sent).toHaveLength(1);
    expect((await getSeoReport(env.DB, report.id))!.status).toBe("sent");
    expect(await lines(s.businessId, "seo_report_sent")).toHaveLength(1);
    expect(await checklist(s.project!.id)).toEqual(TICKED);
  });

  it("a retry across a month boundary keeps the mail's own sent time and ticks the task of the month it went in", async () => {
    const s = await seoClient();
    const { report, id } = await proposed(s);
    const spy = vi.spyOn(seoDb, "markSeoSent").mockRejectedValueOnce(new Error("database is busy"));
    expect(await approve(ask(), id)).toMatchObject({ ok: false });
    spy.mockRestore();
    await generateRecurring(e, new Date("2027-01-04T14:00:00.000Z"));
    setMailDeps({ smtp: async () => { throw new Error("must not send"); }, now: () => new Date("2027-01-04T14:00:00.000Z") });
    expect(await approve(ask(), id)).toEqual({ ok: true });
    expect(mail.sent).toHaveLength(1);
    expect((await getSeoReport(env.DB, report.id))!.sentAt).toBe("2026-12-01T17:00:00.000Z");
    const tasks = (await listTasks(env.DB, s.project!.id)).filter((t) => t.cadenceKey === "SEO-1").sort((x, y) => x.periodKey!.localeCompare(y.periodKey!));
    expect(tasks.map((t) => t.periodKey)).toEqual(["2026-12", "2027-01"]);
    expect(tasks.map((t) => t.checklist.map((c) => c.done))).toEqual([TICKED[0], NOT_TICKED[0]]);
  });

  it("a revoked, a cancelled and a sent report send nothing and say why on the timeline", async () => {
    const cases: [string, (id: string) => Promise<unknown>, RegExp][] = [
      ["revoked", (id) => revokeSeoReport(env.DB, id, NOW.toISOString()), /taken back/],
      ["cancelled", (id) => cancelSeoReport(env.DB, id), /cancelled/],
      ["sent", (id) => seoDb.markSeoSent(env.DB, id, NOW.toISOString()), /already sent/],
    ];
    for (const [status, change, why] of cases) {
      const s = await seoClient();
      const { report, id } = await proposed(s);
      await change(report.id);
      expect(await approve(ask(), id), status).toEqual({ ok: true });
      expect(mail.sent, status).toHaveLength(0);
      expect((await getSeoReport(env.DB, report.id))!.status).toBe(status);
      const notes = await refusals(s.businessId);
      expect(notes, status).toHaveLength(1);
      expect(notes[0]).toMatch(/^Local SEO report not sent: November 2026/);
      expect(notes[0]).toMatch(why);
      expect(await lines(s.businessId, "seo_report_sent")).toHaveLength(0);
      expect(await checklist(s.project!.id)).toEqual(NOT_TICKED);
    }
  });

  it("a client whose Local SEO project ended gets nothing, and the timeline says why", async () => {
    const ended = await seoClient();
    const x = await proposed(ended);
    await setProjectStatus(env.DB, ended.project!.id, "cancelled");
    expect(await approve(ask(), x.id)).toEqual({ ok: true });
    expect((await refusals(ended.businessId))[0]).toMatch(/no live Local SEO project/);
    expect(mail.sent).toHaveLength(0);
    expect((await getSeoReport(env.DB, x.report.id))!.status).toBe("ready");

    // A project that is live but never carried the SEO-1 cadence is not a Local SEO project either.
    const other = await seedClient({ subs: PLAN });
    const y = await proposed(other);
    expect(await approve(ask(), y.id)).toEqual({ ok: true });
    expect((await refusals(other.businessId))[0]).toMatch(/no live Local SEO project/);
    expect(mail.sent).toHaveLength(0);
  });

  it("a client now on billing hold sends nothing and the approval stays pending, so it can be approved again once the hold is lifted", async () => {
    const s = await seedClient({ subs: PLAN, invoice: { cents: 5000 } });
    await addCadence(env.DB, s.project!.id, "SEO-1");
    await generateRecurring(e, NOW);
    const { report, id } = await proposed(s);
    expect(await placeHold(env.DB, { businessId: s.businessId, invoiceId: s.invoice!.id, now: NOW.toISOString() })).toBe(true);
    const held = await approve(ask(), id);
    expect(held).toMatchObject({ ok: false, status: 502 });
    expect((held as { error: string }).error).toMatch(/billing hold/);
    expect(mail.sent).toHaveLength(0);
    expect(await approvalRow(id)).toMatchObject({ status: "pending" });
    expect((await getSeoReport(env.DB, report.id))!.status).toBe("ready");
    expect(await refusals(s.businessId)).toEqual([]);

    const [hold] = await activeHolds(env.DB, s.businessId);
    expect(await liftHold(env.DB, hold.id, "manual", NOW.toISOString())).toBe(true);
    expect(await approve(ask(), id)).toEqual({ ok: true });
    expect(mail.sent).toHaveLength(1);
    expect((await getSeoReport(env.DB, report.id))!.status).toBe("sent");
  });

  it("an unusable link base sends nothing and the approval stays pending, so it can be approved again once the base is fixed", async () => {
    for (const [i, base] of [undefined, "https://app.workers.dev", "http://clients.example.com", ""].entries()) {
      const s = await seoClient();
      const { report, id } = await proposed(s);
      const r = await approve(ask({ CLIENT_LINK_BASE: base }), id);
      expect(r, String(base)).toMatchObject({ ok: false, status: 502 });
      expect((r as { error: string }).error).toMatch(/CLIENT_LINK_BASE/);
      expect(mail.sent).toHaveLength(i);
      expect(await approvalRow(id)).toMatchObject({ status: "pending" });
      expect((await getSeoReport(env.DB, report.id))!.status).toBe("ready");
      expect(await refusals(s.businessId)).toEqual([]);
      expect(await approve(ask(), id)).toEqual({ ok: true });
      expect((await getSeoReport(env.DB, report.id))!.status).toBe("sent");
    }
    expect(mail.sent).toHaveLength(4);
  });

  it("a mailbox that cannot send leaves the approval pending and the report ready, and approving again later sends it", async () => {
    const s = await seoClient();
    const { report, id } = await proposed(s);
    await readyToSend({ mailbox: false });
    const off = await approve(ask(), id);
    expect(off).toMatchObject({ ok: false, status: 502 });
    expect((off as { error: string }).error).toMatch(/main mailbox cannot send/);
    expect(await approvalRow(id)).toMatchObject({ status: "pending" });
    expect((await getSeoReport(env.DB, report.id))!.status).toBe("ready");

    mail = await readyToSend();
    mail.failures.push(new Error("smtp down"));
    expect(await approve(ask(), id)).toMatchObject({ ok: false });
    expect(mail.sent).toHaveLength(0);
    expect((await getSeoReport(env.DB, report.id))!.status).toBe("ready");
    expect(await approve(ask(), id)).toEqual({ ok: true });
    expect(mail.sent).toHaveLength(1);
    expect((await getSeoReport(env.DB, report.id))!.status).toBe("sent");
  });

  it("a contact with no email, or a do-not-contact hit, throws so the approval stays pending", async () => {
    const none = await seoClient();
    const a = await proposed(none);
    await env.DB.prepare(`DELETE FROM people WHERE business_id = ?`).bind(none.businessId).run();
    const r1 = await approve(ask(), a.id);
    expect(r1).toMatchObject({ ok: false, status: 502 });
    expect((r1 as { error: string }).error).toMatch(/nobody to go to/);

    const listed = await seoClient();
    const b = await proposed(listed);
    await addDoNotContact(env.DB, { kind: "email", value: "pat@ace.test", reason: "opt_out" });
    const r2 = await approve(ask(), b.id);
    expect(r2).toMatchObject({ ok: false, status: 502 });
    expect((r2 as { error: string }).error).toMatch(/^Blocked: .*do-not-contact/);
    expect(mail.sent).toHaveLength(0);
    for (const x of [a, b]) {
      expect(await approvalRow(x.id)).toMatchObject({ status: "pending" });
      expect((await getSeoReport(env.DB, x.report.id))!.status).toBe("ready");
    }
  });

  it("an existing client (a won lead) is not blocked for being a client", async () => {
    const { id } = await proposed(await seoClient());
    expect(await approve(ask(), id)).toEqual({ ok: true });
    expect(mail.sent).toHaveLength(1);
  });

  it("a test report mails the owner only, with [Test] on the subject, and never the contact", async () => {
    const s = await seoClient({ test: true });
    const { report, id } = await proposed(s, { test: true });
    expect(await approve(ask(), id)).toEqual({ ok: true });
    expect(mail.sent).toHaveLength(1);
    expect(mail.sent[0]).toMatchObject({ to: OWNER_EMAIL, subject: "[Test] Your local search report for November 2026" });
    expect(JSON.stringify(mail.sent[0])).not.toContain("pat@ace.test");
    expect((await getSeoReport(env.DB, report.id))!.status).toBe("sent");
    expect(await lines(s.businessId, "seo_report_sent")).toEqual([`November 2026 Local SEO report sent to ${OWNER_EMAIL} (test)`]);
  });

  it("a test report's mail logs no error when the rehearsal client has no SEO-1 task, and a real report with none still does", async () => {
    const s = await seoClient({ test: true });
    const { id } = await proposed(s, { test: true });
    await env.DB.prepare(`DELETE FROM tasks WHERE business_id = ? AND cadence_key = 'SEO-1'`).bind(s.businessId).run();
    errors.mockClear();
    expect(await approve(ask(), id)).toEqual({ ok: true });
    expect(errors).not.toHaveBeenCalled();

    const real = await seoClient();
    const { id: realId } = await proposed(real);
    await env.DB.prepare(`DELETE FROM tasks WHERE business_id = ? AND cadence_key = 'SEO-1'`).bind(real.businessId).run();
    expect(await approve(ask(), realId)).toEqual({ ok: true });
    expect(errors).toHaveBeenCalledWith("seo report: the monthly task was not ticked after the mail went out");
  });

  it("a test report with no owner email set throws and sends nothing", async () => {
    const { id } = await proposed(await seoClient({ test: true }), { test: true });
    await saveSettings(env.DB, { contact_email: "" });
    const r = await approve(ask(), id);
    expect(r).toMatchObject({ ok: false, status: 502 });
    expect((r as { error: string }).error).toMatch(/contact email in Settings/);
    expect(mail.sent).toHaveLength(0);
  });

  it("a report that is gone throws", async () => {
    const { report, id } = await proposed(await seoClient());
    await env.DB.prepare(`DELETE FROM seo_reports WHERE id = ?`).bind(report.id).run();
    expect(await approve(ask(), id)).toMatchObject({ ok: false, error: "This report was not found." });
  });
});

describe("the agent", () => {
  it("cannot propose seo.report: only the app does, and nothing is written", async () => {
    const before = await count();
    const r = await tool("propose_approval", { kind: "seo.report", title: "Send the report", preview: "x", payload: { reportId: "r1" } });
    expect(r.isError).toBe(true);
    expect(r.text).toMatch(/seo\.report/);
    expect(r.text).toMatch(/app proposes it itself/);
    expect(await count()).toBe(before);
  });
});
