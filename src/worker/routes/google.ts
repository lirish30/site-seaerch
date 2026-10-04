import { Hono } from "hono";
import { getCookie, setCookie, deleteCookie } from "hono/cookie";
import type { Env } from "../env";
import { authUrl, exchangeCode, revoke, signState, verifyState, accessToken, type OAuthClient } from "../google/oauth";
import { encryptSecret, decryptSecret } from "../google/crypto";
import { getGoogleAuth, saveGoogleAuth, deleteGoogleAuth } from "../db/google";

const NONCE_COOKIE = "g_oauth";

export function oauthClient(env: Env, origin: string): OAuthClient | null {
  if (!env.GOOGLE_CLIENT_ID || !env.GOOGLE_CLIENT_SECRET) return null;
  return { clientId: env.GOOGLE_CLIENT_ID, clientSecret: env.GOOGLE_CLIENT_SECRET, redirectUri: `${origin}/api/google/callback` };
}

export class GoogleNotConnected extends Error {}

/** A fresh access token for the connected account, or GoogleNotConnected. */
export async function googleAccess(env: Env, origin: string, f: typeof fetch = fetch) {
  const client = oauthClient(env, origin);
  const row = await getGoogleAuth(env.DB);
  if (!client || !row) throw new GoogleNotConnected("Connect your Google account in Settings first");
  const refresh = await decryptSecret(env.SESSION_SECRET, row.refresh_token_enc);
  return { token: await accessToken(f, client, refresh), row };
}

export const googleRoutes = new Hono<{ Bindings: Env }>();

googleRoutes.get("/status", async (c) => {
  const row = await getGoogleAuth(c.env.DB);
  return c.json({ configured: !!oauthClient(c.env, new URL(c.req.url).origin), connected: !!row, email: row?.email ?? null });
});

googleRoutes.get("/connect", async (c) => {
  const client = oauthClient(c.env, new URL(c.req.url).origin);
  if (!client) return c.json({ error: "Google isn't configured: set GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET" }, 501);
  const nonce = crypto.randomUUID();
  // Lax (not Strict) so the cookie survives Google's redirect back to us; it only binds the state to this browser.
  setCookie(c, NONCE_COOKIE, nonce, { httpOnly: true, secure: true, sameSite: "Lax", path: "/api/google", maxAge: 600 });
  return c.redirect(authUrl(client, await signState(c.env.SESSION_SECRET, nonce, Date.now())));
});

// Public (see auth.ts): Strict session cookies aren't sent on Google's cross-site redirect, so this route is
// authorized by the signed state + nonce cookie that only /connect (behind the login) can issue.
googleRoutes.get("/callback", async (c) => {
  const origin = new URL(c.req.url).origin;
  const client = oauthClient(c.env, origin);
  const back = (q: string) => c.redirect(`/settings?google=${q}`);
  const { code, state, error } = c.req.query();
  const nonce = getCookie(c, NONCE_COOKIE);
  deleteCookie(c, NONCE_COOKIE, { path: "/api/google" });
  if (!client || error || !code || !state || !(await verifyState(c.env.SESSION_SECRET, state, nonce, Date.now()))) return back("failed");
  try {
    const t = await exchangeCode(fetch, client, code);
    if (!t.refresh_token) return back("failed");
    await saveGoogleAuth(c.env.DB, t.email, await encryptSecret(c.env.SESSION_SECRET, t.refresh_token));
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
