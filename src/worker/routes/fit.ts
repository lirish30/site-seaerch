import { Hono } from "hono";
import { z } from "zod";
import type { Env } from "../env";
import { createFitProfile, deleteFitProfile, listFitProfiles, updateFitProfile } from "../db/fit";
import { getServiceByKey } from "../db/services";

const Platforms = z.array(z.enum(["wix", "squarespace", "godaddy", "wordpress", "weebly", "shopify", "webflow", "other"])).max(20);
const Strs = z.array(z.string().trim().min(1).max(80)).max(50);
const Name = z.string().trim().min(1).max(120);
const Key = z.string().trim().min(1).max(120);
const MinReviews = z.number().int().min(0).max(1_000_000).nullable();
const MinRating = z.number().min(0).max(5).nullable();

const NewProfile = z.object({
  name: Name, service_key: Key, industries: Strs.optional(), geos: Strs.optional(), platforms: Platforms.optional(),
  min_reviews: MinReviews.optional(), min_rating: MinRating.optional(),
});
const PatchProfile = z.object({
  name: Name.optional(), service_key: Key.optional(), industries: Strs.optional(), geos: Strs.optional(), platforms: Platforms.optional(),
  min_reviews: MinReviews.optional(), min_rating: MinRating.optional(), active: z.boolean().optional(),
}).refine((v) => Object.values(v).some((x) => x !== undefined), { message: "nothing to update" });

const bad = (e: z.ZodError) => e.issues.map((i) => (i.path.length ? `${i.path.join(".")}: ` : "") + i.message).join("; ");
const UNKNOWN_SERVICE = { error: "service_key is not a service in the catalog" };

export const fitRoutes = new Hono<{ Bindings: Env }>();

fitRoutes.get("/", async (c) => c.json(await listFitProfiles(c.env.DB)));

fitRoutes.post("/", async (c) => {
  const parsed = NewProfile.safeParse(await c.req.json().catch(() => ({})));
  if (!parsed.success) return c.json({ error: bad(parsed.error) }, 400);
  if (!(await getServiceByKey(c.env.DB, parsed.data.service_key))) return c.json(UNKNOWN_SERVICE, 400);
  return c.json(await createFitProfile(c.env.DB, parsed.data), 201);
});

fitRoutes.patch("/:id", async (c) => {
  const parsed = PatchProfile.safeParse(await c.req.json().catch(() => ({})));
  if (!parsed.success) return c.json({ error: bad(parsed.error) }, 400);
  if (parsed.data.service_key && !(await getServiceByKey(c.env.DB, parsed.data.service_key))) return c.json(UNKNOWN_SERVICE, 400);
  const updated = await updateFitProfile(c.env.DB, c.req.param("id"), parsed.data);
  return updated ? c.json(updated) : c.json({ error: "not found" }, 404);
});

fitRoutes.delete("/:id", async (c) =>
  (await deleteFitProfile(c.env.DB, c.req.param("id"))) ? c.json({ ok: true }) : c.json({ error: "not found" }, 404));
