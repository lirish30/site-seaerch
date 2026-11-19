import type { MiddlewareHandler } from "hono";
import type { Context } from "hono";
import { getCookie, setCookie } from "hono/cookie";
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

const THIRTY_DAYS = 30 * 24 * 3600;

/** Sign a 30-day session and set the cookie. The one place the session cookie is issued (password and passkey login). */
export async function startSession(c: Context<{ Bindings: Env }>) {
  const token = await signSession(c.env.SESSION_SECRET, Date.now() + THIRTY_DAYS * 1000);
  setCookie(c, "session", token, { httpOnly: true, secure: true, sameSite: "Strict", path: "/", maxAge: THIRTY_DAYS });
}

/** Throttle brute force per client IP. The binding is optional so local/test runs without it still work. True when over the limit. */
export async function loginThrottled(c: Context<{ Bindings: Env }>) {
  const limiter = c.env.LOGIN_LIMITER;
  if (!limiter) return false;
  const { success } = await limiter.limit({ key: c.req.header("cf-connecting-ip") ?? "unknown" });
  return !success;
}

// Only the login entry points are public: everything else under /api/passkey needs a session.
const PUBLIC = new Set(["/api/health", "/api/login", "/api/google/callback", "/api/passkey/login/options", "/api/passkey/login/verify"]);

// The only unauthenticated data routes: the report under this prefix (a single non-empty token segment), its video files (`<token>/media/<name>`; the route
// itself accepts three names), the booking page (`<token>/book`, read and book) and, for POST only, the watch beacon (`<token>/events`) and the guest's
// cancel (`<token>/book/cancel`), nothing else.
const PUBLIC_REPORT_PREFIX = "/api/public/report/";
const isPublicReport = (path: string, method: string) => {
  if (!path.startsWith(PUBLIC_REPORT_PREFIX) || path.length === PUBLIC_REPORT_PREFIX.length) return false;
  const rest = path.slice(PUBLIC_REPORT_PREFIX.length);
  return !rest.includes("/") || /^[^/]+\/media\/[^/]+$/.test(rest) || /^[^/]+\/book$/.test(rest) || (method === "POST" && /^[^/]+\/(events|book\/cancel)$/.test(rest));
};

// A client's proposal page (`GET /api/public/p/<token>`) and click-to-sign (`POST /api/public/p/<token>/sign`): one non-empty token segment each, those methods only.
const isPublicProposal = (path: string, method: string) =>
  (method === "GET" && /^\/api\/public\/p\/[^/]+$/.test(path)) || (method === "POST" && /^\/api\/public\/p\/[^/]+\/sign$/.test(path));

export const requireAuth: MiddlewareHandler<{ Bindings: Env }> = async (c, next) => {
  if (PUBLIC.has(c.req.path) || isPublicReport(c.req.path, c.req.method) || isPublicProposal(c.req.path, c.req.method)) return next();
  const token = getCookie(c, "session");
  if (!token || !(await verifySession(c.env.SESSION_SECRET, token, Date.now()))) return c.json({ error: "unauthorized" }, 401);
  return next();
};
