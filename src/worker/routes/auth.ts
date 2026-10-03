import { Hono } from "hono";
import { setCookie, deleteCookie } from "hono/cookie";
import type { Env } from "../env";
import { passwordMatches, signSession } from "../auth";

const THIRTY_DAYS = 30 * 24 * 3600;
export const authRoutes = new Hono<{ Bindings: Env }>();

authRoutes.post("/login", async (c) => {
  const { password } = await c.req.json<{ password?: string }>().catch(() => ({ password: "" }));
  if (!password || !(await passwordMatches(password, c.env.APP_PASSWORD))) return c.json({ error: "wrong password" }, 401);
  const token = await signSession(c.env.SESSION_SECRET, Date.now() + THIRTY_DAYS * 1000);
  setCookie(c, "session", token, { httpOnly: true, secure: true, sameSite: "Strict", path: "/", maxAge: THIRTY_DAYS });
  return c.json({ ok: true });
});

authRoutes.post("/logout", (c) => { deleteCookie(c, "session", { path: "/" }); return c.json({ ok: true }); });
authRoutes.get("/me", (c) => c.json({ ok: true }));
