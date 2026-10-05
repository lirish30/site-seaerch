import { Hono } from "hono";
import { z } from "zod";
import type { Env } from "../env";
import { createService, isDuplicateKey, listServices, serviceKey, updateService } from "../db/services";

const Cats = z.array(z.enum(["design", "content", "cro", "mobile", "speed", "technical"]));
const Strs = z.array(z.string().trim().min(1)).max(50);
const Name = z.string().trim().min(1).max(120);

const NewService = z.object({
  name: Name, category: z.string().trim().min(1).max(80).default("Other"), summary: z.string().trim().max(1000).optional(),
  deliverables: Strs.optional(), prerequisites: Strs.optional(), first_engagement: z.string().trim().max(1000).nullable().optional(),
  finding_codes: Strs.optional(), finding_categories: Cats.optional(), is_specialty: z.boolean().optional(),
});
const PatchService = z.object({
  name: Name.optional(), summary: z.string().trim().max(1000).optional(), deliverables: Strs.optional(), prerequisites: Strs.optional(),
  first_engagement: z.string().trim().max(1000).nullable().optional(), finding_codes: Strs.optional(), finding_categories: Cats.optional(),
  is_specialty: z.boolean().optional(), active: z.boolean().optional(),
}).refine((v) => Object.values(v).some((x) => x !== undefined), { message: "nothing to update" });

const bad = (e: z.ZodError) => e.issues.map((i) => (i.path.length ? `${i.path.join(".")}: ` : "") + i.message).join("; ");

export const serviceRoutes = new Hono<{ Bindings: Env }>();

serviceRoutes.get("/", async (c) => c.json(await listServices(c.env.DB)));

serviceRoutes.post("/", async (c) => {
  const parsed = NewService.safeParse(await c.req.json().catch(() => ({})));
  if (!parsed.success) return c.json({ error: bad(parsed.error) }, 400);
  if (!serviceKey(parsed.data.name)) return c.json({ error: "name must contain letters or numbers" }, 400);
  try { return c.json(await createService(c.env.DB, parsed.data), 201); }
  catch (e) {
    if (isDuplicateKey(e)) return c.json({ error: "a service with this name already exists" }, 409);
    throw e;
  }
});

serviceRoutes.patch("/:id", async (c) => {
  const parsed = PatchService.safeParse(await c.req.json().catch(() => ({})));
  if (!parsed.success) return c.json({ error: bad(parsed.error) }, 400);
  const updated = await updateService(c.env.DB, c.req.param("id"), parsed.data);
  return updated ? c.json(updated) : c.json({ error: "not found" }, 404);
});
