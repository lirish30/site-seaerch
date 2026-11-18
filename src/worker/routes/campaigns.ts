import { Hono } from "hono";
import { z } from "zod";
import type { Env } from "../env";
import { StepInvariantError, createCampaign, getCampaign, listCampaigns, listSteps, saveStep, updateCampaign } from "../db/campaigns";
import { failureMessage, searchWorkflowStarter, startSearchRun } from "../search-start";

const Name = z.string().trim().min(1).max(100);
// Case-insensitive duplicates collapse to the first spelling, so one town never starts two searches.
const Towns = z.array(z.string().trim().min(1).max(100)).min(1).max(10).transform((towns) => {
  const seen = new Set<string>();
  return towns.filter((t) => { const k = t.toLowerCase(); return seen.has(k) ? false : (seen.add(k), true); });
});

const NewCampaign = z.object({ name: Name, niche: z.string().trim().min(1).max(100), region: z.string().trim().min(1).max(100), towns: Towns }).strict();
const PatchCampaign = z.object({
  name: Name.optional(), niche: z.string().trim().min(1).max(100).optional(), region: z.string().trim().min(1).max(100).optional(),
  towns: Towns.optional(), status: z.enum(["testing", "active", "archived"]).optional(),
  est_job_value_usd: z.number().min(0).nullable().optional(),
}).strict().refine((v) => Object.values(v).some((x) => x !== undefined), { message: "nothing to update" });

const PutStep = z.object({
  kind: z.enum(["email", "call", "checkin"]),
  offset_days: z.number().int().min(0).max(365),
  offset_kind: z.enum(["business", "calendar"]),
  subject: z.string().trim().max(200),
  variants: z.array(z.string().trim().min(1).max(3000)).max(5),
  body_source: z.enum(["variants", "draft"]).optional(),
}).strict(); // body rules (draft only on step 0, variants elsewhere) are enforced by saveStep

const invalid = (error: z.ZodError) => ({ error: "invalid body", fields: z.flattenError(error).fieldErrors });

export const campaignRoutes = new Hono<{ Bindings: Env }>();

campaignRoutes.get("/", async (c) => c.json(await listCampaigns(c.env.DB)));

campaignRoutes.post("/", async (c) => {
  const parsed = NewCampaign.safeParse(await c.req.json().catch(() => ({})));
  if (!parsed.success) return c.json(invalid(parsed.error), 400);
  const campaign = await createCampaign(c.env.DB, parsed.data);
  return c.json({ ...campaign, steps: await listSteps(c.env.DB, campaign.id) }, 201);
});

campaignRoutes.get("/:id", async (c) => {
  const campaign = await getCampaign(c.env.DB, c.req.param("id"));
  if (!campaign) return c.json({ error: "not found" }, 404);
  return c.json({ ...campaign, steps: await listSteps(c.env.DB, campaign.id) });
});

campaignRoutes.patch("/:id", async (c) => {
  const parsed = PatchCampaign.safeParse(await c.req.json().catch(() => ({})));
  if (!parsed.success) return c.json(invalid(parsed.error), 400);
  const campaign = await updateCampaign(c.env.DB, c.req.param("id"), parsed.data);
  if (!campaign) return c.json({ error: "not found" }, 404);
  return c.json({ ...campaign, steps: await listSteps(c.env.DB, campaign.id) });
});

campaignRoutes.put("/:id/steps/:idx", async (c) => {
  const idx = Number(c.req.param("idx"));
  if (!Number.isInteger(idx) || idx < 0) return c.json({ error: "invalid step index" }, 400);
  const parsed = PutStep.safeParse(await c.req.json().catch(() => ({})));
  if (!parsed.success) return c.json(invalid(parsed.error), 400);
  const id = c.req.param("id");
  if (!(await getCampaign(c.env.DB, id))) return c.json({ error: "not found" }, 404);
  // Edits only: the five steps exist from creation, so an index with no step is a mistake, not a new step.
  if (!(await listSteps(c.env.DB, id)).some((s) => s.idx === idx)) return c.json({ error: "step not found" }, 404);
  try {
    return c.json(await saveStep(c.env.DB, id, { ...parsed.data, idx }));
  } catch (e) {
    if (e instanceof StepInvariantError) return c.json({ error: "invalid body", fields: { [e.field]: [e.message] } }, 400);
    throw e;
  }
});

// One search per town, one after another: each start counts toward the in-flight spend the next town is checked against.
campaignRoutes.post("/:id/run-searches", async (c) => {
  const campaign = await getCampaign(c.env.DB, c.req.param("id"));
  if (!campaign) return c.json({ error: "not found" }, 404);
  if (campaign.status === "archived") return c.json({ error: "campaign is archived" }, 409);
  const deps = { db: c.env.DB, startWorkflow: searchWorkflowStarter(c.env) };
  let started = 0;
  const blocked: { town: string; reason: string }[] = [];
  for (const town of campaign.towns) {
    try {
      // Radius and result count are left to the search defaults, the same ones a new radar gets.
      const r = await startSearchRun(deps, { location: town, businessType: campaign.niche }, { campaignId: campaign.id });
      if (r.ok) started++;
      else blocked.push({ town, reason: failureMessage(r) });
    } catch (e) {
      blocked.push({ town, reason: String((e as Error)?.message ?? e).slice(0, 500) });
    }
  }
  return c.json({ started, blocked });
});
