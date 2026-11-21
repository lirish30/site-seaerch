import { Hono } from "hono";
import { z } from "zod";
import { isClient, isTestClient } from "../clients/record";
import { editLedger } from "../care/ledger";
import { getBusiness } from "../db/businesses";
import { getSettings } from "../db/settings";
import { zoneOf } from "../sop/cadence";
import { localDay } from "../monitoring/rollup";
import { closeUnmonitoredIncidents, getIncident, listIncidents, recentChecks, setMonitoring } from "../db/monitoring";
import { getPageCheck, getRun, setReview, setUpdateFlag } from "../db/careUpdates";
import { getSite, type Site } from "../db/sites";
import type { Env } from "../env";
import { CareRunRefused, onRunDone, startBatchNow, startSingleRun } from "../care/batch";
import { closeUpdateIncident } from "../care/incidents";
import { CareReportRefused, startReport } from "../care/reportSweep";
import { careUpdatesBoard, runDetail, updateView } from "../care/views";
import { serveObject } from "../video/media";
import { cancelTasksFor } from "../queue/db";
import { CARE_REVIEW_TARGET } from "../queue/careReview";
import { careClientIds, careFleet, incidentViews, monitoringViews, safeProbeError } from "../monitoring/fleet";
import { monitorableUrl } from "../monitoring/probe";
import { bodyOf, NOT_FOUND, ownerOnError, type Ctx } from "../projects/http";

/**
 * Mounted at /api (behind requireAuth): GET /care (the fleet), GET /incidents, GET /sites/:id/checks, PUT /sites/:id/monitoring.
 * Read only apart from the switch. No site address is ever returned, only its domain, and nothing a remote site sent beyond a status code and a fixed phrase.
 */
export const careRoutes = new Hono<{ Bindings: Env }>();
careRoutes.onError(ownerOnError);

const DEFAULT_CHECKS = 50;
const MAX_CHECKS = 200;

/** The live, real site of a real client, or null (unknown, test, archived): the owner's Care screens never show anything else. */
async function boardSite(c: Ctx, siteId: string): Promise<Site | null> {
  const site = await getSite(c.env.DB, siteId);
  return site && !site.archivedAt && !site.test && !(await isTestClient(c.env.DB, site.businessId)) ? site : null;
}

careRoutes.get("/care", async (c) => c.json({ clients: await careFleet(c.env.DB, new Date()) }));

/** `?open=1` keeps the open ones; `?businessId=` narrows to one client. Newest first. */
careRoutes.get("/incidents", async (c) => {
  const businessId = c.req.query("businessId");
  const incidents = await listIncidents(c.env.DB, { open: c.req.query("open") === "1" ? true : undefined, ...(businessId ? { businessId } : {}) });
  return c.json({ incidents: await incidentViews(c.env.DB, incidents, new Date()) });
});

/** The newest checks, newest first. `limit` is 1 to 200 (default 50): a number outside that is clamped, anything that is not a number is the default. */
careRoutes.get("/sites/:id/checks", async (c) => {
  const site = await boardSite(c, c.req.param("id"));
  if (!site) return c.json(NOT_FOUND, 404);
  const raw = c.req.query("limit");
  const n = raw === undefined || raw.trim() === "" ? NaN : Number(raw);
  const limit = Number.isFinite(n) ? Math.max(1, Math.min(MAX_CHECKS, Math.trunc(n))) : DEFAULT_CHECKS;
  const checks = await recentChecks(c.env.DB, site.id, limit);
  return c.json({ checks: checks.map((k) => ({ checkedAt: k.checkedAt, ok: k.ok, status: k.status, ms: k.ms, error: safeProbeError(k.error) })) });
});

const SwitchBody = z.object({ enabled: z.boolean("enabled must be true or false.") }).strict();

/** Switches monitoring on or off for one site by hand. A client with live Care is monitored either way. Turning it on needs an address the probe may fetch. */
careRoutes.put("/sites/:id/monitoring", async (c) => {
  const body = await bodyOf(c, SwitchBody);
  if (body instanceof Response) return body;
  const site = await boardSite(c, c.req.param("id"));
  if (!site) return c.json(NOT_FOUND, 404);
  if (body.enabled && !monitorableUrl(site.url).ok) {
    return c.json({ error: "This site's address can't be monitored. Give it a public http or https address first." }, 409);
  }
  const now = new Date();
  const updated = (await setMonitoring(c.env.DB, site.id, body.enabled, now.toISOString())) ?? site;
  // Switched off: if nothing else watches the site (no live Care), its open incidents end now instead of at the next tick.
  if (!body.enabled) await closeUnmonitoredIncidents(c.env.DB, now.toISOString(), site.id);
  const [view] = await monitoringViews(c.env.DB, [updated], await careClientIds(c.env.DB, [updated.businessId]), now);
  return c.json({ site: view });
});

/**
 * Logan looked at a page that changed after updates and it is fine: pending, unsure or broken (his look overrides Claude's) becomes `logan_ok`, Claude's open look at it is closed and the batch moves on.
 * 404 for a page check nobody has; 409 when it is fine, already `logan_ok` or was never flagged. An open incident stays open: Logan closes it himself.
 */
careRoutes.post("/care/checks/:id/ok", async (c) => {
  const check = await getPageCheck(c.env.DB, c.req.param("id"));
  if (!check) return c.json(NOT_FOUND, 404);
  if (!(await setReview(c.env.DB, check.id, ["pending", "unsure", "broken"], "logan_ok"))) return c.json({ error: "This page is not waiting for a look or open to your OK." }, 409);
  await cancelTasksFor(c.env.DB, CARE_REVIEW_TARGET, check.id);
  const run = await getRun(c.env.DB, check.runId);
  if (run) await onRunDone(c.env, run.batchId);
  return c.json({ ok: true });
});

// --- Care reports (Plan 13) --------------------------------------------------------------------------------------------------------------------------------------------

const MONTH = /^\d{4}-(0[1-9]|1[0-2])$/;

/**
 * A client's edit hours for one month (`?month=YYYY-MM`, default this month in the booking zone): `{ ledger }`, which is null when the client has no live Care plan.
 * 404 for an unknown client or a rehearsal one; 400 for a month that is not `YYYY-MM`.
 */
careRoutes.get("/clients/:id/edit-ledger", async (c) => {
  const id = c.req.param("id");
  if (!(await getBusiness(c.env.DB, id)) || (await isTestClient(c.env.DB, id))) return c.json(NOT_FOUND, 404);
  const tz = zoneOf(await getSettings(c.env.DB));
  const month = c.req.query("month") ?? localDay(new Date().toISOString(), tz).slice(0, 7);
  if (!MONTH.test(month)) return c.json({ error: "month must look like 2026-11." }, 400);
  return c.json({ ledger: await editLedger(c.env, id, month, tz) });
});

/**
 * Starts the report of last month for the client by hand, any day (a rehearsal client too): 201 with `{ report: { id, status, period } }`, or 200 with the one that is already there.
 * 404 for an unknown client; 409 with a plain sentence for a client with no live Care project.
 */
careRoutes.post("/clients/:id/care-report", async (c) => {
  const id = c.req.param("id");
  if (!(await isClient(c.env.DB, id))) return c.json(NOT_FOUND, 404);
  try {
    const { report, created } = await startReport(c.env, id, { test: await isTestClient(c.env.DB, id), now: new Date() });
    return c.json({ report: { id: report.id, status: report.status, period: report.period } }, created ? 201 : 200);
  } catch (e) {
    if (e instanceof CareReportRefused) return c.json({ error: e.message }, 409);
    throw e;
  }
});

// --- Care updates (Plan 12) --------------------------------------------------------------------------------------------------------------------------------------------

/** This week's batch and every Care site with its updates, last run and open update incident. Never the SSH alias, the folder, a storage key or the backup directory. */
careRoutes.get("/care/updates", async (c) => c.json(await careUpdatesBoard(c.env.DB, new Date())));

const FlagBody = z.object({ held: z.boolean("held must be true or false.").optional(), security: z.boolean("security must be true or false.").optional() }).strict()
  .refine((b) => b.held !== undefined || b.security !== undefined, { message: "nothing to change" });

/** Logan's two marks on one update: hold it back, or call it a security fix (taken at once, whatever its size). An unknown id is 404. */
careRoutes.put("/care/updates/:id", async (c) => {
  const body = await bodyOf(c, FlagBody);
  if (body instanceof Response) return body;
  const id = c.req.param("id");
  let update = null;
  if (body.held !== undefined) update = await setUpdateFlag(c.env.DB, id, "held", body.held);
  if (body.security !== undefined && (body.held === undefined || update)) update = await setUpdateFlag(c.env.DB, id, "security", body.security);
  if (!update) return c.json(NOT_FOUND, 404);
  return c.json({ update: updateView(update, new Date()) });
});

/** Starts this week's batch now, on any weekday. 409 when this week's batch already exists. */
careRoutes.post("/care/batches", async (c) => {
  const r = await startBatchNow(c.env, new Date());
  if (!r.created) return c.json({ error: "This week's batch is already started." }, 409);
  return c.json({ batch: r.batch, queued: r.queued }, 201);
});

/** Logan runs one site by hand, any day (a rehearsal site too). 404 for an unknown site; 409 with a plain sentence when the site cannot take updates or already has a run open. */
careRoutes.post("/sites/:id/care-run", async (c) => {
  const site = await getSite(c.env.DB, c.req.param("id"));
  if (!site) return c.json(NOT_FOUND, 404);
  try {
    return c.json({ batch: await startSingleRun(c.env, site.id, new Date()) }, 201);
  } catch (e) {
    if (e instanceof CareRunRefused) return c.json({ error: e.message }, 409);
    throw e;
  }
});

/** One run with its page checks. Pictures are links to the owner's own picture route; the backup file name is shown here. */
careRoutes.get("/care/runs/:id", async (c) => {
  const run = await getRun(c.env.DB, c.req.param("id"));
  if (!run) return c.json(NOT_FOUND, 404);
  return c.json({ run: await runDetail(c.env.DB, run) });
});

const PICTURE_KEY = /^care\/[A-Za-z0-9-]{1,64}\/\d{1,2}-(before|after|diff)\.jpg$/;

/** Streams one of a page check's three pictures. Only a key that belongs to that page check and has the care picture shape is ever read from storage. */
careRoutes.get("/care/pictures/:checkId/:kind", async (c) => {
  const kind = c.req.param("kind");
  const check = await getPageCheck(c.env.DB, c.req.param("checkId"));
  const key = !check ? null : kind === "before" ? check.beforeKey : kind === "after" ? check.afterKey : kind === "diff" ? check.diffKey : null;
  if (!check || !key || !PICTURE_KEY.test(key) || !key.startsWith(`care/${check.runId}/`)) return c.json(NOT_FOUND, 404);
  return serveObject(c.env.RAW, key, "image/jpeg", c.req.header("range") ?? null);
});

/** Logan closes an `update_failed` incident once he has dealt with it. The other kinds close themselves: 409. Unknown is 404; an incident already closed is 409. */
careRoutes.post("/incidents/:id/close", async (c) => {
  const incident = await getIncident(c.env.DB, c.req.param("id"));
  if (!incident) return c.json(NOT_FOUND, 404);
  if (incident.kind !== "update_failed") return c.json({ error: "This kind of incident closes by itself when the problem ends." }, 409);
  if (incident.closedAt !== null) return c.json({ error: "This incident is already closed." }, 409);
  await closeUpdateIncident(c.env, incident.siteId, new Date());
  return c.json({ ok: true });
});
