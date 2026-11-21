import { env } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";
import { archiveSite, createSite, setAccess, type AccessKey, type AccessStatus } from "../src/worker/db/sites";
import { addSuppression } from "../src/worker/db/suppression";
import { setProjectStatus } from "../src/worker/db/projects";
import { buildToday, TODAY_KINDS } from "../src/worker/today";
import { seedClient } from "./fixtures/clients";
import { resetProjectWork } from "./fixtures/projects";

/** Thursday 10 December 2026. The fixture project started on 3 December, 7 days earlier. */
const NOW = new Date("2026-12-10T12:00:00.000Z");
const DAY = 86_400_000;
const ago = (days: number) => new Date(NOW.getTime() - days * DAY).toISOString();

// buildToday reads every lead, so each test starts from an empty set (the access items and sites go first: they point at businesses).
beforeEach(async () => {
  await resetProjectWork();
  for (const t of ["billing_holds", "invoice_nudges", "invoices", "subscriptions", "document_views", "document_signatures", "documents", "deals", "activity", "drafts", "audits", "search_results", "businesses", "suppressions"])
    await env.DB.prepare(`DELETE FROM ${t}`).run();
});

const rows = async () => (await buildToday(env.DB, NOW)).filter((i) => i.kind === "access_missing");
const startedDaysAgo = (projectId: string, days: number) => env.DB.prepare(`UPDATE projects SET started_at = ? WHERE id = ?`).bind(ago(days), projectId).run();
/** Every item of the site set to `status`, except `except`, which stays needed. */
const resolveAll = async (siteId: string, status: AccessStatus, except: AccessKey[] = []) => {
  for (const k of ["hosting", "dns", "registrar", "admin", "gbp", "analytics"] as const)
    if (!except.includes(k)) await setAccess(env.DB, siteId, k, { status }, ago(1));
};

describe("access_missing", () => {
  it("is a Today kind", () => {
    expect(TODAY_KINDS).toContain("access_missing");
  });

  it("a client with a live project started 4 days ago and a needed item gets one row naming the labels", async () => {
    const s = await seedClient();
    await startedDaysAgo(s.project!.id, 4);
    await resolveAll(s.site!.id, "received", ["hosting", "dns"]);
    expect(await rows()).toEqual([{
      id: `access_missing:${s.businessId}`, kind: "access_missing", businessId: s.businessId, businessName: expect.any(String), reason: "Access still missing: Hosting, DNS", due: null, priority: 65,
    }]);
  });

  it("names every label in checklist order, a requested item still counts, and nothing typed leaks into the reason", async () => {
    const s = await seedClient();
    await startedDaysAgo(s.project!.id, 4);
    await setAccess(env.DB, s.site!.id, "analytics", { status: "requested", vaultItem: "Acme vault", note: "Pat will send it Friday" }, ago(1));
    await setAccess(env.DB, s.site!.id, "hosting", { status: "received" }, ago(1));
    const [item] = await rows();
    expect(item.reason).toBe("Access still missing: DNS, Registrar, Site admin, Google Business Profile, Analytics");
    expect(item.reason).not.toMatch(/Acme|Friday/);
  });

  it("a project started 1 day ago gets no row, and one started exactly 3 days ago does", async () => {
    const s = await seedClient();
    await startedDaysAgo(s.project!.id, 1);
    expect(await rows()).toEqual([]);
    await startedDaysAgo(s.project!.id, 3);
    expect(await rows()).toHaveLength(1);
    await startedDaysAgo(s.project!.id, 2.9);
    expect(await rows()).toEqual([]);
  });

  it("received, verified and not_applicable items do not count", async () => {
    const s = await seedClient();
    await startedDaysAgo(s.project!.id, 4);
    await resolveAll(s.site!.id, "verified", ["hosting", "dns", "registrar", "admin"]);
    await setAccess(env.DB, s.site!.id, "hosting", { status: "received" }, ago(1));
    await setAccess(env.DB, s.site!.id, "dns", { status: "not_applicable" }, ago(1));
    await setAccess(env.DB, s.site!.id, "registrar", { status: "verified" }, ago(1));
    expect((await rows()).map((i) => i.reason)).toEqual(["Access still missing: Site admin"]);
    await resolveAll(s.site!.id, "not_applicable");
    expect(await rows()).toEqual([]);
  });

  it("an archived site, a test site and a cancelled project give no row", async () => {
    const archived = await seedClient();
    await startedDaysAgo(archived.project!.id, 4);
    await archiveSite(env.DB, archived.site!.id, ago(1));

    const test = await seedClient({ test: true });
    await startedDaysAgo(test.project!.id, 4);

    // A real client whose only open site is a rehearsal one.
    const mixed = await seedClient({ site: false });
    await startedDaysAgo(mixed.project!.id, 4);
    await createSite(env.DB, { businessId: mixed.businessId, url: "https://rehearsal.example", test: true });

    const cancelled = await seedClient();
    await startedDaysAgo(cancelled.project!.id, 4);
    await setProjectStatus(env.DB, cancelled.project!.id, "cancelled");

    expect(await rows()).toEqual([]);
  });

  it("a client with no project, a paused-or-done non-care project, or only a test project gets no row", async () => {
    const none = await seedClient({ project: false });
    const done = await seedClient();
    await startedDaysAgo(done.project!.id, 4);
    await setProjectStatus(env.DB, done.project!.id, "done");
    expect(none.project).toBeNull();
    expect(await rows()).toEqual([]);
  });

  it("a finished Care onboarding still counts as live", async () => {
    const s = await seedClient();
    await startedDaysAgo(s.project!.id, 4);
    await env.DB.prepare(`UPDATE projects SET kind = 'care_onboarding', status = 'done' WHERE id = ?`).bind(s.project!.id).run();
    expect(await rows()).toHaveLength(1);
  });

  it("two sites with gaps give one row naming the union", async () => {
    const s = await seedClient();
    await startedDaysAgo(s.project!.id, 4);
    const second = (await createSite(env.DB, { businessId: s.businessId, url: "https://second-ace.com" })).site;
    await resolveAll(s.site!.id, "received", ["hosting"]);
    await resolveAll(second.id, "received", ["dns", "hosting"]);
    const found = await rows();
    expect(found).toHaveLength(1);
    expect(found[0].reason).toBe("Access still missing: Hosting, DNS");
  });

  it("a second live project does not give a second row", async () => {
    const s = await seedClient();
    await startedDaysAgo(s.project!.id, 4);
    await env.DB.prepare(
      `INSERT INTO projects (id, business_id, kind, name, test, started_at, created_at, updated_at) VALUES (?, ?, 'quick_fix', 'Fix', 0, ?, ?, ?)`,
    ).bind(crypto.randomUUID(), s.businessId, ago(6), ago(6), ago(6)).run();
    expect(await rows()).toHaveLength(1);
  });

  it("the row clears when the last item is received", async () => {
    const s = await seedClient();
    await startedDaysAgo(s.project!.id, 4);
    await resolveAll(s.site!.id, "received", ["registrar"]);
    expect((await rows()).map((i) => i.reason)).toEqual(["Access still missing: Registrar"]);
    await setAccess(env.DB, s.site!.id, "registrar", { status: "received" }, ago(0));
    expect(await rows()).toEqual([]);
  });

  it("a client with no site at all gets no row", async () => {
    const s = await seedClient({ site: false });
    await startedDaysAgo(s.project!.id, 4);
    expect(await rows()).toEqual([]);
  });

  it("stays for a suppressed lead, and Done hides it like any other kind", async () => {
    const s = await seedClient();
    await startedDaysAgo(s.project!.id, 4);
    await addSuppression(env.DB, { kind: "domain", value: "ace.com", reason: "client" });
    expect(await rows()).toHaveLength(1);
    await env.DB.prepare(`INSERT INTO activity (id, business_id, kind, detail, created_at) VALUES (?,?,?,?,?)`)
      .bind(crypto.randomUUID(), s.businessId, "today_done", "access_missing", ago(1)).run();
    expect(await rows()).toEqual([]);
  });

  it("sits below a client's money reason, which still shows as its own row", async () => {
    const s = await seedClient({ invoice: { cents: 50000, dueOn: "2026-12-01" } });
    await startedDaysAgo(s.project!.id, 4);
    const all = (await buildToday(env.DB, NOW)).filter((i) => i.businessId === s.businessId);
    expect(all.map((i) => [i.kind, i.priority])).toEqual([["billing_attention", 75], ["access_missing", 65]]);
    expect(all[0].reason).toBe("Invoice 9 days overdue");
  });
});
