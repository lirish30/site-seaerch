import { Hono } from "hono";
import { z } from "zod";
import type { Env } from "../env";
import { createDevice, listDevices, revokeDevice } from "../helper/auth";
import { helperStatus } from "../helper/jobs";
import "../helper/kinds"; // the status counts jobs by kind, so every kind must be registered

/** What the app shows about the Mac helper (behind the login cookie): whether it is online, and its paired devices. */
export const helperAdminRoutes = new Hono<{ Bindings: Env }>();

helperAdminRoutes.get("/status", async (c) => c.json(await helperStatus(c.env.DB, new Date())));

helperAdminRoutes.get("/devices", async (c) => c.json({ devices: await listDevices(c.env.DB) }));

const DeviceBody = z.object({ name: z.string().trim().min(1, "Give the device a name").max(60) });

/** Pairs a device. The token is in this response and nowhere else: only its hash is stored. */
helperAdminRoutes.post("/devices", async (c) => {
  const body = DeviceBody.safeParse(await c.req.json().catch(() => null));
  if (!body.success) return c.json({ error: body.error.issues[0]?.message ?? "invalid" }, 400);
  const made = await createDevice(c.env.DB, body.data.name);
  return c.json(made, 201, { "cache-control": "no-store" });
});

helperAdminRoutes.delete("/devices/:id", async (c) => {
  if (!(await revokeDevice(c.env.DB, c.req.param("id")))) return c.json({ error: "not found" }, 404);
  return c.json({ ok: true });
});
