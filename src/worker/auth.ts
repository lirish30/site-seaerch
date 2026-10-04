import type { MiddlewareHandler } from "hono";
import { getCookie } from "hono/cookie";
import type { Env } from "./env";

const enc = new TextEncoder();
async function hmac(secret: string, data: string) {
  const key = await crypto.subtle.importKey("raw", enc.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const sig = await crypto.subtle.sign("HMAC", key, enc.encode(data));
  return btoa(String.fromCharCode(...new Uint8Array(sig))).replace(/=+$/, "");
}

export async function signSession(secret: string, expiresAt: number) {
  return `${expiresAt}.${await hmac(secret, String(expiresAt))}`;
}

export async function verifySession(secret: string, token: string, now: number) {
  const [exp, sig] = token.split(".");
  if (!exp || !sig || Number(exp) < now) return false;
  const expected = await hmac(secret, exp);
  if (expected.length !== sig.length) return false;
  let diff = 0;
  for (let i = 0; i < sig.length; i++) diff |= expected.charCodeAt(i) ^ sig.charCodeAt(i);
  return diff === 0;
}

export async function passwordMatches(given: string, actual: string) {
  const [a, b] = await Promise.all([hmac("pw", given), hmac("pw", actual)]);
  return a === b;
}

const PUBLIC = new Set(["/api/health", "/api/login", "/api/google/callback"]);

export const requireAuth: MiddlewareHandler<{ Bindings: Env }> = async (c, next) => {
  if (PUBLIC.has(c.req.path)) return next();
  const token = getCookie(c, "session");
  if (!token || !(await verifySession(c.env.SESSION_SECRET, token, Date.now()))) return c.json({ error: "unauthorized" }, 401);
  return next();
};
