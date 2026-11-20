import { env } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";
import { getEntry, insertEntry, listEntriesForTask, runningEntry, type NewEntry } from "../src/worker/db/time";
import { saveSettings } from "../src/worker/db/settings";
import { insertTasks, type NewTask } from "../src/worker/db/tasks";
import { addManualEntry, capStaleTimers, startTimer, stopTimer, stopTimerFor, TimeStateError, weekGrid } from "../src/worker/time/service";
import { newTask, seedProject } from "./fixtures/projects";

const at = (iso: string) => new Date(iso);
const START = at("2026-12-03T17:00:00.000Z"); // 9:00 in Los Angeles
const plus = (d: Date, ms: number) => new Date(d.getTime() + ms);
const MIN = 60_000, HOUR = 3_600_000;

async function seed(o: Partial<NewTask> = {}) {
  const s = await seedProject({ bare: true });
  const [task] = await insertTasks(env.DB, [newTask(s.project.id, s.businessId, { title: "Build the page", billable: true, ...o })]);
  const more = async (extra: Partial<NewTask> = {}) => (await insertTasks(env.DB, [newTask(s.project.id, s.businessId, { position: 5, title: "Another", ...extra })]))[0];
  return { ...s, task, more };
}

beforeEach(async () => {
  await env.DB.prepare(`DELETE FROM time_entries`).run();
  await env.DB.prepare(`UPDATE settings SET work_config = '{}', booking_config = '{}' WHERE id = 1`).run();
});

describe("timers", () => {
  it("starting a second timer stops the first and saves both", async () => {
    const s = await seed();
    const other = await s.more();
    const a = await startTimer(env, s.task.id, START);
    expect(a.stopped).toBeNull();
    expect(a.entry).toMatchObject({ taskId: s.task.id, projectId: s.project.id, businessId: s.businessId, startedAt: START.toISOString(), endedAt: null, minutes: 0, billable: true, source: "timer" });
    const b = await startTimer(env, other.id, plus(START, 25 * MIN));
    expect(b.stopped).toMatchObject({ id: a.entry.id, minutes: 25, endedAt: plus(START, 25 * MIN).toISOString(), note: "" });
    expect(b.entry).toMatchObject({ taskId: other.id, endedAt: null, billable: false });
    expect((await runningEntry(env.DB))!.id).toBe(b.entry.id);
    const done = await stopTimer(env, plus(START, 85 * MIN));
    expect(done).toMatchObject({ id: b.entry.id, minutes: 60 });
    expect(await runningEntry(env.DB)).toBeNull();
    expect((await getEntry(env.DB, a.entry.id))!.minutes).toBe(25);
  });

  it("stopping rounds to the nearest minute and takes a note", async () => {
    const s = await seed();
    await startTimer(env, s.task.id, START);
    const e = await stopTimer(env, plus(START, 14 * MIN + 31_000), { note: "  wired up the form​ " });
    expect(e).toMatchObject({ minutes: 15, note: "wired up the form", endedAt: plus(START, 14 * MIN + 31_000).toISOString() });
    await startTimer(env, s.task.id, START);
    expect((await stopTimer(env, plus(START, 14 * MIN + 29_000)))!.minutes).toBe(14);
  });

  it("two timers started at the same moment: one starts, the other is refused, and one row is running", async () => {
    const s = await seed();
    const other = await s.more();
    const r = await Promise.allSettled([startTimer(env, s.task.id, START), startTimer(env, other.id, START)]);
    expect(r.filter((x) => x.status === "fulfilled")).toHaveLength(1);
    const lost = r.filter((x): x is PromiseRejectedResult => x.status === "rejected");
    expect(lost).toHaveLength(1);
    expect(lost[0].reason).toBeInstanceOf(TimeStateError);
    const n = await env.DB.prepare(`SELECT COUNT(*) AS n FROM time_entries WHERE ended_at IS NULL`).first<{ n: number }>();
    expect(n!.n).toBe(1);
    expect(await runningEntry(env.DB)).not.toBeNull();
    // and the same task twice
    await stopTimer(env, plus(START, 5 * MIN));
    const same = await Promise.allSettled([startTimer(env, s.task.id, START), startTimer(env, s.task.id, START)]);
    expect(same.map((x) => x.status).sort()).toEqual(["fulfilled", "rejected"]);
    expect((await env.DB.prepare(`SELECT COUNT(*) AS n FROM time_entries WHERE ended_at IS NULL`).first<{ n: number }>())!.n).toBe(1);
  });

  it("stopping with no timer running does nothing", async () => {
    expect(await stopTimer(env, START)).toBeNull();
  });

  it("a timer under 30 seconds is dropped", async () => {
    const s = await seed();
    const a = await startTimer(env, s.task.id, START);
    expect(await stopTimer(env, plus(START, 29_999))).toBeNull();
    expect(await getEntry(env.DB, a.entry.id)).toBeNull();
    expect(await runningEntry(env.DB)).toBeNull();
    await startTimer(env, s.task.id, START);
    expect(await stopTimer(env, plus(START, 30_000))).toMatchObject({ minutes: 1 });
    // starting another one right away also drops the first
    const first = await startTimer(env, s.task.id, START);
    const second = await startTimer(env, s.task.id, plus(START, 10_000));
    expect(second.stopped).toBeNull();
    expect(await getEntry(env.DB, first.entry.id)).toBeNull();
    expect((await runningEntry(env.DB))!.id).toBe(second.entry.id);
  });

  it("a timer left past the cap is saved at the cap with the note", async () => {
    const s = await seed();
    await startTimer(env, s.task.id, START);
    const e = await stopTimer(env, plus(START, 13 * HOUR));
    expect(e).toMatchObject({ minutes: 720, note: "stopped at the cap", endedAt: plus(START, 12 * HOUR).toISOString() });
    // exactly at the cap is not over it
    await startTimer(env, s.task.id, START);
    expect(await stopTimer(env, plus(START, 12 * HOUR))).toMatchObject({ minutes: 720, note: "" });
    // a note typed by the person is kept next to it, and a configured cap is honoured
    await saveSettings(env.DB, { work_config: JSON.stringify({ timerCapMinutes: 60 }) });
    await startTimer(env, s.task.id, START);
    expect(await stopTimer(env, plus(START, 2 * HOUR), { note: "design pass" })).toMatchObject({ minutes: 60, note: "design pass; stopped at the cap" });
  });

  it("starting a timer over a stale one saves it at the cap", async () => {
    const s = await seed();
    const a = await startTimer(env, s.task.id, START);
    const b = await startTimer(env, s.task.id, plus(START, 20 * HOUR));
    expect(b.stopped).toMatchObject({ id: a.entry.id, minutes: 720, note: "stopped at the cap" });
  });

  it("capStaleTimers stops a timer left over a weekend", async () => {
    const s = await seed();
    expect(await capStaleTimers(env, START)).toBe(0);
    const a = await startTimer(env, s.task.id, at("2026-12-04T23:00:00.000Z")); // Friday afternoon
    expect(await capStaleTimers(env, at("2026-12-05T02:00:00.000Z"))).toBe(0);
    expect(await runningEntry(env.DB)).not.toBeNull();
    expect(await capStaleTimers(env, at("2026-12-07T16:00:00.000Z"))).toBe(1);
    expect(await runningEntry(env.DB)).toBeNull();
    expect(await getEntry(env.DB, a.entry.id)).toMatchObject({ minutes: 720, note: "stopped at the cap", endedAt: "2026-12-05T11:00:00.000Z" });
    expect(await capStaleTimers(env, at("2026-12-07T16:00:00.000Z"))).toBe(0);
  });

  it("a timer cannot start on a done, skipped or locked task", async () => {
    for (const status of ["done", "skipped", "locked"] as const) {
      const s = await seed({ status });
      await expect(startTimer(env, s.task.id, START)).rejects.toThrow(TimeStateError);
      expect(await runningEntry(env.DB)).toBeNull();
    }
    await expect(startTimer(env, "no-such-task", START)).rejects.toThrow(TimeStateError);
    for (const status of ["todo", "in_progress", "in_review", "waiting_client"] as const) {
      const s = await seed({ status });
      await startTimer(env, s.task.id, START);
    }
  });

  it("a refused start leaves the running timer alone", async () => {
    const s = await seed();
    const locked = await s.more({ status: "locked" });
    const a = await startTimer(env, s.task.id, START);
    await expect(startTimer(env, locked.id, plus(START, 10 * MIN))).rejects.toThrow(TimeStateError);
    expect((await runningEntry(env.DB))!.id).toBe(a.entry.id);
  });

  it("stopTimerFor ignores another task's timer", async () => {
    const s = await seed();
    const other = await s.more();
    const a = await startTimer(env, s.task.id, START);
    expect(await stopTimerFor(env.DB, other.id, plus(START, 10 * MIN))).toBeNull();
    expect((await runningEntry(env.DB))!.id).toBe(a.entry.id);
    expect(await stopTimerFor(env.DB, s.task.id, plus(START, 10 * MIN))).toMatchObject({ id: a.entry.id, minutes: 10 });
    expect(await runningEntry(env.DB)).toBeNull();
    expect(await stopTimerFor(env.DB, s.task.id, plus(START, 20 * MIN))).toBeNull();
  });
});

describe("manual entries", () => {
  const NOW = at("2026-12-03T20:00:00.000Z"); // Thursday 12:00 in Los Angeles

  it("a manual entry starts at noon of its day in the zone, always has an end, and defaults billable to the task", async () => {
    const s = await seed();
    const e = await addManualEntry(env, { taskId: s.task.id, day: "2026-12-02", minutes: 90, note: "call with the owner" }, NOW);
    expect(e).toMatchObject({ source: "manual", startedAt: "2026-12-02T20:00:00.000Z", endedAt: "2026-12-02T21:30:00.000Z", minutes: 90, billable: true, note: "call with the owner" });
    const un = await seed({ billable: false });
    expect((await addManualEntry(env, { taskId: un.task.id, day: "2026-12-03", minutes: 15 }, NOW)).billable).toBe(false);
    expect((await addManualEntry(env, { taskId: un.task.id, day: "2026-12-03", minutes: 15, billable: true }, NOW)).billable).toBe(true);
    // summer noon in Los Angeles is 19:00Z
    expect((await addManualEntry(env, { taskId: s.task.id, day: "2026-07-01", minutes: 5 }, NOW)).startedAt).toBe("2026-07-01T19:00:00.000Z");
    // manual entries never take the running slot
    expect(await runningEntry(env.DB)).toBeNull();
  });

  it("a manual entry uses the booking time zone", async () => {
    await saveSettings(env.DB, { booking_config: JSON.stringify({ timezone: "Asia/Tokyo" }) });
    const s = await seed();
    expect((await addManualEntry(env, { taskId: s.task.id, day: "2026-12-04", minutes: 30 }, NOW)).startedAt).toBe("2026-12-04T03:00:00.000Z");
  });

  it("a manual entry refuses 0, 1441 minutes, a future day and a locked task", async () => {
    const s = await seed();
    const refuse = (o: { day?: string; minutes?: number; taskId?: string }) => expect(addManualEntry(env, { taskId: s.task.id, day: "2026-12-03", minutes: 30, ...o }, NOW)).rejects.toThrow(TimeStateError);
    await refuse({ minutes: 0 });
    await refuse({ minutes: 1441 });
    await refuse({ minutes: 1.5 });
    await refuse({ minutes: -5 });
    await refuse({ day: "2026-12-04" });
    await refuse({ day: "2026-13-01" });
    await refuse({ day: "12/03/2026" });
    await refuse({ taskId: "no-such-task" });
    const locked = await seed({ status: "locked" });
    await refuse({ taskId: locked.task.id });
    expect(await listEntriesForTask(env.DB, s.task.id)).toEqual([]);
    expect(await addManualEntry(env, { taskId: s.task.id, day: "2026-12-03", minutes: 1440 }, NOW)).toMatchObject({ minutes: 1440 });
    expect(await addManualEntry(env, { taskId: s.task.id, day: "2026-12-03", minutes: 1 }, NOW)).toMatchObject({ minutes: 1 });
  });

  it("today is the day in the zone, not in UTC", async () => {
    const s = await seed();
    // 03:00Z on the 4th is still the evening of the 3rd in Los Angeles
    const late = at("2026-12-04T03:00:00.000Z");
    expect((await addManualEntry(env, { taskId: s.task.id, day: "2026-12-03", minutes: 10 }, late)).minutes).toBe(10);
    await expect(addManualEntry(env, { taskId: s.task.id, day: "2026-12-04", minutes: 10 }, late)).rejects.toThrow(TimeStateError);
  });

  it("a manual entry on a done task is allowed", async () => {
    const s = await seed({ status: "done" });
    expect(await addManualEntry(env, { taskId: s.task.id, day: "2026-12-03", minutes: 20 }, NOW)).toMatchObject({ minutes: 20 });
  });
});

describe("weekGrid", () => {
  const manual = (s: Awaited<ReturnType<typeof seed>>, startedAt: string, minutes: number, taskId = s.task.id): NewEntry => ({
    taskId, projectId: s.project.id, businessId: s.businessId, startedAt, endedAt: plus(new Date(startedAt), minutes * MIN).toISOString(), minutes, billable: false, note: "", source: "manual",
  });
  const PT = { tz: "America/Los_Angeles" };

  it("an entry at 23:30 Sunday Pacific is in that week's Sunday column", async () => {
    const s = await seed();
    await insertEntry(env.DB, manual(s, "2026-12-07T07:30:00.000Z", 40)); // Sunday 6 Dec, 23:30 PST
    const g = await weekGrid(env.DB, { weekOf: "2026-12-03", weekStartsOn: 1, ...PT });
    expect(g.days).toEqual(["2026-11-30", "2026-12-01", "2026-12-02", "2026-12-03", "2026-12-04", "2026-12-05", "2026-12-06"]);
    expect(g.rows).toHaveLength(1);
    expect(g.rows[0].minutes).toEqual([0, 0, 0, 0, 0, 0, 40]);
    // and the next week's Monday column holds nothing of it
    const next = await weekGrid(env.DB, { weekOf: "2026-12-07", weekStartsOn: 1, ...PT });
    expect(next.total).toBe(0);
    expect(next.rows).toEqual([]);
  });

  it("weekStartsOn 0 and 1 give different columns for the same entries", async () => {
    const s = await seed();
    await insertEntry(env.DB, manual(s, "2026-12-06T20:00:00.000Z", 30)); // Sunday noon
    await insertEntry(env.DB, manual(s, "2026-12-07T20:00:00.000Z", 45)); // Monday noon
    const mon = await weekGrid(env.DB, { weekOf: "2026-12-07", weekStartsOn: 1, ...PT });
    expect(mon.days[0]).toBe("2026-12-07");
    expect(mon.rows[0].minutes).toEqual([45, 0, 0, 0, 0, 0, 0]);
    const sun = await weekGrid(env.DB, { weekOf: "2026-12-07", weekStartsOn: 0, ...PT });
    expect(sun.days[0]).toBe("2026-12-06");
    expect(sun.days[6]).toBe("2026-12-12");
    expect(sun.rows[0].minutes).toEqual([30, 45, 0, 0, 0, 0, 0]);
    // the day before a Monday week start belongs to the week before
    const prev = await weekGrid(env.DB, { weekOf: "2026-12-06", weekStartsOn: 1, ...PT });
    expect(prev.days[0]).toBe("2026-11-30");
    expect(prev.rows[0].minutes).toEqual([0, 0, 0, 0, 0, 0, 30]);
  });

  it("a week across the autumn clock change still has seven days", async () => {
    const s = await seed();
    // Clocks went back on Sunday 1 Nov 2026. 23:30 Sunday is 07:30Z Monday; 00:30 Sunday is 07:30Z Sunday (still PDT).
    await insertEntry(env.DB, manual(s, "2026-11-01T07:30:00.000Z", 10));
    await insertEntry(env.DB, manual(s, "2026-11-02T07:30:00.000Z", 20));
    await insertEntry(env.DB, manual(s, "2026-10-26T07:30:00.000Z", 5)); // Monday 00:30 PDT
    const g = await weekGrid(env.DB, { weekOf: "2026-10-28", weekStartsOn: 1, ...PT });
    expect(g.days).toEqual(["2026-10-26", "2026-10-27", "2026-10-28", "2026-10-29", "2026-10-30", "2026-10-31", "2026-11-01"]);
    expect(g.rows[0].minutes).toEqual([5, 0, 0, 0, 0, 0, 30]);
    const sunStart = await weekGrid(env.DB, { weekOf: "2026-11-01", weekStartsOn: 0, ...PT });
    expect(sunStart.days).toHaveLength(7);
    expect(sunStart.days[0]).toBe("2026-11-01");
    expect(sunStart.days[6]).toBe("2026-11-07");
    expect(sunStart.rows[0].minutes[0]).toBe(30);
    // and across the spring change
    const spring = await weekGrid(env.DB, { weekOf: "2026-03-08", weekStartsOn: 0, ...PT });
    expect(spring.days).toEqual(["2026-03-08", "2026-03-09", "2026-03-10", "2026-03-11", "2026-03-12", "2026-03-13", "2026-03-14"]);
  });

  it("totals add up by row, day and week", async () => {
    const s = await seed();
    const other = await s.more({ title: "Zeta task" });
    await insertEntry(env.DB, manual(s, "2026-12-01T20:00:00.000Z", 30));
    await insertEntry(env.DB, manual(s, "2026-12-01T22:00:00.000Z", 15));
    await insertEntry(env.DB, manual(s, "2026-12-03T20:00:00.000Z", 60));
    await insertEntry(env.DB, manual(s, "2026-12-03T21:00:00.000Z", 20, other.id));
    // a running timer is not time yet
    await insertEntry(env.DB, { ...manual(s, "2026-12-04T20:00:00.000Z", 0), source: "timer", endedAt: null });
    const g = await weekGrid(env.DB, { weekOf: "2026-12-02", weekStartsOn: 1, ...PT });
    expect(g.rows.map((r) => [r.title, r.minutes, r.total])).toEqual([
      ["Build the page", [0, 45, 0, 60, 0, 0, 0], 105],
      ["Zeta task", [0, 0, 0, 20, 0, 0, 0], 20],
    ]);
    expect(g.rows[0]).toMatchObject({ taskId: s.task.id, projectId: s.project.id, projectName: s.project.name });
    expect(g.dayTotals).toEqual([0, 45, 0, 80, 0, 0, 0]);
    expect(g.total).toBe(125);
    expect(g.dayTotals.reduce((a, b) => a + b, 0)).toBe(g.total);
    expect(g.rows.reduce((a, r) => a + r.total, 0)).toBe(g.total);
  });

  it("an empty week has seven zero days, and a bad date is refused", async () => {
    const g = await weekGrid(env.DB, { weekOf: "2026-12-03", weekStartsOn: 1, ...PT });
    expect(g).toEqual({ days: g.days, rows: [], dayTotals: [0, 0, 0, 0, 0, 0, 0], total: 0 });
    expect(g.days).toHaveLength(7);
    await expect(weekGrid(env.DB, { weekOf: "next week", weekStartsOn: 1, ...PT })).rejects.toThrow(TimeStateError);
  });
});
