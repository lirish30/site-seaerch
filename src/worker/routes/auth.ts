import { Hono } from "hono";
import { deleteCookie } from "hono/cookie";
import type { Env } from "../env";
import { loginThrottled, passwordMatches, startSession } from "../auth";

export const authRoutes = new Hono<{ Bindings: Env }>();

authRoutes.post("/login", async (c) => {
  if (await loginThrottled(c)) return c.json({ error: "too many attempts" }, 429);
  const body: unknown = await c.req.json().catch(() => null);
  const password = body && typeof body === "object" && !Array.isArray(body) ? (body as Record<string, unknown>).password : undefined;
  if (typeof password !== "string" || !password || !(await passwordMatches(password, c.env.APP_PASSWORD)))
    return c.json({ error: "wrong password" }, 401);
  await startSession(c);
  return c.json({ ok: true });
});

authRoutes.post("/logout", (c) => { deleteCookie(c, "session", { path: "/" }); return c.json({ ok: true }); });
authRoutes.get("/me", (c) => c.json({ ok: true }));
