import { Hono } from "hono";
import { getCookie, setCookie, deleteCookie } from "hono/cookie";
import type { Env } from "../env";
import { authUrl, exchangeCode, revoke, signState, verifyState, hasCalendarScope, hasProfileScope, hasTrafficScopes } from "../google/oauth";
import { encryptSecret, decryptSecret } from "../google/crypto";
import { oauthClient } from "../google/access";
import { getGoogleAuth, saveGoogleAuth, deleteGoogleAuth } from "../db/google";

const NONCE_COOKIE = "g_oauth";

export const googleRoutes = new Hono<{ Bindings: Env }>();

googleRoutes.get("/status", async (c) => {
  const row = await getGoogleAuth(c.env.DB);
  return c.json({ configured: !!oauthClient(c.env, new URL(c.req.url).origin), connected: !!row, email: row?.email ?? null, calendar: hasCalendarScope(row?.scope), traffic: hasTrafficScopes(row?.scope), profile: hasProfileScope(row?.scope), ...(row ? { connected_at: row.connected_at } : {}) });
});

googleRoutes.get("/connect", async (c) => {
  const client = oauthClient(c.env, new URL(c.req.url).origin);
  if (!client) return c.json({ error: "Google isn't configured: set GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET" }, 501);
  const nonce = crypto.randomUUID();
  // Lax (not Strict) so the cookie survives Google's redirect back to us; it only binds the state to this browser.
  setCookie(c, NONCE_COOKIE, nonce, { httpOnly: true, secure: true, sameSite: "Lax", path: "/api/google", maxAge: 600 });
  // ?profile=1 adds the Business Profile permission to the consent; the plain connect asks for it only when the stored connection already has it (a reconnect must not drop a permission that was granted).
  const profile = c.req.query("profile") === "1" || hasProfileScope((await getGoogleAuth(c.env.DB))?.scope);
  return c.redirect(authUrl(client, await signState(c.env.SESSION_SECRET, nonce, Date.now()), { profile }));
});

// Public (see auth.ts): Strict session cookies aren't sent on Google's cross-site redirect, so this route is
// authorized by the signed state + nonce cookie that only /connect (behind the login) can issue.
googleRoutes.get("/callback", async (c) => {
  const origin = new URL(c.req.url).origin;
  const client = oauthClient(c.env, origin);
  const back = (q: string) => c.redirect(`/settings/google?google=${q}`);
  const { code, state, error } = c.req.query();
  const nonce = getCookie(c, NONCE_COOKIE);
  deleteCookie(c, NONCE_COOKIE, { path: "/api/google" });
  if (!client || error || !code || !state || !(await verifyState(c.env.SESSION_SECRET, state, nonce, Date.now()))) return back("failed");
  try {
    const t = await exchangeCode(fetch, client, code);
    if (!t.refresh_token) return back("failed");
    await saveGoogleAuth(c.env.DB, t.email, await encryptSecret(c.env.SESSION_SECRET, t.refresh_token), t.scope ?? null);
    return back("connected");
  } catch {
    return back("failed");
  }
});

googleRoutes.post("/disconnect", async (c) => {
  const row = await getGoogleAuth(c.env.DB);
  if (row) {
    await revoke(fetch, await decryptSecret(c.env.SESSION_SECRET, row.refresh_token_enc)).catch(() => undefined);
    await deleteGoogleAuth(c.env.DB);
  }
  return c.json({ ok: true });
});
