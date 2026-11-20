import { SELF, env } from "cloudflare:test";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { getEntry, insertEntry, listEntriesForTask, runningEntry } from "../src/worker/db/time";
import { getTask, insertTasks, setTaskStatus, type NewTask } from "../src/worker/db/tasks";
import { saveSettings } from "../src/worker/db/settings";
import { newTask, resetProjectWork, seedProject } from "./fixtures/projects";

let cookie = "";
beforeAll(async () => {
  const r = await SELF.fetch("https://x/api/login", { method: "POST", body: JSON.stringify({ password: "test-pass" }), headers: { "content-type": "application/json" } });
  cookie = r.headers.get("set-cookie")!.split(";")[0];
});
let errors: ReturnType<typeof vi.spyOn>;
beforeEach(async () => {
  errors = vi.spyOn(console, "error").mockImplementation(() => {});
  await resetProjectWork();
  await env.DB.prepare(`UPDATE settings SET work_config = '{}', booking_config = '{}' WHERE id = 1`).run();
});
afterEach(() => errors.mockRestore());

const owner = (method: string, path: string, body?: unknown, auth = true) =>
  SELF.fetch(`https://x/api${path}`, { method, body: body === undefined ? undefined : JSON.stringify(body), headers: { ...(auth ? { cookie } : {}), "content-type": "application/json" } });
const json = async (method: string, path: string, body?: unknown) => { const r = await owner(method, path, body); return { status: r.status, body: await r.json<any>() }; };

async function seed(o: Partial<NewTask> = {}) {
  const s = await seedProject({ bare: true, name: "Ace: Website build" });
  const [task] = await insertTasks(env.DB, [newTask(s.project.id, s.businessId, { title: "Build the page", billable: true, ...o })]);
  return { ...s, task };
}
const yesterday = () => new Date(Date.now() - 86_400_000).toISOString().slice(0, 10);

describe("time routes", () => {
  it("every route is 401 without a session", async () => {
    const calls: [string, string, unknown?][] = [
      ["GET", "/time/running"], ["POST", "/tasks/x/timer/start"], ["POST", "/timer/stop"], ["POST", "/tasks/x/time", { day: "2026-12-01", minutes: 5 }],
      ["PATCH", "/time/x", { minutes: 5 }], ["DELETE", "/time/x"], ["GET", "/time/week?of=2026-12-03"],
    ];
    for (const [m, p, b] of calls) expect((await owner(m, p, b, false)).status, `${m} ${p}`).toBe(401);
  });

  it("timer start, running and stop", async () => {
    const s = await seed();
    expect((await json("GET", "/time/running")).body).toEqual({ entry: null });
    const started = await json("POST", `/tasks/${s.task.id}/timer/start`);
    expect(started.status).toBe(201);
    expect(started.body.stopped).toBeNull();
    expect(started.body.entry).toMatchObject({ taskId: s.task.id, projectId: s.project.id, endedAt: null, minutes: 0, billable: true, source: "timer" });
    const running = await json("GET", "/time/running");
    expect(running.body.entry).toMatchObject({ id: started.body.entry.id, taskTitle: "Build the page", projectName: "Ace: Website build" });
    // a second task's timer stops the first (dropped: under 30 seconds)
    const [other] = await insertTasks(env.DB, [newTask(s.project.id, s.businessId, { title: "Other", position: 1 })]);
    const second = await json("POST", `/tasks/${other.id}/timer/start`);
    expect(second.status).toBe(201);
    expect(second.body.stopped).toBeNull();
    expect((await runningEntry(env.DB))!.taskId).toBe(other.id);
    // age the running timer by 20 minutes, then stop
    await env.DB.prepare(`UPDATE time_entries SET started_at = ? WHERE ended_at IS NULL`).bind(new Date(Date.now() - 20 * 60_000).toISOString()).run();
    const stopped = await json("POST", "/timer/stop", { note: "wrapped up" });
    expect(stopped.status).toBe(200);
    expect(stopped.body.entry).toMatchObject({ taskId: other.id, minutes: 20, note: "wrapped up" });
    expect(await runningEntry(env.DB)).toBeNull();
    expect((await json("POST", "/timer/stop")).body).toEqual({ entry: null });
  });

  it("starting a timer on a done task is 409, and on an unknown task 404", async () => {
    const s = await seed();
    await setTaskStatus(env.DB, s.task.id, "done", { now: "2026-12-03T10:00:00.000Z" });
    const r = await json("POST", `/tasks/${s.task.id}/timer/start`);
    expect(r.status).toBe(409);
    expect(r.body.error).toMatch(/done/);
    expect(await runningEntry(env.DB)).toBeNull();
    expect((await json("POST", "/tasks/nope/timer/start")).status).toBe(404);
  });

  it("a manual entry is added, refuses bad numbers and a future day, and is allowed on a done task", async () => {
    const s = await seed();
    const ok = await json("POST", `/tasks/${s.task.id}/time`, { day: yesterday(), minutes: 45, note: "Phone call" });
    expect(ok.status).toBe(201);
    expect(ok.body.entry).toMatchObject({ taskId: s.task.id, minutes: 45, source: "manual", billable: true, note: "Phone call" });
    for (const bad of [{ minutes: 0 }, { minutes: 1441 }, { minutes: 1.5 }, { minutes: "5" }, { day: "soon" }, { day: "2026-02-30" }]) {
      const r = await json("POST", `/tasks/${s.task.id}/time`, { day: yesterday(), minutes: 5, ...bad });
      expect(r.status, JSON.stringify(bad)).toBe(400);
    }
    const future = await json("POST", `/tasks/${s.task.id}/time`, { day: "2099-01-01", minutes: 5 });
    expect(future.status).toBe(409);
    expect(future.body.error).toMatch(/not come yet/);
    await setTaskStatus(env.DB, s.task.id, "done", { now: "2026-12-03T10:00:00.000Z" });
    expect((await json("POST", `/tasks/${s.task.id}/time`, { day: yesterday(), minutes: 5, billable: false })).body.entry.billable).toBe(false);
    await setTaskStatus(env.DB, s.task.id, "locked", { now: "2026-12-03T10:00:00.000Z" });
    expect((await json("POST", `/tasks/${s.task.id}/time`, { day: yesterday(), minutes: 5 })).status).toBe(409);
    expect((await json("POST", "/tasks/nope/time", { day: yesterday(), minutes: 5 })).status).toBe(404);
    expect(await listEntriesForTask(env.DB, s.task.id)).toHaveLength(2);
  });

  it("a note that reads like a login or password is refused with a plain 400 on every route that takes a note, never echoed, and nothing is saved (M1)", async () => {
    const s = await seed();
    const secret = "admin password: hunter2hunter2";
    const textOf = (r: { body: unknown }) => JSON.stringify(r.body);
    // a manual entry
    const add = await json("POST", `/tasks/${s.task.id}/time`, { day: yesterday(), minutes: 5, note: `Site login: ${secret}` });
    expect(add.status).toBe(400);
    expect(add.body.error).toMatch(/login or password/);
    expect(textOf(add)).not.toContain("hunter2");
    expect(await listEntriesForTask(env.DB, s.task.id)).toEqual([]);
    // stopping a timer: the timer keeps running
    await json("POST", `/tasks/${s.task.id}/timer/start`);
    await env.DB.prepare(`UPDATE time_entries SET started_at = ? WHERE ended_at IS NULL`).bind(new Date(Date.now() - 20 * 60_000).toISOString()).run();
    const stop = await json("POST", "/timer/stop", { note: secret });
    expect(stop.status).toBe(400);
    expect(textOf(stop)).not.toContain("hunter2");
    expect(await runningEntry(env.DB)).not.toBeNull();
    expect((await json("POST", "/timer/stop", { note: "wrapped up" })).status).toBe(200);
    // an edit to a saved entry
    const [saved] = await listEntriesForTask(env.DB, s.task.id);
    const patch = await json("PATCH", `/time/${saved.id}`, { note: secret });
    expect(patch.status).toBe(400);
    expect(textOf(patch)).not.toContain("hunter2");
    expect((await getEntry(env.DB, saved.id))!.note).toBe("wrapped up");
    // a harmless note still saves
    expect((await json("PATCH", `/time/${saved.id}`, { note: "Where the login is kept: the 1Password item Ace hosting" })).status).toBe(200);
  });

  it("PATCH changes an entry, DELETE removes it, and an invoiced entry cannot be deleted (409)", async () => {
    const s = await seed();
    const mk = (o: { minutes: number }) => insertEntry(env.DB, { taskId: s.task.id, projectId: s.project.id, businessId: s.businessId, startedAt: "2026-12-03T17:00:00.000Z", endedAt: `2026-12-03T17:${String(o.minutes).padStart(2, "0")}:00.000Z`, minutes: o.minutes, billable: true, note: "", source: "manual" });
    const e = await mk({ minutes: 30 });
    const patched = await json("PATCH", `/time/${e.id}`, { minutes: 40, billable: false, note: "Fixed the header" });
    expect(patched.status).toBe(200);
    expect(patched.body.entry).toMatchObject({ id: e.id, minutes: 40, billable: false, note: "Fixed the header" });
    expect((await json("PATCH", `/time/${e.id}`, { minutes: 0 })).status).toBe(400);
    expect((await json("PATCH", `/time/${e.id}`, { minutes: 1441 })).status).toBe(400);
    expect((await json("PATCH", `/time/${e.id}`, {})).status).toBe(400);
    expect((await json("PATCH", `/time/${e.id}`, { startedAt: "yesterday" })).status).toBe(400);
    expect((await json("PATCH", "/time/nope", { minutes: 5 })).status).toBe(404);
    expect((await json("DELETE", `/time/${e.id}`)).body).toEqual({ ok: true });
    expect(await getEntry(env.DB, e.id)).toBeNull();
    expect((await json("DELETE", `/time/${e.id}`)).status).toBe(404);

    const billed = await mk({ minutes: 20 });
    await env.DB.prepare(`UPDATE time_entries SET invoiced_ref = 'INV-1' WHERE id = ?`).bind(billed.id).run();
    const del = await json("DELETE", `/time/${billed.id}`);
    expect(del.status).toBe(409);
    expect(del.body.error).toMatch(/invoiced/);
    expect((await json("PATCH", `/time/${billed.id}`, { minutes: 5 })).status).toBe(409);
    expect(await getEntry(env.DB, billed.id)).not.toBeNull();
  });

  describe("GET /time/week", () => {
    // Sunday 2026-12-06 at 23:30 in Los Angeles is 07:30 UTC on the 7th; Monday 2026-12-07 at 09:00 there is 17:00 UTC.
    async function entries() {
      const s = await seed();
      const add = (startedAt: string, minutes: number) => insertEntry(env.DB, { taskId: s.task.id, projectId: s.project.id, businessId: s.businessId, startedAt, endedAt: new Date(Date.parse(startedAt) + minutes * 60_000).toISOString(), minutes, billable: true, note: "", source: "manual" });
      await add("2026-12-07T07:30:00.000Z", 30);
      await add("2026-12-07T17:00:00.000Z", 60);
      return s;
    }

    it("week grid honours the configured week start", async () => {
      const s = await entries();
      const monday = await json("GET", "/time/week?of=2026-12-09");
      expect(monday.status).toBe(200);
      expect(monday.body.days).toEqual(["2026-12-07", "2026-12-08", "2026-12-09", "2026-12-10", "2026-12-11", "2026-12-12", "2026-12-13"]);
      expect(monday.body).toMatchObject({ tz: "America/Los_Angeles", weekStartsOn: 1, total: 60, dayTotals: [60, 0, 0, 0, 0, 0, 0] });
      expect(monday.body.rows).toEqual([{ taskId: s.task.id, projectId: s.project.id, projectName: "Ace: Website build", title: "Build the page", minutes: [60, 0, 0, 0, 0, 0, 0], total: 60 }]);

      await saveSettings(env.DB, { work_config: JSON.stringify({ weekStartsOn: 0 }) });
      const sunday = await json("GET", "/time/week?of=2026-12-09");
      expect(sunday.body.days[0]).toBe("2026-12-06");
      expect(sunday.body).toMatchObject({ weekStartsOn: 0, total: 90, dayTotals: [30, 60, 0, 0, 0, 0, 0] });
    });

    it("uses the booking time zone", async () => {
      await entries();
      await saveSettings(env.DB, { booking_config: JSON.stringify({ timezone: "America/New_York" }) });
      const r = await json("GET", "/time/week?of=2026-12-09");
      expect(r.body.tz).toBe("America/New_York");
      // 07:30 UTC on the 7th is 02:30 Monday in New York, so both entries fall on Monday there.
      expect(r.body.dayTotals).toEqual([90, 0, 0, 0, 0, 0, 0]);
    });

    it("validates the date and defaults to this week", async () => {
      for (const of of ["2026-13-01", "2026-02-30", "tomorrow", "12/03/2026", "", "2026-1-1"]) {
        const r = await json("GET", `/time/week?of=${encodeURIComponent(of)}`);
        expect(r.status, of).toBe(400);
        expect(r.body.error).toMatch(/date/);
      }
      const now = await json("GET", "/time/week");
      expect(now.status).toBe(200);
      expect(now.body.days).toHaveLength(7);
    });
  });
});
