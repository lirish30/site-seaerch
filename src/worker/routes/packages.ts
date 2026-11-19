import { Hono } from "hono";
import { z } from "zod";
import type { Env } from "../env";
import { PACKAGE_KEYS, PackageInputError, getPackage, listCurrentPackages, savePackage, type PackageKey } from "../db/packages";

const cents = z.number().int("must be a whole number of cents").min(0, "cannot be negative").max(100_000_000);

const Patch = z.object({
  name: z.string().trim().min(1).max(100),
  priceCents: cents,
  setupCents: cents,
  termMonths: z.number().int().min(1).max(120).nullable(),
  altPriceCents: cents.nullable(),
  summary: z.string().trim().max(500),
  includes: z.array(z.string().trim().min(1).max(300)).max(30),
  active: z.boolean(),
}).partial().strict();

const bad = (e: z.ZodError) => e.issues.map((i) => (i.path.length ? `${i.path.join(".")}: ` : "") + i.message).join("; ");

export const packageRoutes = new Hono<{ Bindings: Env }>();

packageRoutes.get("/", async (c) => c.json(await listCurrentPackages(c.env.DB)));

/** Saves a change as the next version of the package and returns it. */
packageRoutes.put("/:key", async (c) => {
  const key = c.req.param("key") as PackageKey;
  if (!(PACKAGE_KEYS as readonly string[]).includes(key) || !(await getPackage(c.env.DB, key))) return c.json({ error: "not found" }, 404);
  const parsed = Patch.safeParse(await c.req.json().catch(() => ({})));
  if (!parsed.success) return c.json({ error: bad(parsed.error) }, 400);
  if (Object.keys(parsed.data).length === 0) return c.json({ error: "nothing to change" }, 400);
  try { return c.json(await savePackage(c.env.DB, key, parsed.data)); }
  catch (e) {
    if (e instanceof PackageInputError) return c.json({ error: e.message }, 400);
    throw e;
  }
});
