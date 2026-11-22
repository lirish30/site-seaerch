import { env } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { filterByGrade, gradeChipLabel } from "../src/client/clientView";
import { A_MIN_MRR_CENTS, A_MIN_TENURE_DAYS, suggestGrade, type GradeInput } from "../src/worker/clients/grade";
import { gradeInputs } from "../src/worker/clients/gradeData";
import { saveSettings } from "../src/worker/db/settings";
import { openInvoice, seedDraft } from "./fixtures/billing";
import { addChangeOrder, seedClient } from "./fixtures/clients";

const DAY = 86_400_000;
// 3 Feb 2027, 10:00 in Los Angeles. A project that started on T0 (3 Dec 2026) is 62 days old then.
const NOW = new Date("2027-02-03T18:00:00.000Z");
const ago = (days: number) => new Date(NOW.getTime() - days * DAY).toISOString();

/** An A client in every respect; each case below spoils one thing. */
const GOOD: GradeInput = { mrrCents: 12_900, healthScore: 85, lateInvoices12mo: 0, changeOrders6mo: 1, tenureDays: 60 };
const g = (o: Partial<GradeInput>) => suggestGrade({ ...GOOD, ...o });

describe("suggestGrade", () => {
  it("no revenue and no health data is B, never A", () => {
    const s = suggestGrade({ mrrCents: 0, healthScore: null, lateInvoices12mo: 0, changeOrders6mo: 0, tenureDays: 0 });
    expect(s.grade).toBe("B");
    expect(s.reasons.length).toBeGreaterThan(0);
  });

  it("A needs all five conditions and drops to B when one fails", () => {
    expect(suggestGrade(GOOD).grade).toBe("A");
    expect(A_MIN_MRR_CENTS).toBe(12_900);
    expect(A_MIN_TENURE_DAYS).toBe(60);
    expect(g({ mrrCents: 12_899 }).grade).toBe("B");
    expect(g({ healthScore: 79 }).grade).toBe("B");
    expect(g({ lateInvoices12mo: 1 }).grade).toBe("B");
    expect(g({ changeOrders6mo: 2 }).grade).toBe("B");
    expect(g({ tenureDays: 59 }).grade).toBe("B");
    expect(g({ healthScore: null }).grade).toBe("B");
  });

  it("C when health is 59, when there are 2 late invoices, when there are 3 change orders", () => {
    expect(g({ healthScore: 59 }).grade).toBe("C");
    expect(g({ healthScore: 60 }).grade).toBe("B"); // 60 is not under 60, and not 80 either
    expect(g({ lateInvoices12mo: 2 }).grade).toBe("C");
    expect(g({ changeOrders6mo: 3 }).grade).toBe("C");
    // C is checked before A, so a client that is otherwise an A is still a C.
    expect(suggestGrade({ ...GOOD, mrrCents: 50_000, tenureDays: 900, healthScore: 59 }).grade).toBe("C");
  });

  it("unknown health (null) never makes C by itself", () => {
    expect(suggestGrade({ mrrCents: 0, healthScore: null, lateInvoices12mo: 0, changeOrders6mo: 0, tenureDays: 400 }).grade).toBe("B");
    expect(suggestGrade({ mrrCents: 50_000, healthScore: null, lateInvoices12mo: 1, changeOrders6mo: 2, tenureDays: 400 }).grade).toBe("B");
  });

  it("reasons say each rule in a plain sentence", () => {
    expect(g({ healthScore: 52, lateInvoices12mo: 3, changeOrders6mo: 4 }).reasons).toEqual([
      "Health is 52, under 60.", "3 invoices paid late in the last 12 months.", "4 change orders signed in the last 6 months.",
    ]);
    expect(g({ healthScore: 70, mrrCents: 0, tenureDays: 10 }).reasons).toEqual([
      "No monthly revenue yet; an A pays $129 a month or more.", "Health is 70; an A has 80 or better.", "A client for 10 days; an A has been one for 60 or more.",
    ]);
    expect(suggestGrade(GOOD).reasons).toEqual([
      "Pays $129 a month.", "Health is 85.", "No late invoices in the last 12 months.", "1 change order signed in the last 6 months.", "A client for 60 days.",
    ]);
  });
});

describe("gradeInputs", () => {
  it("counts a late invoice as one whose reminder step passed the first offset after the due date (default offsets give r3 and r4), ignores test invoices, and counts change orders with status `signed` created in the last 6 months (draft, sent, declined, void and expired ones are not scope that happened)", async () => {
    await saveSettings(env.DB, { billing_config: "{}" });
    const s = await seedClient({ subs: [{ key: "care", monthlyCents: 12_900 }] });
    const seed = { businessId: s.businessId, dealId: s.dealId, documentId: s.documentId };

    /** One invoice with these reminder steps raised; `created` days ago, a test one when `test`. */
    async function invoiceWith(steps: string[], o: { test?: boolean; created?: number } = {}) {
      const { invoice } = await seedDraft({ seed, test: o.test, lines: [{ description: "Milestone", amountCents: 50_000 }] });
      await env.DB.prepare(`UPDATE invoices SET created_at = ? WHERE id = ?`).bind(ago(o.created ?? 10), invoice.id).run();
      for (const step of steps) await env.DB.prepare(`INSERT INTO invoice_nudges (invoice_id, step, created_at) VALUES (?, ?, ?)`).bind(invoice.id, step, ago(5)).run();
      return invoice;
    }
    await invoiceWith(["r1", "r2"]); // a heads-up and a due-day nudge: not late
    await invoiceWith(["r1", "r2", "r3"]); // late
    await invoiceWith(["r4"]); // late
    await invoiceWith(["r3", "r4"]); // late, counted once
    await invoiceWith(["r3", "r4"], { test: true }); // a test invoice: ignored
    await invoiceWith(["r4"], { created: 400 }); // more than 12 months ago: ignored
    await invoiceWith(["pause"]); // a pause is not a reminder step
    await invoiceWith([]); // never reminded

    const project = s.project!;
    const orders = [];
    for (let n = 0; n < 8; n++) orders.push(await addChangeOrder(s, project.id));
    const set = async (id: string, status: string, created: number, test = 0) =>
      env.DB.prepare(`UPDATE change_orders SET status = ?, created_at = ?, test = ? WHERE id = ?`).bind(status, ago(created), test, id).run();
    await set(orders[0].id, "signed", 20);
    await set(orders[1].id, "signed", 170);
    await set(orders[2].id, "signed", 200); // older than 6 months
    await set(orders[3].id, "draft", 5);
    await set(orders[4].id, "sent", 5);
    await set(orders[5].id, "declined", 5);
    await set(orders[6].id, "void", 5);
    await set(orders[7].id, "expired", 5);

    const i = (await gradeInputs(env.DB, [s.businessId], NOW)).get(s.businessId)!;
    expect(i.lateInvoices12mo).toBe(3);
    expect(i.changeOrders6mo).toBe(2);
    expect(i.mrrCents).toBe(12_900);
    expect(i.tenureDays).toBe(62); // the project started on 3 December 2026

    // A custom schedule: both reminders come after the due date, so r1 and r2 are late and a step with no offset (r3, r4) is not.
    await saveSettings(env.DB, { billing_config: JSON.stringify({ reminderOffsets: [1, 10] }) });
    expect((await gradeInputs(env.DB, [s.businessId], NOW)).get(s.businessId)!.lateInvoices12mo).toBe(2);
    await saveSettings(env.DB, { billing_config: "{}" });
  });

  it("gives every id asked for an entry: a client with nothing recorded has zeros and unknown health, and the tenure reads from the first paid invoice when it is older than the first project", async () => {
    await saveSettings(env.DB, { billing_config: "{}" });
    const bare = await seedClient({ project: false, site: false });
    const m = await gradeInputs(env.DB, [bare.businessId, "unknown-id"], NOW);
    expect([...m.keys()]).toEqual([bare.businessId, "unknown-id"]);
    expect(m.get(bare.businessId)).toEqual({ mrrCents: 0, healthScore: null, lateInvoices12mo: 0, changeOrders6mo: 0, tenureDays: 0 });

    const s = await seedClient();
    const { invoice } = await seedDraft({ seed: { businessId: s.businessId, dealId: s.dealId, documentId: s.documentId } });
    const open = await openInvoice(invoice);
    await env.DB.prepare(`UPDATE invoices SET status = 'paid', paid_at = ? WHERE id = ?`).bind(ago(100), open.id).run();
    expect((await gradeInputs(env.DB, [s.businessId], NOW)).get(s.businessId)!.tenureDays).toBe(100);
  });

  it("reads many clients in chunks of 50 and gives the same answer as one at a time", async () => {
    const ids: string[] = [];
    for (let n = 0; n < 3; n++) ids.push((await seedClient({ subs: [{ monthlyCents: 1000 * (n + 1) }] })).businessId);
    const padded = [...ids, ...Array.from({ length: 60 }, (_, n) => `no-such-${n}`)];
    const all = await gradeInputs(env.DB, padded, NOW);
    expect(all.size).toBe(63);
    for (const [n, id] of ids.entries()) {
      expect(all.get(id)!.mrrCents).toBe(1000 * (n + 1));
      expect((await gradeInputs(env.DB, [id], NOW)).get(id)).toEqual(all.get(id));
    }
  });
});

describe("the grade chip and filter", () => {
  const view = (grade: "A" | "B" | "C" | null, suggested: "A" | "B" | "C" = "B") => ({ grade, note: "", setAt: null, suggested, reasons: [] });
  it("a set grade reads as the grade, an unset one as the suggestion marked suggested", () => {
    expect(gradeChipLabel(view("A"))).toEqual({ letter: "A", suggested: false });
    expect(gradeChipLabel(view(null, "C"))).toEqual({ letter: "C", suggested: true });
  });
  it("the filter keeps one set grade, or the clients with none", () => {
    const rows = [{ id: "1", grade: view("A") }, { id: "2", grade: view(null) }, { id: "3", grade: view("C") }];
    expect(filterByGrade(rows, "all").map((r) => r.id)).toEqual(["1", "2", "3"]);
    expect(filterByGrade(rows, "A").map((r) => r.id)).toEqual(["1"]);
    expect(filterByGrade(rows, "none").map((r) => r.id)).toEqual(["2"]);
  });
});
