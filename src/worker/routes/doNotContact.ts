import { Hono } from "hono";
import { z } from "zod";
import type { Env } from "../env";
import { addDoNotContact, DO_NOT_CONTACT_KINDS, DO_NOT_CONTACT_REASONS, InvalidDoNotContact, listDoNotContact, removeDoNotContact } from "../db/doNotContact";
import { isDuplicateKey } from "../db/services";
import { bad } from "./suppressions";

const NewEntry = z.object({
  kind: z.enum(DO_NOT_CONTACT_KINDS, { error: `kind must be one of ${DO_NOT_CONTACT_KINDS.join(", ")}` }),
  value: z.string().trim().min(1, "enter a value").max(300),
  reason: z.enum(DO_NOT_CONTACT_REASONS, { error: `reason must be one of ${DO_NOT_CONTACT_REASONS.join(", ")}` }),
  note: z.string().trim().max(500).optional(),
});

export const doNotContactRoutes = new Hono<{ Bindings: Env }>();

doNotContactRoutes.get("/", async (c) => c.json(await listDoNotContact(c.env.DB)));

doNotContactRoutes.post("/", async (c) => {
  const parsed = NewEntry.safeParse(await c.req.json().catch(() => ({})));
  if (!parsed.success) return c.json({ error: bad(parsed.error) }, 400);
  try { return c.json(await addDoNotContact(c.env.DB, parsed.data), 201); }
  catch (e) {
    if (e instanceof InvalidDoNotContact) return c.json({ error: e.message }, 400);
    if (isDuplicateKey(e)) return c.json({ error: "that is already on the do-not-contact list" }, 409);
    throw e;
  }
});

doNotContactRoutes.delete("/:id", async (c) =>
  (await removeDoNotContact(c.env.DB, c.req.param("id"))) ? c.json({ ok: true }) : c.json({ error: "not found" }, 404));
