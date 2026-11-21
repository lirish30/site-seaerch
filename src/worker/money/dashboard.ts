import type { Env } from "../env";
import { calendarDateIn } from "../billing/dates";
import { clientMrrCents, testClientSql } from "../clients/record";
import { listInvoices } from "../db/invoices";
import { listProjects } from "../db/projects";
import { getSettings } from "../db/settings";
import { listSubscriptions, type Subscription } from "../db/subscriptions";
import { timeTotals } from "../db/time";
import { zoneOf } from "../sop/cadence";
import { serviceSpend, spendStatus } from "../spend";
import { parseWorkConfig } from "../time/config";
import { projectProfit, type Profit } from "../time/profit";
import { parseMoneyConfig } from "./config";
import { arAging, bookedNotBilled, churn, freedomProgress, revenueByMonth } from "./figures";
import { soldAndPaid } from "./sold";

export interface MoneyDashboard {
  /** When the figures were taken (ISO), and the booking zone every date and month in them is counted in. */
  asOf: string;
  zone: string;
  /** Cash received. `months` is six calendar months ending with the current one, oldest first; `monthCents` is the current one. */
  revenue: { monthCents: number; months: { month: string; cents: number }[] };
  ar: ReturnType<typeof arAging>;
  mrr: { cents: number; subscriptions: number; churnedLast30Cents: number; churnRatePct: number | null };
  bookedNotBilled: { cents: number; rows: (ReturnType<typeof bookedNotBilled>["rows"][number] & { businessName: string })[] };
  /** One row per live or finished project that was sold for something, largest sale first. */
  profit: ({ projectId: string; businessName: string; name: string; soldCents: number; paidCents: number; minutes: number } & Profit)[];
  /** The ten clients who have paid the most (cash actually received), with what each bills a month now. No projection. */
  ltv: { businessId: string; name: string; paidCents: number; mrrCents: number }[];
  freedom: ReturnType<typeof freedomProgress>;
  costs: { spentUsd: number; limitUsd: number; level: "ok" | "warn" | "capped"; services: { service: string; spentUsd: number; capUsd: number | null; level: string }[] };
}

const REVENUE_MONTHS = 6;

/** A proposal's one-time money (its milestones) and the first Care months its deposit also carries (its prepaid recurring items). */
function scheduleCents(content: string): { milestoneCents: number; prepaidCents: number } {
  const { schedule } = JSON.parse(content) as { schedule: { milestones: { amountCents: number }[]; recurring?: { monthlyCents: number; firstMonthPrepaid: boolean }[] } };
  return {
    milestoneCents: schedule.milestones.reduce((sum, m) => sum + m.amountCents, 0),
    prepaidCents: (schedule.recurring ?? []).filter((r) => r.firstMonthPrepaid).reduce((sum, r) => sum + r.monthlyCents, 0),
  };
}
const LTV_ROWS = 10;
const placeholders = (n: number) => Array.from({ length: n }, () => "?").join(", ");

/**
 * Everything on the money page, as of `now`. Each table is read once and filtered in memory (the client count is small); only the time totals are read per project.
 * A test client (see `testClientSql`) and every row marked `test` is left out of every figure.
 */
export async function moneyDashboard(env: Env, now: Date): Promise<MoneyDashboard> {
  const db = env.DB;
  const settings = await getSettings(db);
  const zone = zoneOf(settings);
  const today = calendarDateIn(now, zone);

  // Test clients, among the businesses that have any money record (a lead with none cannot be one, and the list of leads is long).
  const testClients = new Set((await db.prepare(
    `SELECT b.id FROM businesses b WHERE b.id IN (SELECT business_id FROM invoices UNION SELECT business_id FROM subscriptions UNION SELECT business_id FROM projects UNION SELECT business_id FROM documents UNION SELECT business_id FROM change_orders)
       AND ${testClientSql("b")}`,
  ).all<{ id: string }>()).results.map((r) => r.id));
  const real = <T extends { businessId: string; test: boolean }>(rows: T[]): T[] => rows.filter((r) => !r.test && !testClients.has(r.businessId));

  const [allInvoices, allSubs, allProjects, docRows, orderRows] = await Promise.all([
    listInvoices(db), listSubscriptions(db), listProjects(db),
    db.prepare(`SELECT id, deal_id, business_id, content FROM documents WHERE status = 'signed' AND test = 0`).all<{ id: string; deal_id: string; business_id: string; content: string }>(),
    db.prepare(`SELECT id, project_id, business_id, status, paid_at, content, test FROM change_orders`).all<{ id: string; project_id: string; business_id: string; status: string; paid_at: string | null; content: string; test: number }>(),
  ]);
  const invoices = real(allInvoices), subs: Subscription[] = real(allSubs);

  // Signed proposals' one-time money (a deal holds one real signed proposal: `createDraft` refuses a new version once one is signed, and a signed real one cannot be voided or expire, so a superseded, void, expired, draft or sent one is never booked),
  // and the first Care month a deposit carries (it is not milestone money). Every change order (only a signed one is booked; `soldAndPaid` filters by status itself).
  const documents = docRows.results.filter((d) => !testClients.has(d.business_id)).map((d) => ({
    id: d.id, dealId: d.deal_id, businessId: d.business_id,
    ...scheduleCents(d.content),
  }));
  const orders = orderRows.results.filter((o) => !o.test && !testClients.has(o.business_id)).map((o) => ({
    id: o.id, projectId: o.project_id, businessId: o.business_id, status: o.status, paidAt: o.paid_at, content: { priceCents: (JSON.parse(o.content) as { priceCents: number }).priceCents },
  }));

  const months = revenueByMonth(invoices, zone, today.slice(0, 7), REVENUE_MONTHS);
  const live = subs.filter((s) => clientMrrCents([s]) > 0);
  const booked = bookedNotBilled({ documents, signedOrders: orders.filter((o) => o.status === "signed").map((o) => ({ id: o.id, businessId: o.businessId, priceCents: o.content.priceCents, paidAt: o.paidAt })), invoices });
  const mrrCents = clientMrrCents(subs);

  const costRateCentsPerHour = parseWorkConfig(settings.work_config).costRateCentsPerHour;
  const profit: MoneyDashboard["profit"] = [];
  for (const p of real(allProjects)) {
    if (p.status !== "active" && p.status !== "done") continue;
    const { soldCents, paidCents } = await soldAndPaid(env, p, orders.filter((o) => o.projectId === p.id));
    if (soldCents <= 0) continue;
    const { actualMinutes: minutes } = await timeTotals(db, { projectId: p.id });
    profit.push({ projectId: p.id, businessName: p.businessName, name: p.name, soldCents, paidCents, minutes, ...projectProfit({ soldCents, paidCents, minutes, costRateCentsPerHour }) });
  }
  profit.sort((a, b) => b.soldCents - a.soldCents || (a.projectId < b.projectId ? -1 : 1));

  const paidBy = new Map<string, number>();
  for (const i of invoices) if (i.status === "paid") paidBy.set(i.businessId, (paidBy.get(i.businessId) ?? 0) + i.amountCents);
  const top = [...paidBy].filter(([, cents]) => cents > 0).sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1)).slice(0, LTV_ROWS);
  const bookedIds = booked.rows.map((r) => r.businessId);
  const nameIds = [...new Set([...top.map(([id]) => id), ...bookedIds])];
  const names = new Map<string, string>(nameIds.length === 0 ? [] : (await db.prepare(`SELECT id, name FROM businesses WHERE id IN (${placeholders(nameIds.length)})`).bind(...nameIds).all<{ id: string; name: string }>()).results.map((r) => [r.id, r.name]));
  const nameOf = (id: string) => names.get(id) ?? "";

  const status = await spendStatus(db, now);
  return {
    asOf: now.toISOString(), zone,
    revenue: { monthCents: months.at(-1)?.cents ?? 0, months },
    ar: arAging(invoices, today),
    mrr: { cents: mrrCents, subscriptions: live.length, ...churn(subs, now) },
    bookedNotBilled: { cents: booked.cents, rows: booked.rows.map((r) => ({ ...r, businessName: nameOf(r.businessId) })) },
    profit,
    ltv: top.map(([businessId, paidCents]) => ({ businessId, name: nameOf(businessId), paidCents, mrrCents: clientMrrCents(subs.filter((s) => s.businessId === businessId)) })),
    freedom: freedomProgress(mrrCents, parseMoneyConfig(settings.money_config).freedomMrrCents),
    costs: { spentUsd: status.spentUsd, limitUsd: status.limitUsd, level: status.level, services: await serviceSpend(db, now) },
  };
}
