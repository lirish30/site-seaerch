import { env } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";
import { listBatches, previousPeriodKey } from "../src/worker/batches/groups";
import { setGrade } from "../src/worker/db/grade";
import { placeHold } from "../src/worker/db/holds";
import { setProjectStatus } from "../src/worker/db/projects";
import { saveSettings } from "../src/worker/db/settings";
import { ensureSeedSops } from "../src/worker/db/sops";
import { insertTasks, type NewTask } from "../src/worker/db/tasks";
import type { TaskStatus } from "../src/worker/sop/model";
import { seedClient } from "./fixtures/clients";
import { newTask, resetProjectWork } from "./fixtures/projects";

// Thursday 19 November 2026, 14:00 in Los Angeles: ISO week 47 (Monday 16 November). CARE-1 is the weekly update (due Wednesday), CARE-4 the monthly report.
const NOW = new Date("2026-11-19T22:00:00.000Z");
const W47 = "2026-W47";
const W46 = "2026-W46";

beforeEach(async () => {
  await env.DB.batch(["billing_holds", "invoice_nudges", "invoices", "subscriptions"].map((t) => env.DB.prepare(`DELETE FROM ${t}`)));
  await resetProjectWork();
  await ensureSeedSops(env.DB);
  await env.DB.prepare(`UPDATE sop_templates SET active = 1`).run();
  await saveSettings(env.DB, { booking_config: "{}" });
});

type TaskSpec = Partial<NewTask> & { status?: TaskStatus };
/** A real client named `name` (grade `grade`) with a recurring task per spec, by default the weekly update of week 47. */
async function client(name: string, o: { grade?: "A" | "B" | "C"; test?: boolean; invoice?: boolean; tasks?: TaskSpec[] } = {}) {
  const s = await seedClient({ test: o.test, invoice: o.invoice ? { cents: 50_000 } : undefined });
  await env.DB.prepare(`UPDATE businesses SET name = ? WHERE id = ?`).bind(name, s.businessId).run();
  if (o.grade) await setGrade(env.DB, s.businessId, o.grade, "", NOW.toISOString());
  const specs = o.tasks ?? [{}];
  const rows = await insertTasks(env.DB, specs.map((t, i) => newTask(s.project!.id, s.businessId, {
    isStep: false, stepKey: null, position: i, title: `${name} task`, cadenceKey: "CARE-1", periodKey: W47, dueOn: "2026-11-18", estMinutes: 37, ...t,
  })));
  return { ...s, tasks: rows };
}
const groupOf = async (key = "CARE-1", period = W47, now = NOW) => (await listBatches(env.DB, now)).find((g) => g.templateKey === key && g.period === period);

describe("the batch board", () => {
  it("groups tasks of one template and period across clients with open, done and estimate totals", async () => {
    await client("Bay Roofing", { tasks: [{ estMinutes: 30, checklist: [{ text: "a", done: true }, { text: "b", done: false }, { text: "c", done: false }] }] });
    await client("Ace Plumbing", { tasks: [{ estMinutes: 45, status: "in_progress" }] });
    await client("Cove Dental", { tasks: [{ estMinutes: 20, status: "done" }] });
    await client("Dune Cafe", { tasks: [{ estMinutes: 15, status: "skipped" }] });
    const groups = await listBatches(env.DB, NOW);
    expect(groups).toHaveLength(1);
    const g = groups[0];
    expect(g).toMatchObject({ templateKey: "CARE-1", name: "Care weekly update", cadence: "weekly", period: W47, label: "Week of Nov 16", dueOn: "2026-11-18", open: 2, done: 1, estMinutes: 75 });
    expect(g.tasks.map((t) => [t.client, t.status])).toEqual([["Ace Plumbing", "in_progress"], ["Bay Roofing", "todo"], ["Cove Dental", "done"], ["Dune Cafe", "skipped"]]);
    expect(g.tasks.find((t) => t.client === "Bay Roofing")).toMatchObject({ checklistDone: 1, checklistTotal: 3, estMinutes: 30, dueOn: "2026-11-18", held: false, grade: null });
  });

  it("the previous period shows only while it has an open task", async () => {
    await client("Ace Plumbing", { tasks: [{ periodKey: W46, dueOn: "2026-11-11", status: "in_review" }, { periodKey: W47 }] });
    expect((await listBatches(env.DB, NOW)).map((g) => [g.period, g.open])).toEqual([[W46, 1], [W47, 1]]); // the older due date first
    await env.DB.prepare(`UPDATE tasks SET status = 'done' WHERE period_key = ?`).bind(W46).run();
    expect((await listBatches(env.DB, NOW)).map((g) => g.period)).toEqual([W47]);
    await env.DB.prepare(`UPDATE tasks SET status = 'skipped' WHERE period_key = ?`).bind(W46).run();
    expect((await listBatches(env.DB, NOW)).map((g) => g.period)).toEqual([W47]); // skipped is not open
    // Two periods back is never shown, open or not.
    await env.DB.prepare(`UPDATE tasks SET period_key = '2026-W45', status = 'todo' WHERE period_key = ?`).bind(W46).run();
    expect((await listBatches(env.DB, NOW)).map((g) => g.period)).toEqual([W47]);
  });

  it("a test client, a paused project and a client on hold are left out or flagged held as the filter says (held is shown with held true, test and paused are absent)", async () => {
    await client("Real Co");
    await client("Rehearsal Co", { test: true });
    const paused = await client("Paused Co");
    await setProjectStatus(env.DB, paused.project!.id, "paused", { reason: "waiting" });
    const held = await client("Held Co", { invoice: true });
    expect(await placeHold(env.DB, { businessId: held.businessId, invoiceId: held.invoice!.id, now: NOW.toISOString() })).toBe(true);
    const g = (await groupOf())!;
    expect(g.tasks.map((t) => [t.client, t.held])).toEqual([["Held Co", true], ["Real Co", false]]);
    expect(g.open).toBe(2);
  });

  it("a template switched off is absent", async () => {
    await client("Ace Plumbing");
    await env.DB.prepare(`UPDATE sop_templates SET active = 0 WHERE key = 'CARE-1'`).run();
    expect(await listBatches(env.DB, NOW)).toEqual([]);
  });

  it("tasks sort grade A first then name, no-grade last", async () => {
    await client("Zed", { grade: "A" });
    await client("Ann", { grade: "C" });
    await client("Bob");
    await client("Amy");
    await client("Yan", { grade: "A" });
    await client("Cy", { grade: "B" });
    const g = (await groupOf())!;
    expect(g.tasks.map((t) => `${t.grade ?? "-"} ${t.client}`)).toEqual(["A Yan", "A Zed", "B Cy", "C Ann", "- Amy", "- Bob"]);
  });

  it("groups are ordered by their earliest due date, a group with no date last", async () => {
    await client("Ace Plumbing", { tasks: [{ cadenceKey: "CARE-1", dueOn: "2026-11-18" }, { cadenceKey: "CARE-4", periodKey: "2026-11", dueOn: "2026-11-05" }] });
    await client("Bay Roofing", { tasks: [{ cadenceKey: "CARE-4", periodKey: "2026-11", dueOn: null }] });
    expect((await listBatches(env.DB, NOW)).map((g) => [g.templateKey, g.dueOn])).toEqual([["CARE-4", "2026-11-05"], ["CARE-1", "2026-11-18"]]);
  });

  it("the period rolls over at the booking zone's midnight, not UTC", async () => {
    await client("Ace Plumbing", { tasks: [{ periodKey: W47 }, { periodKey: "2026-W48", dueOn: "2026-11-25" }] });
    // Sunday 22 November 23:30 in Los Angeles is already Monday in UTC: the board still shows week 47 (and not week 48).
    const sundayNight = new Date("2026-11-23T07:30:00.000Z");
    expect((await listBatches(env.DB, sundayNight)).map((g) => g.period)).toEqual([W47]);
    // Half an hour past local midnight it is week 48; week 47 is still there while its task is open.
    const mondayMorning = new Date("2026-11-23T08:30:00.000Z");
    expect((await listBatches(env.DB, mondayMorning)).map((g) => g.period)).toEqual([W47, "2026-W48"]);
    // The booking zone is the one in the settings.
    await saveSettings(env.DB, { booking_config: JSON.stringify({ timezone: "Pacific/Auckland" }) });
    expect((await listBatches(env.DB, sundayNight)).map((g) => g.period)).toEqual([W47, "2026-W48"]);
  });

  it("a client with no task this period is simply absent", async () => {
    await client("Has Task");
    await client("No Task This Week", { tasks: [{ periodKey: "2026-W40", status: "done" }] });
    await client("No Task At All", { tasks: [] });
    const g = (await groupOf())!;
    expect(g.tasks.map((t) => t.client)).toEqual(["Has Task"]);
  });

  it("a template with no task in the period has no group", async () => {
    expect(await listBatches(env.DB, NOW)).toEqual([]);
  });

  it("previousPeriodKey steps back one period across a month, quarter, year and ISO year", () => {
    const tz = "America/Los_Angeles";
    expect(previousPeriodKey("weekly", NOW, tz)).toBe(W46);
    expect(previousPeriodKey("weekly", new Date("2027-01-05T20:00:00.000Z"), tz)).toBe("2026-W53"); // 2026 has 53 ISO weeks
    expect(previousPeriodKey("monthly", new Date("2027-01-15T20:00:00.000Z"), tz)).toBe("2026-12");
    expect(previousPeriodKey("quarterly", new Date("2027-01-15T20:00:00.000Z"), tz)).toBe("2026-Q4");
    expect(previousPeriodKey("quarterly", NOW, tz)).toBe("2026-Q3");
    expect(previousPeriodKey("annual", NOW, tz)).toBe("2025");
  });
});
