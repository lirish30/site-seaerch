import { Hono } from "hono";
import type { Env } from "../env";
import { getSearch, listSearches } from "../db/searches";
import { listBusinessesForSearch } from "../db/businesses";
import { checkSpend, estimateSearchCost } from "../cost";
import { leadRows } from "./leads";
import { failureResponse, inFlightUsd, searchWorkflowStarter, startSearchRun } from "../search-start";

export const searchRoutes = new Hono<{ Bindings: Env }>();

searchRoutes.get("/", async (c) => c.json(await listSearches(c.env.DB)));

searchRoutes.get("/estimate", async (c) => {
  const raw = Number(c.req.query("maxResults") ?? 50);
  const n = Math.min(200, Math.max(1, Number.isFinite(raw) ? raw : 50));
  const estUsd = estimateSearchCost(n);
  const inFlight = await inFlightUsd(c.env.DB); // same total the POST guard uses, so the two cannot disagree
  return c.json({ estUsd, inFlightUsd: inFlight, ...(await checkSpend(c.env.DB, estUsd + inFlight)) });
});

searchRoutes.post("/", async (c) => {
  const r = await startSearchRun({ db: c.env.DB, startWorkflow: searchWorkflowStarter(c.env) }, await c.req.json().catch(() => ({})));
  if (!r.ok) { const f = failureResponse(r); return c.json(f.body, f.status); }
  return c.json(r.search, 201);
});

searchRoutes.get("/:id", async (c) => {
  const search = await getSearch(c.env.DB, c.req.param("id"));
  if (!search) return c.json({ error: "not found" }, 404);
  const businesses = await listBusinessesForSearch(c.env.DB, search.id, { hideSkipped: c.req.query("hideSkipped") === "1" });
  return c.json({ search, leads: await leadRows(c.env.DB, businesses) });
});
