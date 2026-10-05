import { Hono } from "hono";
import { z } from "zod";
import type { Env } from "../env";
import { SUPPRESSION_REASONS } from "../types";
import { addSuppression, InvalidSuppression, listSuppressions, removeSuppression } from "../db/suppression";
import { isDuplicateKey } from "../db/services";

export const Reason = z.enum(SUPPRESSION_REASONS, { error: `reason must be one of ${SUPPRESSION_REASONS.join(", ")}` });
export const Note = z.string().trim().max(500).optional();

const NewSuppression = z.object({
  kind: z.enum(["domain", "place_id"]).default("domain"),
  value: z.string().trim().min(1, "enter a domain such as acme.com").max(300), reason: Reason, note: Note,
});

export const bad = (e: z.ZodError) => e.issues.map((i) => (i.path.length ? `${i.path.join(".")}: ` : "") + i.message).join("; ");

export const suppressionRoutes = new Hono<{ Bindings: Env }>();

suppressionRoutes.get("/", async (c) => c.json(await listSuppressions(c.env.DB)));

suppressionRoutes.post("/", async (c) => {
  const parsed = NewSuppression.safeParse(await c.req.json().catch(() => ({})));
  if (!parsed.success) return c.json({ error: bad(parsed.error) }, 400);
  try { return c.json(await addSuppression(c.env.DB, parsed.data), 201); }
  catch (e) {
    if (e instanceof InvalidSuppression) return c.json({ error: e.message }, 400);
    if (isDuplicateKey(e)) return c.json({ error: "that is already on the suppression list" }, 409);
    throw e;
  }
});

suppressionRoutes.delete("/:id", async (c) =>
  (await removeSuppression(c.env.DB, c.req.param("id"))) ? c.json({ ok: true }) : c.json({ error: "not found" }, 404));
