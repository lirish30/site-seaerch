import { Hono } from "hono";
import { z } from "zod";
import { ensureSeedSops, getTemplate, listTemplates, saveTemplate, setTemplateActive } from "../db/sops";
import type { Env } from "../env";
import { bodyOf, NOT_FOUND, ownerOnError } from "../projects/http";
import { SopTemplateInputSchema, validateTemplate } from "../sop/model";

/** Mounted at /api: /sops... (behind requireAuth). The SOP editor in Settings: the templates, which are the owner's to edit. Editing one never touches a project already started. */
export const sopRoutes = new Hono<{ Bindings: Env }>();
sopRoutes.onError(ownerOnError);

/** Every template, switched-off ones too. The built-in ones are put in first if they are missing (never over an edit). */
sopRoutes.get("/sops", async (c) => {
  await ensureSeedSops(c.env.DB);
  return c.json({ templates: await listTemplates(c.env.DB, { includeInactive: true }) });
});

sopRoutes.get("/sops/:key", async (c) => {
  const template = await getTemplate(c.env.DB, c.req.param("key"));
  return template ? c.json({ template }) : c.json(NOT_FOUND, 404);
});

/** Saves the template: a new key at version 1, an existing one as its next version. The key in the address is the key in the body. */
sopRoutes.put("/sops/:key", async (c) => {
  const key = c.req.param("key");
  const parsed = SopTemplateInputSchema.safeParse(await c.req.json().catch(() => null));
  if (!parsed.success) {
    const problems = parsed.error.issues.map((i) => i.message);
    return c.json({ error: problems[0] ?? "invalid body", problems }, 400);
  }
  if (parsed.data.key !== key) return c.json({ error: `The template key in the body (${parsed.data.key}) must be the key in the address (${key}).` }, 400);
  const problems = validateTemplate(parsed.data);
  if (problems.length) return c.json({ error: problems.join(" "), problems }, 400);
  await ensureSeedSops(c.env.DB);
  const existed = !!(await getTemplate(c.env.DB, key));
  return c.json({ template: await saveTemplate(c.env.DB, parsed.data) }, existed ? 200 : 201);
});

/** Turns a template off (no new project is made from it) or on. */
sopRoutes.post("/sops/:key/active", async (c) => {
  const body = await bodyOf(c, z.object({ active: z.boolean() }).strict());
  if (body instanceof Response) return body;
  if (!(await setTemplateActive(c.env.DB, c.req.param("key"), body.active))) return c.json(NOT_FOUND, 404);
  return c.json({ template: (await getTemplate(c.env.DB, c.req.param("key")))! });
});
