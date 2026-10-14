import { Hono } from "hono";
import { z } from "zod";
import type { Env } from "../env";
import { createWorkSample, deleteWorkSample, listWorkSamples, updateWorkSample } from "../db/workSamples";

// Samples are linked from emails, so only plain https URLs are accepted.
const httpsUrl = z.string().trim().max(500).refine((v) => /^https:\/\/[^\s]+$/.test(v) && URL.canParse(v), "invalid url");
const Sample = z.object({
  title: z.string().trim().min(1).max(120), url: httpsUrl,
  result_line: z.string().trim().max(200).default(""), tags: z.string().trim().max(200).default(""),
});

export const workSampleRoutes = new Hono<{ Bindings: Env }>();

workSampleRoutes.get("/", async (c) => c.json(await listWorkSamples(c.env.DB)));

workSampleRoutes.post("/", async (c) => {
  const p = Sample.safeParse(await c.req.json().catch(() => ({})));
  if (!p.success) return c.json({ error: "invalid" }, 400);
  if ((await listWorkSamples(c.env.DB)).length >= 20) return c.json({ error: "You can keep up to 20 work samples. Delete one first." }, 400);
  return c.json(await createWorkSample(c.env.DB, p.data), 201);
});

workSampleRoutes.put("/:id", async (c) => {
  const p = Sample.partial().safeParse(await c.req.json().catch(() => ({})));
  if (!p.success) return c.json({ error: "invalid" }, 400);
  const r = await updateWorkSample(c.env.DB, c.req.param("id"), p.data);
  return r ? c.json(r) : c.json({ error: "not found" }, 404);
});

workSampleRoutes.delete("/:id", async (c) =>
  (await deleteWorkSample(c.env.DB, c.req.param("id"))) ? c.json({ ok: true }) : c.json({ error: "not found" }, 404));
