import { Hono } from "hono";
import { z } from "zod";
import type { Env } from "../env";
import {
  MAX_RADARS, addDays, countRadars, createRadar, deleteRadar, getRadar, isDuplicateMarket, listRadars, radarExists, updateRadar,
} from "../db/radar";
import { checkSearchGuards, failureResponse } from "../search-start";
import { runRadar, type RadarDeps } from "../radar-run";

const NewRadar = z.object({
  location: z.string().trim().min(2),
  businessType: z.string().trim().min(2),
  radiusKm: z.number().min(1).max(100).default(15),
  maxResults: z.number().int().min(1).max(200).default(50),
  intervalDays: z.number().int().min(7).max(90).default(30),
  runNow: z.boolean().default(false),
});
const PatchRadar = z.object({ enabled: z.boolean().optional(), intervalDays: z.number().int().min(7).max(90).optional() })
  .refine((v) => v.enabled !== undefined || v.intervalDays !== undefined, { message: "nothing to update" });

// Two clicks of "Run now" within this window are one click: the claim stops concurrent ones, this stops the
// one that read the row just after the first claim advanced it.
const MANUAL_COOLDOWN_MS = 10_000;
const DUPLICATE = "a radar for this location and business type already exists";

const deps = (env: Env): RadarDeps => ({
  db: env.DB, now: () => new Date(),
  startWorkflow: (id) => env.SEARCH_WORKFLOW.create({ id: `search-${id}`, params: { searchId: id } }),
});

export const radarRoutes = new Hono<{ Bindings: Env }>();

radarRoutes.get("/", async (c) => c.json(await listRadars(c.env.DB)));

radarRoutes.post("/", async (c) => {
  const parsed = NewRadar.safeParse(await c.req.json().catch(() => ({})));
  if (!parsed.success) return c.json({ error: parsed.error.issues.map((i) => i.message).join("; ") }, 400);
  const { runNow, intervalDays, ...search } = parsed.data;
  const db = c.env.DB;
  if ((await countRadars(db)) >= MAX_RADARS) return c.json({ error: `radar limit reached (${MAX_RADARS}); delete one first` }, 409);
  if (await radarExists(db, search.location, search.businessType)) return c.json({ error: DUPLICATE }, 409);
  // runNow is all-or-nothing: if the first run is blocked (spend limit, missing mailing settings) we reject with the
  // manual route's 402/400 BEFORE creating anything, rather than saving a radar that is already in an error state.
  if (runNow) {
    const g = await checkSearchGuards(db, search);
    if (!g.ok) { const f = failureResponse(g); return c.json(f.body, f.status); }
  }
  // Even with runNow it is created one interval out, never "due": the cron tick can't grab it before the run below claims it.
  let radar;
  try { radar = await createRadar(db, { ...search, intervalDays }, addDays(new Date(), intervalDays)); }
  catch (e) { if (isDuplicateMarket(e)) return c.json({ error: DUPLICATE }, 409); throw e; }
  if (!runNow) return c.json(radar, 201);
  // Same claim + guards as every other run; if it still fails (a race with the checks above), undo the creation.
  const o = await runRadar(deps(c.env), radar);
  if (o.status === "started") return c.json((await getRadar(db, radar.id))!, 201);
  await deleteRadar(db, radar.id);
  if (o.status === "claim_lost") return c.json({ error: "radar changed, try again" }, 409);
  const f = failureResponse(o.failure);
  return c.json(f.body, f.status);
});

radarRoutes.patch("/:id", async (c) => {
  const parsed = PatchRadar.safeParse(await c.req.json().catch(() => ({})));
  if (!parsed.success) return c.json({ error: parsed.error.issues.map((i) => i.message).join("; ") }, 400);
  const radar = await getRadar(c.env.DB, c.req.param("id"));
  if (!radar) return c.json({ error: "not found" }, 404);
  const { enabled, intervalDays } = parsed.data;
  const now = new Date();
  const interval = intervalDays ?? radar.interval_days;
  let nextRunAt: string | undefined;
  // Re-enabling must never fire by surprise (it may be long overdue): wait a full interval from now.
  if (enabled === true && !radar.enabled) nextRunAt = addDays(now, interval);
  // A shorter interval pulls the next run in; a longer one never postpones it.
  else if (intervalDays !== undefined && addDays(now, interval) < radar.next_run_at) nextRunAt = addDays(now, interval);
  await updateRadar(c.env.DB, radar.id, { enabled, intervalDays, nextRunAt });
  return c.json((await getRadar(c.env.DB, radar.id))!);
});

radarRoutes.delete("/:id", async (c) => {
  if (!(await deleteRadar(c.env.DB, c.req.param("id")))) return c.json({ error: "not found" }, 404);
  return c.json({ ok: true });
});

radarRoutes.post("/:id/run", async (c) => {
  const radar = await getRadar(c.env.DB, c.req.param("id"));
  if (!radar) return c.json({ error: "not found" }, 404);
  if (!radar.enabled) return c.json({ error: "radar is disabled; enable it first" }, 409);
  const d = deps(c.env);
  if (radar.last_run_at && d.now().getTime() - new Date(radar.last_run_at).getTime() < MANUAL_COOLDOWN_MS) return c.json({ error: "this radar just ran" }, 409);
  const o = await runRadar(d, radar);
  if (o.status === "claim_lost") return c.json({ error: "this radar just ran" }, 409);
  if (o.status === "blocked") { const f = failureResponse(o.failure); return c.json(f.body, f.status); }
  return c.json((await getRadar(c.env.DB, radar.id))!);
});
