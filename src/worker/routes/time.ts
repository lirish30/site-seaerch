import { Hono } from "hono";
import { z } from "zod";
import { dayKey } from "../booking/slots";
import { parseConfig } from "../booking/config";
import { getProject } from "../db/projects";
import { getSettings } from "../db/settings";
import { getTask } from "../db/tasks";
import { deleteEntry, getEntry, patchEntry, runningEntry } from "../db/time";
import type { Env } from "../env";
import { bodyOf, NOT_FOUND, ownerOnError } from "../projects/http";
import { parseWorkConfig } from "../time/config";
import { addManualEntry, isCalendarDate, startTimer, stopTimer, weekGrid } from "../time/service";

/** Mounted at /api: /time..., /timer/stop, /tasks/:id/timer/start, /tasks/:id/time (behind requireAuth). */
export const timeRoutes = new Hono<{ Bindings: Env }>();
timeRoutes.onError(ownerOnError);

const DAY = z.string().refine(isCalendarDate, "A day must be a real date like 2026-12-03.");
const MINUTES = z.number("Minutes must be a number.").int("Minutes must be a whole number.").min(1, "Minutes must be 1 or more.").max(1440, "Minutes must be 1440 or fewer.");
const NOTE = z.string().max(5000);
const isStart = (s: string) => /^\d{4}-\d\d-\d\dT/.test(s) && Number.isFinite(Date.parse(s));

/** The timer that is running now (there is at most one in the whole app), with its task and project, or null. */
timeRoutes.get("/time/running", async (c) => {
  const entry = await runningEntry(c.env.DB);
  if (!entry) return c.json({ entry: null });
  const [task, project] = await Promise.all([getTask(c.env.DB, entry.taskId), getProject(c.env.DB, entry.projectId)]);
  return c.json({ entry: { ...entry, taskTitle: task?.title ?? "", projectName: project?.name ?? "" } });
});

/** Starts a timer on the task; one that was running is saved first (`stopped`, null when it was too short to keep). */
timeRoutes.post("/tasks/:id/timer/start", async (c) => {
  const task = await getTask(c.env.DB, c.req.param("id"));
  if (!task) return c.json(NOT_FOUND, 404);
  const { entry, stopped } = await startTimer(c.env, task.id, new Date());
  return c.json({ entry, stopped }, 201);
});

/** Stops the running timer. `entry` is the saved entry, or null when nothing was running or it was under 30 seconds. */
timeRoutes.post("/timer/stop", async (c) => {
  const body = await bodyOf(c, z.object({ note: NOTE.optional() }).strict());
  if (body instanceof Response) return body;
  return c.json({ entry: await stopTimer(c.env, new Date(), { note: body.note }) });
});

/** Time typed in after the fact: `day` is a date in the booking time zone, no later than today. */
timeRoutes.post("/tasks/:id/time", async (c) => {
  const body = await bodyOf(c, z.object({ day: DAY, minutes: MINUTES, billable: z.boolean().optional(), note: NOTE.optional() }).strict());
  if (body instanceof Response) return body;
  const task = await getTask(c.env.DB, c.req.param("id"));
  if (!task) return c.json(NOT_FOUND, 404);
  return c.json({ entry: await addManualEntry(c.env, { taskId: task.id, ...body }, new Date()) }, 201);
});

const PatchEntryBody = z.object({ minutes: MINUTES, billable: z.boolean(), note: NOTE, startedAt: z.string().refine(isStart, "A start time must be a date and time like 2026-12-03T17:00:00.000Z.") })
  .partial().strict().refine((b) => Object.keys(b).length > 0, { message: "nothing to change" });

timeRoutes.patch("/time/:id", async (c) => {
  const body = await bodyOf(c, PatchEntryBody);
  if (body instanceof Response) return body;
  if (!(await getEntry(c.env.DB, c.req.param("id")))) return c.json(NOT_FOUND, 404);
  return c.json({ entry: await patchEntry(c.env.DB, c.req.param("id"), body) });
});

/** Deletes an entry; one that has been invoiced is 409. */
timeRoutes.delete("/time/:id", async (c) => {
  if (!(await getEntry(c.env.DB, c.req.param("id")))) return c.json(NOT_FOUND, 404);
  await deleteEntry(c.env.DB, c.req.param("id"));
  return c.json({ ok: true });
});

/** The timesheet for the week containing `of` (today when left out), in the booking time zone and from the configured first day of the week. */
timeRoutes.get("/time/week", async (c) => {
  const settings = await getSettings(c.env.DB);
  const tz = parseConfig(settings.booking_config).timezone;
  const { weekStartsOn } = parseWorkConfig(settings.work_config);
  const of = c.req.query("of") ?? dayKey(Date.now(), tz);
  if (!isCalendarDate(of)) return c.json({ error: "The week must be given as a real date like 2026-12-03." }, 400);
  return c.json({ ...(await weekGrid(c.env.DB, { weekOf: of, tz, weekStartsOn })), tz, weekStartsOn });
});
