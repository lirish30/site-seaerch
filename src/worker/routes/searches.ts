import { Hono } from "hono";
import type { Env } from "../env";
import { getSearch, listSearches, setSearchStatus } from "../db/searches";
import { listBusinessesForSearch } from "../db/businesses";
import { checkSpend, estimateQuickSearchCost, estimateSearchCost } from "../cost";
import { leadRows } from "./leads";
import { STOPPED_ERROR } from "../search-stop";
import { searchSummary } from "../search-summary";
import { failureResponse, inFlightUsd, searchWorkflowStarter, startSearchRun } from "../search-start";

export const searchRoutes = new Hono<{ Bindings: Env }>();

searchRoutes.get("/", async (c) => c.json(await listSearches(c.env.DB)));

// Hot-lead counts, estimated cost and all-time totals for the history list. Before "/:id" so "summary" is never read as an id.
searchRoutes.get("/summary", async (c) => c.json(await searchSummary(c.env.DB, await listSearches(c.env.DB))));

searchRoutes.get("/estimate", async (c) => {
  const raw = Number(c.req.query("maxResults") ?? 50);
  const n = Math.min(200, Math.max(1, Number.isFinite(raw) ? raw : 50));
  const estUsd = estimateSearchCost(n);
  const inFlight = await inFlightUsd(c.env.DB); // same total the POST guard uses, so the two cannot disagree
  return c.json({ estUsd, quickUsd: estimateQuickSearchCost(n), inFlightUsd: inFlight, ...(await checkSpend(c.env.DB, estUsd + inFlight)) });
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

// Stops a running search: its workflow starts no more leads (leads already started finish on their own) and the search is left "failed: Stopped by you".
searchRoutes.post("/:id/stop", async (c) => {
  const search = await getSearch(c.env.DB, c.req.param("id"));
  if (!search) return c.json({ error: "not found" }, 404);
  if (search.status !== "running") return c.json({ error: "search is not running" }, 409);
  // The instance may already have finished or never existed (e.g. it failed to start); the row is what the UI follows.
  try { await (await c.env.SEARCH_WORKFLOW.get(`search-${search.id}`)).terminate(); } catch { /* nothing to terminate */ }
  await setSearchStatus(c.env.DB, search.id, "failed", STOPPED_ERROR);
  return c.json((await getSearch(c.env.DB, search.id))!);
});
