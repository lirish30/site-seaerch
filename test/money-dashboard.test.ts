import { SELF, env } from "cloudflare:test";
import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import { addDays, calendarDateIn } from "../src/worker/billing/dates";
import { saveSettings } from "../src/worker/db/settings";
import { markInvoice } from "../src/worker/db/invoices";
import { markSubscription } from "../src/worker/db/subscriptions";
import { setProjectStatus } from "../src/worker/db/projects";
import { setSpendCap } from "../src/worker/db/spendCaps";
import { insertTasks } from "../src/worker/db/tasks";
import { insertEntry } from "../src/worker/db/time";
import { moneyDashboard } from "../src/worker/money/dashboard";
import { serviceSpend, spendStatus } from "../src/worker/spend";
import { addChangeOrder, seedClient } from "./fixtures/clients";
import { proposal } from "./fixtures/documents";
import { newTask } from "./fixtures/projects";

const NOW = new Date("2027-03-15T20:00:00.000Z");
const PAID_AT = "2027-03-02T18:00:00.000Z";

let cookie = "";
beforeAll(async () => {
  const r = await SELF.fetch("https://x/api/login", { method: "POST", body: JSON.stringify({ password: "test-pass" }), headers: { "content-type": "application/json" } });
  cookie = r.headers.get("set-cookie")!.split(";")[0];
});

/** Everything the dashboard reads, emptied (children before parents), so a test counts only its own rows. */
async function reset() {
  const tables = [
    "billing_holds", "invoice_nudges", "invoices", "task_comments", "time_entries", "tasks", "change_order_views", "change_orders", "project_milestones", "project_cadences", "subscriptions", "projects",
    "onboarding_nudges", "onboarding_answers", "onboarding_files", "onboarding_items", "onboardings", "document_signatures", "document_views", "documents",
    "booking_reminders", "meetings", "bookings", "deals", "site_access_items", "sites", "stripe_customers", "usage", "spend_caps",
  ];
  await env.DB.batch(tables.map((t) => env.DB.prepare(`DELETE FROM ${t}`)));
  await env.DB.prepare(`DELETE FROM businesses`).run();
  await saveSettings(env.DB, { money_config: "{}", work_config: "{}", booking_config: "{}" });
}
beforeEach(reset);

/** The document gets a one-time payment schedule of this many cents (the real project's sold figure). */
const schedule = (documentId: string, cents: number) =>
  env.DB.prepare(`UPDATE documents SET content = ? WHERE id = ?`).bind(JSON.stringify({ ...proposal(), schedule: { milestones: [{ id: "m1", label: "Build", dueOn: "signing", amountCents: cents }], recurring: [], depositCents: 0 } }), documentId).run();
const pay = (invoiceId: string, paidAt = PAID_AT) => markInvoice(env.DB, invoiceId, { status: "paid", paidAt });
const api = async (path: string) => (await SELF.fetch(`https://x/api${path}`, { headers: { cookie } })).json<any>();

describe("moneyDashboard", () => {
  it("an empty database gives zeros and null percentages, never NaN or a throw", async () => {
    const d = await moneyDashboard(env, NOW);
    expect(d).toMatchObject({
      asOf: NOW.toISOString(), zone: "America/Los_Angeles",
      revenue: { monthCents: 0 }, ar: { openCents: 0, oldest: [] }, mrr: { cents: 0, subscriptions: 0, churnedLast30Cents: 0, churnRatePct: null },
      bookedNotBilled: { cents: 0, rows: [] }, profit: [], ltv: [], freedom: { targetCents: 500_000, mrrCents: 0, pct: 0, gapCents: 500_000 },
    });
    expect(d.revenue.months.map((m) => m.month)).toEqual(["2026-10", "2026-11", "2026-12", "2027-01", "2027-02", "2027-03"]);
    expect(JSON.stringify(d)).not.toMatch(/NaN|Infinity|null,"gapCents":-/);
    expect(JSON.parse(JSON.stringify(d))).toEqual(d);
  });

  it("a freedom target of 0 gives a null percentage", async () => {
    await saveSettings(env.DB, { money_config: JSON.stringify({ freedomMrrCents: 0 }) });
    expect((await moneyDashboard(env, NOW)).freedom).toEqual({ targetCents: 0, mrrCents: 0, pct: null, gapCents: 0 });
  });

  it("a real client with a Care subscription and a paid deposit shows in mrr, revenue, ltv and freedom", async () => {
    const s = await seedClient({ subs: [{ key: "care", monthlyCents: 12_900 }], invoice: { cents: 100_000, dueOn: "2027-02-20" } });
    await pay(s.invoice!.id);
    const d = await moneyDashboard(env, NOW);
    expect(d.mrr).toMatchObject({ cents: 12_900, subscriptions: 1 });
    expect(d.revenue.monthCents).toBe(100_000);
    expect(d.revenue.months.at(-1)).toEqual({ month: "2027-03", cents: 100_000 });
    expect(d.ltv).toEqual([{ businessId: s.businessId, name: expect.any(String), paidCents: 100_000, mrrCents: 12_900 }]);
    expect(d.ltv[0].name).not.toBe("");
    expect(d.freedom).toEqual({ targetCents: 500_000, mrrCents: 12_900, pct: 2.6, gapCents: 487_100 });
    expect(d.ar.openCents).toBe(0);
  });

  it("a test client with a subscription and a paid invoice changes nothing", async () => {
    const real = await seedClient({ subs: [{ key: "care", monthlyCents: 12_900 }], invoice: { cents: 100_000 } });
    await pay(real.invoice!.id);
    await schedule(real.documentId, 300_000);
    const before = await moneyDashboard(env, NOW);
    const test = await seedClient({ test: true, subs: [{ key: "care", monthlyCents: 55_500 }, { key: "care_plus", monthlyCents: 9_000, status: "cancelled" }], invoice: { cents: 777_000, dueOn: "2027-01-01" } });
    await pay(test.invoice!.id);
    await markSubscription(env.DB, test.subIds[1], { cancelledAt: "2027-03-10T00:00:00.000Z" });
    await schedule(test.documentId, 900_000);
    await addChangeOrder(test, test.project!.id);
    await env.DB.prepare(`UPDATE change_orders SET status = 'signed' WHERE project_id = ?`).bind(test.project!.id).run();
    await seedClient({ test: true, invoice: { cents: 33_000, dueOn: "2027-01-01" } }); // an open, long-overdue test invoice
    expect(await moneyDashboard(env, NOW)).toEqual(before);
  });

  it("a row marked test on a real client does not count either", async () => {
    const s = await seedClient({ subs: [{ key: "care", monthlyCents: 12_900 }, { key: "care_plus", monthlyCents: 40_000, test: true }], invoice: { cents: 100_000 } });
    await pay(s.invoice!.id);
    await env.DB.prepare(`UPDATE invoices SET test = 1 WHERE id = ?`).bind(s.invoice!.id).run();
    const d = await moneyDashboard(env, NOW);
    expect(d.mrr.cents).toBe(12_900);
    expect(d.revenue.monthCents).toBe(0);
    expect(d.ltv).toEqual([]);
  });

  it("counts a payment in the booking zone's month", async () => {
    const s = await seedClient({ invoice: { cents: 50_000 } });
    await pay(s.invoice!.id, "2027-02-01T07:30:00.000Z"); // 11:30 pm Jan 31 in Los Angeles
    expect((await moneyDashboard(env, NOW)).revenue.months.slice(-3)).toEqual([{ month: "2027-01", cents: 50_000 }, { month: "2027-02", cents: 0 }, { month: "2027-03", cents: 0 }]);
    await saveSettings(env.DB, { booking_config: JSON.stringify({ timezone: "Europe/Berlin" }) });
    const d = await moneyDashboard(env, NOW);
    expect(d.zone).toBe("Europe/Berlin");
    expect(d.revenue.months.slice(-3).map((m) => m.cents)).toEqual([0, 50_000, 0]);
  });

  it("AR agrees with the billing summary on what is overdue", async () => {
    const ago = (days: number) => addDays(calendarDateIn(new Date(), "America/Los_Angeles"), -days);
    const a = await seedClient({ invoice: { cents: 40_000, dueOn: ago(14) } });
    await seedClient({ invoice: { cents: 25_000, dueOn: ago(-7) } }); // not yet due
    await seedClient({ invoice: { cents: 5_000, dueOn: ago(3) } });
    await env.DB.prepare(`UPDATE invoices SET failed_on = ?, status = 'failed' WHERE id = ?`).bind(ago(40), a.invoice!.id).run();
    const d = await moneyDashboard(env, new Date());
    const summary = await api("/billing/summary");
    const late = d.ar.buckets.filter((b) => b.key !== "current").reduce((sum, b) => sum + b.cents, 0);
    expect(late).toBe(summary.overdueCents);
    expect(d.ar.openCents).toBe(summary.openCents);
    expect(late).toBe(45_000);
    expect(d.ar.oldest[0]).toMatchObject({ invoiceId: a.invoice!.id, amountCents: 40_000, daysOverdue: 40 }); // counted from the day it failed
  });

  it("churn counts an explicit cancellation in the last 30 days and not an ended subscription", async () => {
    await seedClient({ subs: [{ key: "care", monthlyCents: 30_000 }, { key: "care_plus", monthlyCents: 10_000, status: "cancelled" }, { key: "local_seo", monthlyCents: 77_700, status: "ended" }] });
    const subs = (await env.DB.prepare(`SELECT id, package_key FROM subscriptions`).all<{ id: string; package_key: string }>()).results;
    const id = (k: string) => subs.find((r) => r.package_key === k)!.id;
    await markSubscription(env.DB, id("care_plus"), { cancelledAt: "2027-03-01T00:00:00.000Z" });
    await markSubscription(env.DB, id("local_seo"), { cancelledAt: "2027-03-01T00:00:00.000Z" });
    const d = await moneyDashboard(env, NOW);
    expect(d.mrr).toMatchObject({ cents: 30_000, subscriptions: 1, churnedLast30Cents: 10_000, churnRatePct: 25 });
  });

  it("booked not billed is the signed schedule and signed change orders less what was invoiced", async () => {
    const s = await seedClient({ invoice: { cents: 100_000 } }); // an open milestone invoice on the proposal
    await schedule(s.documentId, 300_000);
    await addChangeOrder(s, s.project!.id);
    await env.DB.prepare(`UPDATE change_orders SET status = 'signed' WHERE project_id = ?`).bind(s.project!.id).run();
    const d = await moneyDashboard(env, NOW);
    expect(d.bookedNotBilled.cents).toBe(200_000 + 30_000);
    expect(d.bookedNotBilled.rows).toEqual([{ businessId: s.businessId, businessName: expect.any(String), bookedCents: 330_000, billedCents: 100_000, cents: 230_000 }]);
  });

  it("profit has the same sold and paid as GET /api/projects/:id", async () => {
    await saveSettings(env.DB, { work_config: JSON.stringify({ costRateCentsPerHour: 6_000 }) });
    const s = await seedClient({ invoice: { cents: 100_000 } });
    await schedule(s.documentId, 300_000);
    await pay(s.invoice!.id);
    await addChangeOrder(s, s.project!.id);
    await env.DB.prepare(`UPDATE change_orders SET status = 'signed' WHERE project_id = ?`).bind(s.project!.id).run();
    const [task] = await insertTasks(env.DB, [newTask(s.project!.id, s.businessId)]);
    await insertEntry(env.DB, { taskId: task.id, projectId: s.project!.id, businessId: s.businessId, startedAt: "2027-03-01T10:00:00.000Z", endedAt: "2027-03-01T12:00:00.000Z", minutes: 120, billable: true, note: "", source: "manual" });
    const d = await moneyDashboard(env, NOW);
    const detail = await api(`/projects/${s.project!.id}`);
    expect(d.profit).toHaveLength(1);
    expect(d.profit[0]).toMatchObject({ projectId: s.project!.id, name: s.project!.name, soldCents: detail.profit.soldCents, paidCents: detail.profit.paidCents });
    expect(d.profit[0]).toMatchObject({ soldCents: 330_000, paidCents: 100_000, costCents: 12_000, marginSoldCents: detail.profit.marginSoldCents, marginPaidCents: detail.profit.marginPaidCents, effectiveHourlyCents: detail.profit.effectiveHourlyCents, minutes: 120 });
    expect(d.profit[0].businessName).toEqual(expect.any(String));
  });

  it("profit lists only live-or-done projects that were sold for something", async () => {
    const sold = await seedClient();
    await schedule(sold.documentId, 100_000);
    const paused = await seedClient();
    await schedule(paused.documentId, 100_000);
    await setProjectStatus(env.DB, paused.project!.id, "paused");
    const done = await seedClient();
    await schedule(done.documentId, 50_000);
    await env.DB.prepare(`UPDATE projects SET status = 'done' WHERE id = ?`).bind(done.project!.id).run();
    await seedClient(); // sold nothing
    const d = await moneyDashboard(env, NOW);
    expect(d.profit.map((p) => p.projectId).sort()).toEqual([sold.project!.id, done.project!.id].sort());
  });

  it("ltv is the top ten clients by what they have paid", async () => {
    for (let i = 1; i <= 12; i++) { const s = await seedClient({ invoice: { cents: i * 1_000 } }); await pay(s.invoice!.id); }
    const d = await moneyDashboard(env, NOW);
    expect(d.ltv.map((l) => l.paidCents)).toEqual([12, 11, 10, 9, 8, 7, 6, 5, 4, 3].map((n) => n * 1_000));
  });

  it("costs equal spendStatus and serviceSpend for the same now", async () => {
    await env.DB.prepare(`INSERT INTO usage (id, month, service, units, est_cost_usd, created_at) VALUES (?, '2027-03', 'brightdata', 10, 3.5, ?), (?, '2027-02', 'places', 5, 9, ?)`)
      .bind(crypto.randomUUID(), NOW.toISOString(), crypto.randomUUID(), NOW.toISOString()).run();
    await setSpendCap(env.DB, "brightdata", 4);
    await setSpendCap(env.DB, "pagespeed", 10);
    const d = await moneyDashboard(env, NOW);
    const status = await spendStatus(env.DB, NOW), services = await serviceSpend(env.DB, NOW);
    expect(d.costs).toEqual({ spentUsd: status.spentUsd, limitUsd: status.limitUsd, level: status.level, services });
    expect(d.costs.services.map((x) => x.service)).toEqual(["brightdata", "pagespeed"]);
  });
});
