import type { Env } from "../env";
import { accessToken, type OAuthClient, type Fetch } from "./oauth";
import { decryptSecret } from "./crypto";
import { getGoogleAuth } from "../db/google";

export function oauthClient(env: Env, origin: string): OAuthClient | null {
  if (!env.GOOGLE_CLIENT_ID || !env.GOOGLE_CLIENT_SECRET) return null;
  return { clientId: env.GOOGLE_CLIENT_ID, clientSecret: env.GOOGLE_CLIENT_SECRET, redirectUri: `${origin}/api/google/callback` };
}

export class GoogleNotConnected extends Error {}

/** A fresh access token for the connected account, or GoogleNotConnected. */
export async function googleAccess(env: Env, origin: string, f: Fetch = fetch) {
  const client = oauthClient(env, origin);
  const row = await getGoogleAuth(env.DB);
  if (!client || !row) throw new GoogleNotConnected("Connect your Google account in Settings first");
  const refresh = await decryptSecret(env.SESSION_SECRET, row.refresh_token_enc);
  return { token: await accessToken(f, client, refresh), row };
}
