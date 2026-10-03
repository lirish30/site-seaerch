import { Hono } from "hono";
import { setCookie, deleteCookie } from "hono/cookie";
import type { Env } from "../env";
import { passwordMatches, signSession } from "../auth";

const THIRTY_DAYS = 30 * 24 * 3600;
export const authRoutes = new Hono<{ Bindings: Env }>();

authRoutes.post("/login", async (c) => {
  // Throttle brute force per client IP. The binding is optional so local/test runs without it still work.
  const limiter = c.env.LOGIN_LIMITER;
  if (limiter) {
    const { success } = await limiter.limit({ key: c.req.header("cf-connecting-ip") ?? "unknown" });
    if (!success) return c.json({ error: "too many attempts" }, 429);
  }
  const body: unknown = await c.req.json().catch(() => null);
  const password = body && typeof body === "object" && !Array.isArray(body) ? (body as Record<string, unknown>).password : undefined;
  if (typeof password !== "string" || !password || !(await passwordMatches(password, c.env.APP_PASSWORD)))
    return c.json({ error: "wrong password" }, 401);
  const token = await signSession(c.env.SESSION_SECRET, Date.now() + THIRTY_DAYS * 1000);
  setCookie(c, "session", token, { httpOnly: true, secure: true, sameSite: "Strict", path: "/", maxAge: THIRTY_DAYS });
  return c.json({ ok: true });
});

authRoutes.post("/logout", (c) => { deleteCookie(c, "session", { path: "/" }); return c.json({ ok: true }); });
authRoutes.get("/me", (c) => c.json({ ok: true }));
