import { Hono } from "hono";
import { z } from "zod";
import { isTestClient } from "../clients/record";
import { closeUnmonitoredIncidents, listIncidents, recentChecks, setMonitoring } from "../db/monitoring";
import { getPageCheck, getRun, setReview } from "../db/careUpdates";
import { getSite, type Site } from "../db/sites";
import type { Env } from "../env";
import { onRunDone } from "../care/batch";
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
