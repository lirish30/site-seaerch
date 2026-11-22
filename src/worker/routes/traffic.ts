import { Hono } from "hono";
import { z } from "zod";
import type { Env } from "../env";
import { GoogleApiError } from "../google/api";
import { GoogleNotConnected } from "../google/access";
import { getSettings } from "../db/settings";
import { getSite } from "../db/sites";
import { bodyOf, NOT_FOUND, ownerOnError } from "../projects/http";
import { periodKey, zoneOf } from "../sop/cadence";
import { LinkRefused, SiteNotFound, findCandidates, linkSite, unlinkSite } from "../traffic/link";
import { hasLinkedSource, pullMonth } from "../traffic/pull";
import { isTimeout, trafficProblem } from "../traffic/problem";

/**
 * Mounted at /api/traffic (behind requireAuth, the owner only): finding and linking the Google properties of a site.
 * POST /site/:siteId/find (the Search Console entries and Analytics properties that belong to the site), PUT /site/:siteId/link (`{ gscProperty?, ga4Property?, gbpLocation? }`; `null` unlinks one)
 * and DELETE /site/:siteId/link (204; the months already pulled stay), and POST /site/:siteId/pull (`{ period }`, a finished month in the booking zone; pulls it now and answers `{ status, error }`; a complete month is only replaced by another complete one, so a failed pull leaves it as it was). A site that is archived or unknown is 404. Nothing a Google error body said is returned.
 */
export const trafficRoutes = new Hono<{ Bindings: Env }>();
trafficRoutes.onError((e, c) => {
  if (e instanceof SiteNotFound) return c.json(NOT_FOUND, 404);
  if (e instanceof LinkRefused || e instanceof GoogleNotConnected) return c.json({ error: e.message }, 409);
  if (e instanceof GoogleApiError || isTimeout(e) || e.message.startsWith("Google token error")) return c.json({ error: trafficProblem(e, { email: null }) }, 502);
  return ownerOnError(e, c);
});

trafficRoutes.post("/site/:siteId/find", async (c) => c.json(await findCandidates(c.env, c.req.param("siteId"))));

const LinkBody = z.object({ gscProperty: z.string().nullable().optional(), ga4Property: z.string().nullable().optional(), gbpLocation: z.string().nullable().optional() });

trafficRoutes.put("/site/:siteId/link", async (c) => {
  const body = await bodyOf(c, LinkBody);
  if (body instanceof Response) return body;
  return c.json(await linkSite(c.env, c.req.param("siteId"), body, new Date()));
});

trafficRoutes.delete("/site/:siteId/link", async (c) => {
  await unlinkSite(c.env, c.req.param("siteId"));
  return c.body(null, 204);
});

const PullBody = z.object({ period: z.string() });

trafficRoutes.post("/site/:siteId/pull", async (c) => {
  const body = await bodyOf(c, PullBody);
  if (body instanceof Response) return body;
  const siteId = c.req.param("siteId");
  const site = await getSite(c.env.DB, siteId);
  if (!site || site.archivedAt) throw new SiteNotFound("not found");
  const now = new Date();
  // Only a month that has finished in the booking zone: Google has not settled the one running, and a later one has nothing.
  if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(body.period) || body.period >= periodKey("monthly", now, zoneOf(await getSettings(c.env.DB)))) throw new LinkRefused("Choose a month that has finished.");
  if (!(await hasLinkedSource(c.env, siteId))) throw new LinkRefused("Nothing is linked for this site.");
  return c.json(await pullMonth(c.env, siteId, body.period, { now, force: true }));
});
