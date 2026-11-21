import { env } from "cloudflare:test";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { publicReport } from "../src/worker/care/reportPublic";
import { cancel, getReport, insertReport, markSent, revoke, setSummary, setTaskAndApproval, type CareReport } from "../src/worker/db/careReports";
import { newClientToken } from "../src/worker/documents/token";
import type { Env } from "../src/worker/env";
import worker from "../src/worker/index";
import { seedClient } from "./fixtures/clients";

const ctx = { waitUntil() {}, passThroughOnException() {} } as unknown as ExecutionContext;
const e = env as Env;
// 2026-12-02 03:30 UTC is still 1 December in Los Angeles: the day a report is "sent on" is the booking zone's.
const SENT_AT = "2026-12-02T03:30:00.000Z";
const NOW = new Date("2026-12-03T18:00:00.000Z");
const NOT_FOUND = { error: "not found" };
const SUMMARY = "The site was up almost all month and four updates went in.";
const RECOMMENDATION = "Look at why the shop site went down twice.";

const site = (domain: string, over: Record<string, unknown> = {}) => ({
  domain, monitoredSince: "2026-10-03", uptimePercent: 99.9, coveredDays: 30, incidents: 0, longestOutageMinutes: null,
  updatesApplied: 4, updatesRolledBack: 0, updatesFailed: 1, backups: 2, speedScore: 81, ...over,
});
// The stored facts carry more than a client may see (and, here, things no facts builder writes) to prove the page is built field by field.
const FACTS = {
  version: 1, period: "2026-11", label: "November 2026", from: "2026-11-01T07:00:00.000Z", to: "2026-12-01T08:00:00.000Z", clientName: "Ace Plumbing",
  sites: [
    site("ace.com", { updatesTracked: true, alias: "ace-prod", wp_path: "/var/www/ace/public_html", backupFile: "siteline-backups/ace-2026-11-14.tar.gz", slug: "contact-form-7", detail: "Connection refused by the upstream proxy" }),
    site("shop.ace.com", { incidents: 2, longestOutageMinutes: 12, speedScore: null, uptimePercent: null, monitoredSince: null, coveredDays: 0 }),
  ],
  edits: { month: "2026-11", allowanceMinutes: 60, usedMinutes: 100, percent: 166, state: "over", requestsDone: 3 },
  renewals: [{ what: "certificate", domain: "ace.com", on: "2026-12-20" }, { what: "subscription_term", domain: null, on: "2027-01-15" }],
  generatedAt: "2026-12-01T17:00:00.000Z", vaultItem: "Ace WP admin", alias: "ace-prod", wp_path: "/var/www/ace",
};

async function seed(o: { status?: "collecting" | "ready" | "sent" | "revoked" | "cancelled"; facts?: unknown; token?: string } = {}) {
  const s = await seedClient();
  const token = o.token ?? newClientToken();
  const { report } = await insertReport(env.DB, { businessId: s.businessId, period: "2026-11", token, facts: o.facts ?? FACTS, test: false, now: "2026-12-01T17:00:00.000Z" });
  const status = o.status ?? "sent";
  if (status !== "collecting" && status !== "cancelled") await setSummary(env.DB, report.id, ["collecting"], { summary: SUMMARY, recommendation: RECOMMENDATION, source: "claude", now: "2026-12-01T18:00:00.000Z" });
  if (status === "sent" || status === "revoked") await markSent(env.DB, report.id, SENT_AT);
  if (status === "revoked") await revoke(env.DB, report.id, "2026-12-04T10:00:00.000Z");
  if (status === "cancelled") await cancel(env.DB, report.id);
  await setTaskAndApproval(env.DB, report.id, { approvalId: "approval-xyz", claudeTaskId: "task-xyz" });
  return { token, id: report.id, businessId: s.businessId };
}
const views = async (id: string): Promise<CareReport> => (await getReport(env.DB, id))!;
const call = (path: string, init: RequestInit = {}) => worker.fetch(new Request(`https://x/api/public${path}`, init), e as never, ctx);

let errors: ReturnType<typeof vi.spyOn>;
beforeEach(async () => {
  errors = vi.spyOn(console, "error").mockImplementation(() => {});
  await env.DB.prepare(`DELETE FROM care_reports`).run();
});
afterEach(() => { errors.mockRestore(); });

describe("publicReport", () => {
  it("a sent report gives exactly the public shape, and counts one view", async () => {
    const r = await seed();
    const page = await publicReport(e, r.token, NOW);
    expect(page).toEqual({
      clientName: "Ace Plumbing", label: "November 2026", summary: SUMMARY, recommendation: RECOMMENDATION,
      sites: [
        { domain: "ace.com", uptimePercent: 99.9, coveredDays: 30, monitoredSince: "2026-10-03", incidents: 0, longestOutageMinutes: null, updatesApplied: 4, updatesRolledBack: 0, updatesTracked: true, backups: 2, speedScore: 81 },
        // A stored report with no `updatesTracked` (an older one) reads as not tracked.
        { domain: "shop.ace.com", uptimePercent: null, coveredDays: 0, monitoredSince: null, incidents: 2, longestOutageMinutes: 12, updatesApplied: 4, updatesRolledBack: 0, updatesTracked: false, backups: 2, speedScore: null },
      ],
      edits: { usedMinutes: 100, allowanceMinutes: 60, state: "over", requestsDone: 3 },
      renewals: [{ what: "certificate", domain: "ace.com", on: "2026-12-20" }, { what: "subscription_term", domain: null, on: "2027-01-15" }],
      sentOn: "2026-12-01",
    });
    const row = await views(r.id);
    expect(row.viewCount).toBe(1);
    expect(row.firstViewedAt).toBe(NOW.toISOString());
    await publicReport(e, r.token, new Date("2026-12-05T10:00:00.000Z"));
    expect(await views(r.id)).toMatchObject({ viewCount: 2, firstViewedAt: NOW.toISOString() });
  });

  it("a client without Care edits has edits null", async () => {
    const r = await seed({ facts: { ...FACTS, edits: null } });
    expect((await publicReport(e, r.token, NOW))!.edits).toBeNull();
  });

  it("collecting, ready, revoked, cancelled, unknown and malformed tokens are all null, and record no view", async () => {
    const dead: { token: string; id?: string }[] = [];
    for (const status of ["collecting", "ready", "revoked", "cancelled"] as const) dead.push(await seed({ status }));
    const sent = await seed();
    const bad = ["A".repeat(43), "short", "", `${sent.token}x`, sent.token.slice(1), `${sent.token.slice(0, 42)}+`, "A".repeat(42), "../etc/passwd"];
    for (const d of dead) expect(await publicReport(e, d.token, NOW), d.id).toBeNull();
    for (const t of bad) expect(await publicReport(e, t, NOW), t).toBeNull();
    for (const d of dead) expect((await views(d.id!)).viewCount, d.id).toBe(0);
    expect((await views(sent.id)).viewCount).toBe(0);
  });

  it("a sent report whose facts cannot be read is null and records no view", async () => {
    const r = await seed({ facts: { version: 2 } });
    expect(await publicReport(e, r.token, NOW)).toBeNull();
    expect((await views(r.id)).viewCount).toBe(0);
  });

  it("a revoked link stops working: sent, then revoked", async () => {
    const r = await seed();
    expect(await publicReport(e, r.token, NOW)).not.toBeNull();
    await revoke(env.DB, r.id, "2026-12-04T10:00:00.000Z");
    expect(await publicReport(e, r.token, NOW)).toBeNull();
    expect((await views(r.id)).viewCount).toBe(1);
  });
});

describe("GET /api/public/m/:token", () => {
  it("answers a sent report with the page, no-store and noindex", async () => {
    const r = await seed();
    const res = await call(`/m/${r.token}`);
    expect(res.status).toBe(200);
    expect(res.headers.get("cache-control")).toBe("no-store");
    expect(res.headers.get("x-robots-tag")).toMatch(/noindex/);
    expect(((await res.json()) as { clientName: string }).clientName).toBe("Ace Plumbing");
    expect((await views(r.id)).viewCount).toBe(1);
  });

  it("the JSON holds only the public fields: no id, alias, folder, backup or vault name, token, approval or task id, plugin slug or incident sentence", async () => {
    const r = await seed();
    const text = await (await call(`/m/${r.token}`)).text();
    for (const secret of [
      "alias", "ace-prod", "wp_path", "/var/www", "siteline-backups", ".tar.gz", "token", "approval", "approval-xyz", "task-xyz", "contact-form-7", "Connection refused", "vault", "Ace WP admin",
      "updatesFailed", "facts", r.id, r.businessId, r.token,
    ]) expect(text, secret).not.toContain(secret);
    expect(Object.keys(JSON.parse(text)).sort()).toEqual(["clientName", "edits", "label", "recommendation", "renewals", "sentOn", "sites", "summary"]);
    expect(Object.keys(JSON.parse(text).sites[0]).sort()).toEqual(
      ["backups", "coveredDays", "domain", "incidents", "longestOutageMinutes", "monitoredSince", "speedScore", "updatesApplied", "updatesRolledBack", "updatesTracked", "uptimePercent"],
    );
  });

  it("every link that is not live is the same 404, and records no view", async () => {
    const dead = [await seed({ status: "collecting" }), await seed({ status: "ready" }), await seed({ status: "revoked" }), await seed({ status: "cancelled" })];
    const bodies = new Set<string>();
    for (const t of [...dead.map((d) => d.token), newClientToken(), "A".repeat(42), "short"]) {
      const res = await call(`/m/${t}`);
      expect(res.status, t).toBe(404);
      expect(await res.json(), t).toEqual(NOT_FOUND);
      expect(res.headers.get("cache-control"), t).toBe("no-store");
      expect(res.headers.get("x-robots-tag"), t).toMatch(/noindex/);
      bodies.add(JSON.stringify(Object.fromEntries(res.headers)).replace(/"content-length":"\d+",?/, ""));
    }
    expect(bodies.size).toBe(1);
    for (const d of dead) expect((await views(d.id)).viewCount).toBe(0);
  });

  it("only GET reads it: a write to the same address is turned away without a session and counts nothing", async () => {
    const r = await seed();
    expect((await call(`/m/${r.token}`, { method: "POST" })).status).toBe(401);
    expect((await call(`/m/${r.token}`, { method: "DELETE" })).status).toBe(401);
    expect((await views(r.id)).viewCount).toBe(0);
  });
});
