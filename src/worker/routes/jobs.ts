import { Hono } from "hono";
import type { Env } from "../env";
import { getBusiness } from "../db/businesses";
import { SEEN_WITHIN_HOURS, getCareerSource, listOpenRelevantWithBusiness, listPostingsForLead } from "../db/jobs";
import { suppressedLeadIds } from "../db/suppression";
import { jobDeps, runJobWatch } from "../jobs/run";
import { checkLead } from "../jobs/sync";

const MAX_LIST = 200;

export const jobRoutes = new Hono<{ Bindings: Env }>();

jobRoutes.get("/", async (c) => {
  // Fetch past the cap, then drop suppressed leads, so a long suppression list cannot empty the page.
  const rows = await listOpenRelevantWithBusiness(c.env.DB, MAX_LIST * 2);
  const blocked = await suppressedLeadIds(c.env.DB, rows.map((r) => ({ id: r.business_id, domain: r.domain, place_id: r.place_id, website_url: r.website_url })));
  // A board that keeps failing must not list roles forever: only roles seen recently count as open.
  const since = new Date(Date.now() - SEEN_WITHIN_HOURS * 3_600_000).toISOString();
  const jobs = rows.filter((r) => !blocked.has(r.business_id) && r.last_seen_at >= since).slice(0, MAX_LIST).map(({ domain: _d, place_id: _p, website_url: _w, ...job }) => job);
  return c.json({ jobs });
});

const forLead = async (c: { env: Env }, id: string) =>
  ({ source: await getCareerSource(c.env.DB, id) ?? null, postings: await listPostingsForLead(c.env.DB, id) });

jobRoutes.get("/leads/:id", async (c) => {
  const id = c.req.param("id");
  if (!(await getBusiness(c.env.DB, id))) return c.json({ error: "not found" }, 404);
  return c.json(await forLead(c, id));
});

jobRoutes.post("/leads/:id/check", async (c) => {
  const id = c.req.param("id");
  if (!(await getBusiness(c.env.DB, id))) return c.json({ error: "not found" }, 404);
  await checkLead(await jobDeps(c.env), id);
  return c.json(await forLead(c, id));
});

// Fire and forget: a full tick is dozens of outbound fetches, more than a request should wait for.
jobRoutes.post("/run", async (c) => {
  const deps = await jobDeps(c.env);
  c.executionCtx.waitUntil(runJobWatch(deps).then((s) => console.log("job watch (manual)", JSON.stringify(s)), (e) => console.error("job watch failed", e)));
  return c.json({ started: true }, 202);
});
