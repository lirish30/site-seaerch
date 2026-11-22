import { env } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";
import { previousMonth } from "../src/worker/care/reportSweep";
import { getSettings } from "../src/worker/db/settings";
import { insertReport, markSent, setSummary } from "../src/worker/db/careReports";
import { zoneOf } from "../src/worker/sop/cadence";
import { actionCount, mcp, ok, tool } from "./fixtures/mcp";
import { seedClient } from "./fixtures/clients";
import { resetProjectWork } from "./fixtures/projects";

// The read-only report tool through the MCP route: the month's reports per client with their numbers and edit hours, and never a token, a link, an alias or a backup file name.
const CARE = [{ key: "care" as const, monthlyCents: 12_900 }];
const TOKEN = "tok-mcp-report-SECRETTOKEN-0123456789abcdef";
const ALIAS = "ace-host-ALIAS-SENTINEL";
const BACKUP = "siteline-backups/ace.com-BACKUP-SENTINEL.sql.gz";
const SUMMARY = "The site was up almost all month and four updates went in.";
const RECOMMENDATION = "Look at why the shop site went down twice.";
const site = (domain: string, over: Record<string, unknown> = {}) => ({
  domain, monitoredSince: "2026-10-03", uptimePercent: 99.9, coveredDays: 30, incidents: 1, longestOutageMinutes: 12,
  updatesApplied: 4, updatesRolledBack: 1, updatesFailed: 0, updatesTracked: true, backups: 2, speedScore: 81, ...over,
});
const facts = (over: Record<string, unknown> = {}) => ({
  version: 1, period: "2026-11", label: "November 2026", from: "2026-11-01T08:00:00.000Z", to: "2026-12-01T08:00:00.000Z", clientName: "Ace Plumbing",
  sites: [site("ace.com", { alias: ALIAS, backupFile: BACKUP })], edits: { month: "2026-11", allowanceMinutes: 60, usedMinutes: 30, percent: 50, state: "ok", requestsDone: 3 },
  renewals: [{ what: "certificate", domain: "ace.com", on: "2026-12-20" }], generatedAt: "2026-12-01T10:00:00.000Z", alias: ALIAS, backupFile: BACKUP, token: TOKEN, ...over,
});

beforeEach(async () => {
  for (const t of ["site_incidents", "site_checks", "site_uptime_days", "care_reports"]) await env.DB.prepare(`DELETE FROM ${t}`).run();
  await resetProjectWork();
  for (const t of ["billing_holds", "invoice_nudges", "invoices", "subscriptions", "document_views", "document_signatures", "documents", "deals", "activity", "drafts", "audits", "search_results", "businesses", "suppressions"])
    await env.DB.prepare(`DELETE FROM ${t}`).run();
});

let n = 0;
async function reported(name: string, o: { status?: "collecting" | "ready" | "sent"; test?: boolean; period?: string; facts?: unknown; token?: string; care?: boolean } = {}) {
  const s = await seedClient({ subs: o.care === false ? [] : CARE, test: o.test });
  await env.DB.prepare(`UPDATE businesses SET name = ? WHERE id = ?`).bind(name, s.businessId).run();
  await env.DB.prepare(`UPDATE sites SET wp_ssh_alias = ? WHERE id = ?`).bind(ALIAS, s.site!.id).run();
  const { report } = await insertReport(env.DB, {
    businessId: s.businessId, period: o.period ?? "2026-11", token: o.token ?? (n++ === 0 ? TOKEN : `${TOKEN}-${n}`), facts: o.facts === undefined ? facts() : o.facts, test: o.test ?? false, now: "2026-12-01T10:00:00.000Z",
  });
  const status = o.status ?? "ready";
  if (status !== "collecting") await setSummary(env.DB, report.id, ["collecting"], { summary: SUMMARY, recommendation: RECOMMENDATION, source: "claude", now: "2026-12-01T11:00:00.000Z" });
  if (status === "sent") await markSent(env.DB, report.id, "2026-12-02T01:00:00.000Z");
  return { s, report };
}

type Answer = { period: string; reports: { clientId: string; client: string; status: string; summary: string; recommendation: string; sentOn: string | null; views: number; headline: any; ledger: any }[] };

describe("the tool", () => {
  it("is registered, which makes 31 tools in all", async () => {
    const names = (await mcp("tools/list", {})).result.tools.map((t: { name: string }) => t.name);
    expect(names).toContain("get_care_report");
    expect(names).toHaveLength(31);
  });
});

describe("get_care_report", () => {
  it("gives each client's report of the period: status, the words, the headline numbers and the edit hours, ordered by client name", async () => {
    const b = await reported("Bay Roofing", { status: "sent" });
    const a = await reported("Ace Plumbing", { status: "ready" });
    const c = await reported("Cedar Dental", { status: "collecting" });
    const out = await ok<Answer>("get_care_report", { period: "2026-11" });
    expect(out.period).toBe("2026-11");
    expect(out.reports.map((r) => [r.client, r.status])).toEqual([["Ace Plumbing", "ready"], ["Bay Roofing", "sent"], ["Cedar Dental", "collecting"]]);
    expect(out.reports[0]).toEqual({
      clientId: a.s.businessId, client: "Ace Plumbing", status: "ready", summary: SUMMARY, recommendation: RECOMMENDATION, sentOn: null, views: 0,
      headline: {
        sites: [{ domain: "ace.com", uptimePercent: 99.9, coveredDays: 30, incidents: 1, longestOutageMinutes: 12, updatesApplied: 4, updatesRolledBack: 1, updatesFailed: 0, updatesTracked: true, backups: 2, speedScore: 81 }],
        editRequestsDone: 3,
      },
      ledger: { month: "2026-11", allowanceMinutes: 60, usedMinutes: 0, percent: 0, state: "ok" },
    });
    expect(out.reports[1]).toMatchObject({ clientId: b.s.businessId, sentOn: "2026-12-01" }); // 01:00 UTC on the 2nd is still the 1st in Los Angeles
    expect(out.reports[2]).toMatchObject({ clientId: c.s.businessId, summary: "", recommendation: "" });
  });

  it("says updatesTracked false for a site no update run covered (an older stored report has none), so the agent cannot read its zeros as measured", async () => {
    await reported("Ace Plumbing", { status: "sent", facts: facts({ sites: [site("ace.com", { updatesTracked: undefined, updatesApplied: 0, updatesRolledBack: 0 })] }) });
    const out = await ok<Answer>("get_care_report", { period: "2026-11" });
    expect(out.reports[0].headline.sites[0]).toMatchObject({ updatesTracked: false, updatesApplied: 0 });
  });

  it("never returns a token, a link, an alias or a backup file name, even when the stored numbers carry them", async () => {
    await reported("Ace Plumbing", { status: "sent" });
    const r = await tool("get_care_report", { period: "2026-11" });
    expect(r.isError).toBe(false);
    for (const bad of [TOKEN, "tok-mcp", ALIAS, BACKUP, "siteline-backups", ".sql", "http", "/m/", "token", "alias", "backupFile", "link", "ssh"]) expect(r.text, `shows ${bad}`).not.toContain(bad);
  });

  it("leaves out a rehearsal client's report and takes clientId to narrow to one client", async () => {
    const a = await reported("Ace Plumbing");
    await reported("Rehearsal Co", { test: true });
    const other = await reported("Other Co");
    expect((await ok<Answer>("get_care_report", { period: "2026-11" })).reports.map((r) => r.client)).toEqual(["Ace Plumbing", "Other Co"]);
    expect((await ok<Answer>("get_care_report", { period: "2026-11", clientId: other.s.businessId })).reports.map((r) => r.client)).toEqual(["Other Co"]);
    expect((await ok<Answer>("get_care_report", { period: "2026-11", clientId: "nope" })).reports).toEqual([]);
    expect(a.s.businessId).not.toBe(other.s.businessId);
  });

  it("defaults to last month in the booking zone, and answers an empty list for a month with no reports", async () => {
    const last = previousMonth(new Date(), zoneOf(await getSettings(env.DB)));
    await reported("Ace Plumbing", { period: last, facts: facts({ period: last }) });
    const out = await ok<Answer>("get_care_report", {});
    expect(out.period).toBe(last);
    expect(out.reports).toHaveLength(1);
    expect((await ok<Answer>("get_care_report", { period: "1999-01" })).reports).toEqual([]);
  });

  it("answers null headline numbers when the stored numbers cannot be read, and a null ledger without a Care plan", async () => {
    await reported("Broken Facts", { facts: { nonsense: true }, care: false });
    const [row] = (await ok<Answer>("get_care_report", { period: "2026-11" })).reports;
    expect(row).toMatchObject({ client: "Broken Facts", headline: null, ledger: null });
  });

  it("refuses a period that is not YYYY-MM and writes one agent action per call", async () => {
    for (const period of ["2026-13", "last month", "2026-1", "2026-11-01"]) expect((await tool("get_care_report", { period })).isError, period).toBe(true);
    const before = await actionCount("get_care_report");
    await tool("get_care_report", { period: "2026-11" });
    expect(await actionCount("get_care_report")).toBe(before + 1);
  });
});
