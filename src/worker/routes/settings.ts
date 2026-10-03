import { Hono } from "hono";
import { z } from "zod";
import type { Env } from "../env";
import { getSettings, saveSettings } from "../db/settings";
import { monthUsage } from "../db/usage";

const S = z.object({
  your_name: z.string().max(200), business_name: z.string().max(200), contact_email: z.string().max(200),
  services_blurb: z.string().max(2000), signature: z.string().max(1000), physical_address: z.string().max(500),
  opt_out_line: z.string().max(500), tone_notes: z.string().max(5000), monthly_spend_limit_usd: z.number().min(0).max(10000),
}).partial();

export const settingsRoutes = new Hono<{ Bindings: Env }>();

settingsRoutes.get("/", async (c) => c.json({
  settings: await getSettings(c.env.DB), usage: await monthUsage(c.env.DB, new Date().toISOString().slice(0, 7)),
}));

settingsRoutes.put("/", async (c) => {
  const p = S.safeParse(await c.req.json().catch(() => ({})));
  if (!p.success) return c.json({ error: "invalid" }, 400);
  return c.json(await saveSettings(c.env.DB, p.data));
});
