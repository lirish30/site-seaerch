import { env } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";
import { capacityWarning, computeCapacity, NEAR_AT, REVIEW_SHARE } from "../src/worker/capacity/compute";
import { placeHold } from "../src/worker/db/holds";
import { setProjectStatus } from "../src/worker/db/projects";
import { saveSettings } from "../src/worker/db/settings";
import { insertTasks, type NewTask } from "../src/worker/db/tasks";
import { seedClient } from "./fixtures/clients";
import { newTask, resetProjectWork, seedProject } from "./fixtures/projects";

// Wednesday 2 December 2026, 10:00 in Los Angeles. This week's Monday is 2026-11-30.
const NOW = new Date("2026-12-02T18:00:00.000Z");
const MON = "2026-11-30";

beforeEach(async () => {
  await env.DB.batch(["billing_holds", "invoice_nudges", "invoices", "subscriptions"].map((t) => env.DB.prepare(`DELETE FROM ${t}`)));
  await resetProjectWork();
  await saveSettings(env.DB, { work_config: "{}" });
});

async function addTasks(projectId: string, businessId: string, specs: Partial<NewTask>[]) {
  await insertTasks(env.DB, specs.map((s, i) => newTask(projectId, businessId, { position: i, stepKey: `s${i}`, ...s })));
}
const week = async (i: number, now = NOW) => (await computeCapacity(env.DB, now)).weeks[i];

describe("capacity booked time", () => {
  it("a task you own counts in full in the week of its due date", async () => {
    const p = await seedProject();
    await addTasks(p.project.id, p.businessId, [{ owner: "logan", estMinutes: 90, dueOn: "2026-12-03" }, { owner: "logan", estMinutes: 30, dueOn: "2026-12-09", status: "in_progress" }]);
    const cap = await computeCapacity(env.DB, NOW);
    expect(cap.weeks.map((w) => w.monday)).toEqual([MON, "2026-12-07", "2026-12-14", "2026-12-21"]);
    expect(cap.weeks.map((w) => w.bookedMinutes)).toEqual([90, 30, 0, 0]);
    expect(cap.weeks.every((w) => w.limitMinutes === 1200)).toBe(true);
    expect(cap.carryOverMinutes).toBe(0);
  });

  it("a claude_drafts task counts 25%", async () => {
    expect(REVIEW_SHARE).toBe(0.25);
    const p = await seedProject();
    await addTasks(p.project.id, p.businessId, [{ owner: "claude_drafts", estMinutes: 60, dueOn: "2026-12-03", status: "in_review" }, { owner: "claude_drafts", estMinutes: 40, dueOn: "2026-12-04" }]);
    expect((await week(0)).bookedMinutes).toBe(25);
  });

  it("claude-owned, waiting_client, done, skipped and locked tasks count nothing", async () => {
    const p = await seedProject();
    await addTasks(p.project.id, p.businessId, [
      { owner: "claude", estMinutes: 60, dueOn: "2026-12-03" },
      { owner: "logan", estMinutes: 60, dueOn: "2026-12-03", status: "waiting_client" },
      { owner: "logan", estMinutes: 60, dueOn: "2026-12-03", status: "done" },
      { owner: "logan", estMinutes: 60, dueOn: "2026-12-03", status: "skipped" },
      { owner: "logan", estMinutes: 60, dueOn: "2026-12-03", status: "locked" },
      { owner: "logan", estMinutes: 10, dueOn: "2026-12-03" },
    ]);
    expect((await week(0)).bookedMinutes).toBe(10);
  });

  it("no due date counts nothing", async () => {
    const p = await seedProject();
    await addTasks(p.project.id, p.businessId, [{ owner: "logan", estMinutes: 60, dueOn: null }]);
    expect((await computeCapacity(env.DB, NOW)).weeks.map((w) => w.bookedMinutes)).toEqual([0, 0, 0, 0]);
  });

  it("an overdue task lands in this week and in carryOverMinutes", async () => {
    const p = await seedProject();
    await addTasks(p.project.id, p.businessId, [{ owner: "logan", estMinutes: 45, dueOn: "2026-11-20" }, { owner: "claude_drafts", estMinutes: 80, dueOn: "2026-11-29", status: "in_review" }, { owner: "logan", estMinutes: 15, dueOn: "2026-12-01" }]);
    const cap = await computeCapacity(env.DB, NOW);
    expect(cap.weeks[0].bookedMinutes).toBe(45 + 20 + 15);
    expect(cap.carryOverMinutes).toBe(45 + 20);
  });

  it("work due beyond the four weeks is not counted", async () => {
    const p = await seedProject();
    await addTasks(p.project.id, p.businessId, [{ owner: "logan", estMinutes: 45, dueOn: "2026-12-28" }, { owner: "logan", estMinutes: 20, dueOn: "2026-12-27" }]);
    expect((await computeCapacity(env.DB, NOW)).weeks.map((w) => w.bookedMinutes)).toEqual([0, 0, 0, 20]);
  });

  it("a paused project, a cancelled project, a test project and a task of a client on a billing hold count nothing", async () => {
    const spec = [{ owner: "logan" as const, estMinutes: 60, dueOn: "2026-12-03" }];
    const paused = await seedProject();
    await addTasks(paused.project.id, paused.businessId, spec);
    await setProjectStatus(env.DB, paused.project.id, "paused", { reason: "waiting" });
    const cancelled = await seedProject();
    await addTasks(cancelled.project.id, cancelled.businessId, spec);
    await setProjectStatus(env.DB, cancelled.project.id, "cancelled");
    const test = await seedProject({ test: true });
    await addTasks(test.project.id, test.businessId, spec);
    const held = await seedClient({ invoice: { cents: 50_000 } });
    await addTasks(held.project!.id, held.businessId, spec);
    expect((await week(0)).bookedMinutes).toBe(60); // the held client's task still counts: no hold yet
    expect(await placeHold(env.DB, { businessId: held.businessId, invoiceId: held.invoice!.id, now: NOW.toISOString() })).toBe(true);
    expect((await week(0)).bookedMinutes).toBe(0);
  });

  it("the Monday boundary uses the booking zone: a task due Sunday 23:30 local is last week even when it is Monday in UTC", async () => {
    const p = await seedProject();
    await addTasks(p.project.id, p.businessId, [{ owner: "logan", estMinutes: 60, dueOn: "2026-11-29" }, { owner: "logan", estMinutes: 30, dueOn: "2026-11-30" }]);
    // Sunday 29 November 23:30 in Los Angeles is Monday 30 November 07:30 UTC.
    const sundayNight = new Date("2026-11-30T07:30:00.000Z");
    const before = await computeCapacity(env.DB, sundayNight);
    expect(before.weeks[0].monday).toBe("2026-11-23");
    expect(before.weeks.map((w) => w.bookedMinutes)).toEqual([60, 30, 0, 0]);
    expect(before.carryOverMinutes).toBe(0);
    // Half an hour later it is Monday here too: the Sunday task is now a week behind.
    const after = await computeCapacity(env.DB, new Date("2026-11-30T08:00:00.000Z"));
    expect(after.weeks[0].monday).toBe(MON);
    expect(after.weeks.map((w) => w.bookedMinutes)).toEqual([90, 0, 0, 0]);
    expect(after.carryOverMinutes).toBe(60);
  });
});

describe("capacity state and sentence", () => {
  it("state is near at 80% of the limit and over at 100%", async () => {
    expect(NEAR_AT).toBe(0.8);
    const p = await seedProject();
    expect((await computeCapacity(env.DB, NOW)).state).toBe("ok");
    await addTasks(p.project.id, p.businessId, [{ owner: "logan", estMinutes: 959, dueOn: "2026-12-03" }]); // 16 h is 960 of 1200
    expect((await computeCapacity(env.DB, NOW)).state).toBe("ok");
    await env.DB.prepare(`UPDATE tasks SET est_minutes = 600 WHERE project_id = ?`).bind(p.project.id).run();
    await addTasks(p.project.id, p.businessId, [{ owner: "logan", estMinutes: 360, dueOn: "2026-12-03", position: 9, stepKey: "x1" }]);
    expect((await computeCapacity(env.DB, NOW)).state).toBe("near"); // exactly 960
    await addTasks(p.project.id, p.businessId, [{ owner: "logan", estMinutes: 239, dueOn: "2026-12-03", position: 10, stepKey: "x2" }]);
    expect((await computeCapacity(env.DB, NOW)).state).toBe("near"); // 1199
    await addTasks(p.project.id, p.businessId, [{ owner: "logan", estMinutes: 1, dueOn: "2026-12-03", position: 11, stepKey: "x3" }]);
    expect((await computeCapacity(env.DB, NOW)).state).toBe("over"); // 1200
  });

  it("state looks at next week too, and the weeks after next do not count", async () => {
    const p = await seedProject();
    await addTasks(p.project.id, p.businessId, [{ owner: "logan", estMinutes: 1300, dueOn: "2026-12-16" }]);
    expect((await computeCapacity(env.DB, NOW)).state).toBe("ok");
    await addTasks(p.project.id, p.businessId, [{ owner: "logan", estMinutes: 1000, dueOn: "2026-12-08", position: 9, stepKey: "n1" }]);
    expect((await computeCapacity(env.DB, NOW)).state).toBe("near");
  });

  it("the sentence reads like 'This week is 14 of 20 hours booked; next week 23 of 20.'", async () => {
    const p = await seedProject();
    await addTasks(p.project.id, p.businessId, [{ owner: "logan", estMinutes: 840, dueOn: "2026-12-03" }, { owner: "logan", estMinutes: 1380, dueOn: "2026-12-08" }]);
    expect((await computeCapacity(env.DB, NOW)).sentence).toBe("This week is 14 of 20 hours booked; next week 23 of 20.");
    await saveSettings(env.DB, { work_config: JSON.stringify({ weeklyHoursLimit: 30 }) });
    const cap = await computeCapacity(env.DB, NOW);
    expect(cap.sentence).toBe("This week is 14 of 30 hours booked; next week 23 of 30.");
    expect(cap.weeks[0].limitMinutes).toBe(1800);
  });
});

describe("capacity clients", () => {
  it("clients.count counts real live clients only (active or past due subscription, or a live project), never a test client", async () => {
    expect((await computeCapacity(env.DB, NOW)).clients).toEqual({ count: 0, limit: 45 });
    await seedClient({ project: false, subs: [{ monthlyCents: 5000 }] }); // active subscription only
    await seedClient({ project: false, subs: [{ monthlyCents: 5000, status: "past_due" }] });
    await seedClient({ subs: [] }); // a live project only
    await seedClient({ project: false, subs: [{ monthlyCents: 5000, status: "cancelled" }] }); // nothing live
    await seedClient({ test: true, subs: [{ monthlyCents: 5000 }] }); // a rehearsal
    const paused = await seedClient({ subs: [] });
    await setProjectStatus(env.DB, paused.project!.id, "paused", { reason: "x" });
    const two = await seedClient({ subs: [{ monthlyCents: 5000 }] }); // a project and a subscription are still one client
    expect(two.businessId).toBeTruthy();
    expect((await computeCapacity(env.DB, NOW)).clients.count).toBe(4);
    await saveSettings(env.DB, { work_config: JSON.stringify({ clientLimit: 60 }) });
    expect((await computeCapacity(env.DB, NOW)).clients).toEqual({ count: 4, limit: 60 });
  });
});

describe("capacityWarning", () => {
  it("names the week and the hours and is null when there is room", async () => {
    const p = await seedProject();
    await addTasks(p.project.id, p.businessId, [{ owner: "logan", estMinutes: 600, dueOn: "2026-12-03" }, { owner: "logan", estMinutes: 840, dueOn: "2026-12-08" }]);
    expect(await capacityWarning(env.DB, NOW, 0)).toBeNull();
    expect(await capacityWarning(env.DB, NOW, 300)).toBeNull(); // 19 of 20
    expect(await capacityWarning(env.DB, NOW, 600)).toBe("Heads up: next week would be 24 of 20 hours booked.");
    await addTasks(p.project.id, p.businessId, [{ owner: "logan", estMinutes: 600, dueOn: "2026-12-04", position: 9, stepKey: "w1" }]);
    expect(await capacityWarning(env.DB, NOW, 0)).toBe("Heads up: this week is already 20 of 20 hours booked.");
    expect(await capacityWarning(env.DB, NOW, 600)).toBe("Heads up: this week is already 20 of 20 hours booked, and next week would be 24 of 20.");
  });
});
