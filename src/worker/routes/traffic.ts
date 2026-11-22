import { Hono } from "hono";
import { z } from "zod";
import type { Env } from "../env";
import { GoogleApiError } from "../google/api";
import { GoogleNotConnected } from "../google/access";
import { bodyOf, NOT_FOUND, ownerOnError } from "../projects/http";
import { LinkRefused, SiteNotFound, findCandidates, linkSite, unlinkSite } from "../traffic/link";
import { trafficProblem } from "../traffic/problem";

/**
 * Mounted at /api/traffic (behind requireAuth, the owner only): finding and linking the Google properties of a site.
 * POST /site/:siteId/find (the Search Console entries and Analytics properties that belong to the site), PUT /site/:siteId/link (`{ gscProperty?, ga4Property? }`; `null` unlinks one)
 * and DELETE /site/:siteId/link (204; the months already pulled stay). A site that is archived or unknown is 404. Nothing a Google error body said is returned.
 */
export const trafficRoutes = new Hono<{ Bindings: Env }>();
trafficRoutes.onError((e, c) => {
  if (e instanceof SiteNotFound) return c.json(NOT_FOUND, 404);
  if (e instanceof LinkRefused || e instanceof GoogleNotConnected) return c.json({ error: e.message }, 409);
  if (e instanceof GoogleApiError || e.message.startsWith("Google token error")) return c.json({ error: trafficProblem(e, { email: null }) }, 502);
  return ownerOnError(e, c);
});

trafficRoutes.post("/site/:siteId/find", async (c) => c.json(await findCandidates(c.env, c.req.param("siteId"))));

const LinkBody = z.object({ gscProperty: z.string().nullable().optional(), ga4Property: z.string().nullable().optional() });

trafficRoutes.put("/site/:siteId/link", async (c) => {
  const body = await bodyOf(c, LinkBody);
  if (body instanceof Response) return body;
  return c.json(await linkSite(c.env, c.req.param("siteId"), body, new Date()));
});

trafficRoutes.delete("/site/:siteId/link", async (c) => {
  await unlinkSite(c.env, c.req.param("siteId"));
  return c.body(null, 204);
});
