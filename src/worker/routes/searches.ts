import { Hono } from "hono";
import { z } from "zod";
import type { Env } from "../env";
import { createSearch, getSearch, listSearches } from "../db/searches";
import { listBusinessesForSearch } from "../db/businesses";
import { checkSpend, estimateSearchCost } from "../cost";
import { leadRows } from "./leads";

const NewSearch = z.object({
  location: z.string().trim().min(2),
  businessType: z.string().trim().min(2),
  radiusKm: z.number().min(1).max(100).default(15),
  maxResults: z.number().int().min(1).max(200).default(50),
});

export const searchRoutes = new Hono<{ Bindings: Env }>();

searchRoutes.get("/", async (c) => c.json(await listSearches(c.env.DB)));

searchRoutes.get("/estimate", async (c) => {
  const n = Math.min(200, Math.max(1, Number(c.req.query("maxResults") ?? 50)));
  const estUsd = estimateSearchCost(n);
  return c.json({ estUsd, ...(await checkSpend(c.env.DB, estUsd)) });
});

searchRoutes.post("/", async (c) => {
  const parsed = NewSearch.safeParse(await c.req.json().catch(() => ({})));
  if (!parsed.success) return c.json({ error: parsed.error.issues.map((i) => i.message).join("; ") }, 400);
  const spend = await checkSpend(c.env.DB, estimateSearchCost(parsed.data.maxResults));
  if (!spend.ok) return c.json({ error: "spend limit", ...spend }, 402);
  const s = await createSearch(c.env.DB, parsed.data);
  await c.env.SEARCH_WORKFLOW.create({ id: `search-${s.id}`, params: { searchId: s.id } });
  return c.json(s, 201);
});

searchRoutes.get("/:id", async (c) => {
  const search = await getSearch(c.env.DB, c.req.param("id"));
  if (!search) return c.json({ error: "not found" }, 404);
  const businesses = await listBusinessesForSearch(c.env.DB, search.id, { hideSkipped: c.req.query("hideSkipped") === "1" });
  return c.json({ search, leads: await leadRows(c.env.DB, businesses) });
});
