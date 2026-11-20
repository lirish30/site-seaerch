import { env } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";
import { commitTimer, deleteEntry, getEntry, insertEntry, listEntriesBetween, listEntriesForTask, patchEntry, runningEntry, timeTotals, TimeStateError, type NewEntry } from "../src/worker/db/time";
import { insertTasks } from "../src/worker/db/tasks";
import { newTask, seedProject } from "./fixtures/projects";

const T0 = "2026-12-03T17:00:00.000Z";

async function seed() {
  const s = await seedProject({ bare: true });
  const [task] = await insertTasks(env.DB, [newTask(s.project.id, s.businessId, { title: "Write the home page" })]);
  const entry = (o: Partial<NewEntry> = {}): NewEntry => ({
    taskId: task.id, projectId: s.project.id, businessId: s.businessId, startedAt: T0, endedAt: "2026-12-03T17:30:00.000Z", minutes: 30, billable: false, note: "", source: "timer", ...o,
  });
  return { ...s, task, entry };
}

beforeEach(async () => { await env.DB.prepare(`DELETE FROM time_entries`).run(); });

describe("time entries", () => {
  it("an entry is stored and read back with its fields", async () => {
    const s = await seed();
    const e = await insertEntry(env.DB, s.entry({ billable: true, note: "first pass" }));
    expect(e).toMatchObject({ taskId: s.task.id, projectId: s.project.id, businessId: s.businessId, startedAt: T0, endedAt: "2026-12-03T17:30:00.000Z", minutes: 30, billable: true, note: "first pass", source: "timer", invoicedRef: null });
    expect(e.createdAt).toMatch(/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/);
    expect(await getEntry(env.DB, e.id)).toEqual(e);
    expect(await getEntry(env.DB, "nope")).toBeNull();
    expect(await listEntriesForTask(env.DB, s.task.id)).toEqual([e]);
  });

  it("the unique index allows one running entry and a second insert is refused", async () => {
    const s = await seed();
    expect(await runningEntry(env.DB)).toBeNull();
    const running = await insertEntry(env.DB, s.entry({ endedAt: null, minutes: 0 }));
    expect((await runningEntry(env.DB))!.id).toBe(running.id);
    await expect(insertEntry(env.DB, s.entry({ endedAt: null, minutes: 0 }))).rejects.toThrow();
    // stopped entries are not limited
    await insertEntry(env.DB, s.entry());
    await insertEntry(env.DB, s.entry());
  });

  it("a start that loses the race for the timer slot fails whole and leaves the stop undone", async () => {
    const s = await seed();
    const running = await insertEntry(env.DB, s.entry({ endedAt: null, minutes: 0 }));
    // a stop plan for a different entry, so the insert collides with the running one: the batch must roll back
    const other = await insertEntry(env.DB, s.entry({ endedAt: "2026-12-03T18:00:00.000Z" }));
    await expect(commitTimer(env.DB, { stop: { id: other.id, drop: true }, start: s.entry({ endedAt: null, minutes: 0 }) })).rejects.toThrow(TimeStateError);
    expect(await getEntry(env.DB, other.id)).not.toBeNull();
    expect((await runningEntry(env.DB))!.id).toBe(running.id);
  });

  it("an invoiced entry cannot be edited or deleted", async () => {
    const s = await seed();
    const e = await insertEntry(env.DB, s.entry());
    await env.DB.prepare(`UPDATE time_entries SET invoiced_ref = 'inv-1' WHERE id = ?`).bind(e.id).run();
    await expect(patchEntry(env.DB, e.id, { minutes: 45 })).rejects.toThrow(TimeStateError);
    await expect(patchEntry(env.DB, e.id, { note: "x" })).rejects.toThrow(/invoiced/i);
    await expect(deleteEntry(env.DB, e.id)).rejects.toThrow(TimeStateError);
    expect(await getEntry(env.DB, e.id)).toMatchObject({ minutes: 30, note: "", invoicedRef: "inv-1" });
  });

  it("an entry is edited and deleted while it is not invoiced", async () => {
    const s = await seed();
    const e = await insertEntry(env.DB, s.entry());
    const p = await patchEntry(env.DB, e.id, { minutes: 45, billable: true, note: "  longer\u200b  " });
    expect(p).toMatchObject({ minutes: 45, billable: true, note: "longer" });
    await expect(patchEntry(env.DB, e.id, { minutes: 0 })).rejects.toThrow(TimeStateError);
    await expect(patchEntry(env.DB, e.id, { minutes: 1441 })).rejects.toThrow(TimeStateError);
    await expect(patchEntry(env.DB, e.id, { minutes: 1.5 })).rejects.toThrow(TimeStateError);
    await expect(patchEntry(env.DB, "nope", { minutes: 5 })).rejects.toThrow(TimeStateError);
    await deleteEntry(env.DB, e.id);
    expect(await getEntry(env.DB, e.id)).toBeNull();
    await deleteEntry(env.DB, e.id);
  });

  it("moving an entry to another start keeps its length, and a running timer's minutes are not edited", async () => {
    const s = await seed();
    const e = await insertEntry(env.DB, s.entry());
    const moved = await patchEntry(env.DB, e.id, { startedAt: "2026-12-02T17:00:00.000Z" });
    expect(moved).toMatchObject({ startedAt: "2026-12-02T17:00:00.000Z", endedAt: "2026-12-02T17:30:00.000Z" });
    await expect(patchEntry(env.DB, e.id, { startedAt: "yesterday" })).rejects.toThrow(TimeStateError);
    const running = await insertEntry(env.DB, s.entry({ endedAt: null, minutes: 0 }));
    await expect(patchEntry(env.DB, running.id, { minutes: 10 })).rejects.toThrow(TimeStateError);
    expect(await patchEntry(env.DB, running.id, { note: "ok" })).toMatchObject({ note: "ok", endedAt: null });
  });

  it("listEntriesBetween names the task and project and takes the half-open range", async () => {
    const s = await seed();
    const a = await insertEntry(env.DB, s.entry({ startedAt: "2026-12-03T10:00:00.000Z" }));
    const b = await insertEntry(env.DB, s.entry({ startedAt: "2026-12-03T12:00:00.000Z" }));
    await insertEntry(env.DB, s.entry({ startedAt: "2026-12-04T00:00:00.000Z" }));
    const rows = await listEntriesBetween(env.DB, "2026-12-03T00:00:00.000Z", "2026-12-04T00:00:00.000Z");
    expect(rows.map((r) => r.id)).toEqual([a.id, b.id]);
    expect(rows[0]).toMatchObject({ title: "Write the home page", projectName: s.project.name });
  });

  it("timeTotals adds actual and billable minutes by task or project", async () => {
    const s = await seed();
    const [other] = await insertTasks(env.DB, [newTask(s.project.id, s.businessId, { title: "Other", position: 1 })]);
    await insertEntry(env.DB, s.entry({ minutes: 30, billable: true }));
    await insertEntry(env.DB, s.entry({ minutes: 15 }));
    await insertEntry(env.DB, s.entry({ taskId: other.id, minutes: 60, billable: true }));
    expect(await timeTotals(env.DB, { taskId: s.task.id })).toEqual({ actualMinutes: 45, billableMinutes: 30 });
    expect(await timeTotals(env.DB, { projectId: s.project.id })).toEqual({ actualMinutes: 105, billableMinutes: 90 });
    expect(await timeTotals(env.DB, { taskId: "nope" })).toEqual({ actualMinutes: 0, billableMinutes: 0 });
  });
});
