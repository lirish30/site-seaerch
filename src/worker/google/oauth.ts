import { hmacHex } from "./crypto";

// drive.file only sees files this app creates. There is no Gmail scope: outreach goes out through the mailboxes, never through Google.
// A token stored by an earlier consent may still carry the old Gmail scope; it is simply never used.
// calendar.events creates and deletes the booked-call events (with a Meet link); calendar.freebusy reads busy times on the primary calendar only.
const CALENDAR_SCOPES = ["https://www.googleapis.com/auth/calendar.events", "https://www.googleapis.com/auth/calendar.freebusy"];
// webmasters.readonly and analytics.readonly read a client's Search Console and Analytics numbers; nothing writes to either.
export const TRAFFIC_SCOPES = ["https://www.googleapis.com/auth/webmasters.readonly", "https://www.googleapis.com/auth/analytics.readonly"];
export const SCOPES = ["openid", "email", "https://www.googleapis.com/auth/drive.file", ...CALENDAR_SCOPES, ...TRAFFIC_SCOPES];
// business.manage reads a business's Business Profile performance numbers (calls, directions, website clicks). It is asked for only on the explicit profile consent, never by the default connect, and nothing writes to a profile.
export const PROFILE_SCOPE = "https://www.googleapis.com/auth/business.manage";

/** True only when the granted scopes (Google's space-separated string) include BOTH calendar scopes: Google's consent screen lets a person untick one, and booking needs free/busy and events. NULL, from before booking existed, is false. */
export const hasCalendarScope = (scope: string | null | undefined): boolean => {
  const granted = (scope ?? "").split(/\s+/);
  return CALENDAR_SCOPES.every((s) => granted.includes(s));
};

/** True only when BOTH traffic scopes were granted (the consent screen lets a person untick one). NULL, and anything stored before Plan 16, is false. */
export const hasTrafficScopes = (scope: string | null | undefined): boolean => {
  const granted = (scope ?? "").split(/\s+/);
  return TRAFFIC_SCOPES.every((s) => granted.includes(s));
};

/** True only when the Business Profile permission was granted (it is a separate, optional consent). NULL, and anything stored before Task 11, is false. */
export const hasProfileScope = (scope: string | null | undefined): boolean => (scope ?? "").split(/\s+/).includes(PROFILE_SCOPE);

const AUTH_URL = "https://accounts.google.com/o/oauth2/v2/auth";
const TOKEN_URL = "https://oauth2.googleapis.com/token";
const STATE_TTL_MS = 10 * 60 * 1000;

export type Fetch = (url: string, init?: RequestInit) => Promise<Response>;
export interface OAuthClient { clientId: string; clientSecret: string; redirectUri: string; }

/** state = "<nonce>.<expiry>.<hmac>"; the nonce must also match a short-lived cookie set when the flow began. */
export async function signState(secret: string, nonce: string, now: number): Promise<string> {
  const exp = now + STATE_TTL_MS;
  return `${nonce}.${exp}.${await hmacHex(secret, `${nonce}.${exp}`)}`;
}

export async function verifyState(secret: string, state: string, cookieNonce: string | undefined, now: number): Promise<boolean> {
  const [nonce, exp, sig] = state.split(".");
  if (!nonce || !exp || !sig || !cookieNonce || nonce !== cookieNonce || Number(exp) < now) return false;
  const expected = await hmacHex(secret, `${nonce}.${exp}`);
  if (expected.length !== sig.length) return false;
  let diff = 0;
  for (let i = 0; i < sig.length; i++) diff |= expected.charCodeAt(i) ^ sig.charCodeAt(i);
  return diff === 0;
}

// No `include_granted_scopes`: with it Google would fold scopes granted in an earlier consent (the old Gmail one) into a reconnect.
export function authUrl(c: OAuthClient, state: string, o: { profile?: boolean } = {}): string {
  const q = new URLSearchParams({
    client_id: c.clientId, redirect_uri: c.redirectUri, response_type: "code", scope: (o.profile ? [...SCOPES, PROFILE_SCOPE] : SCOPES).join(" "),
    access_type: "offline", prompt: "consent", state,
  });
  return `${AUTH_URL}?${q}`;
}

async function tokenRequest(f: Fetch, body: Record<string, string>) {
  const res = await f(TOKEN_URL, { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body: new URLSearchParams(body) });
  const json = await res.json<any>().catch(() => ({}));
  if (!res.ok) throw new Error(`Google token error: ${json.error_description ?? json.error ?? res.status}`);
  return json as { access_token: string; refresh_token?: string; id_token?: string; expires_in: number; scope?: string };
}

export async function exchangeCode(f: Fetch, c: OAuthClient, code: string) {
  const t = await tokenRequest(f, { code, client_id: c.clientId, client_secret: c.clientSecret, redirect_uri: c.redirectUri, grant_type: "authorization_code" });
  // The id_token came straight from Google's token endpoint over TLS, so its payload can be read without re-verifying.
  let email: string | null = null;
  try { email = JSON.parse(Buffer.from(t.id_token!.split(".")[1], "base64url").toString()).email ?? null; } catch { /* no email scope */ }
  return { ...t, email };
}

export async function accessToken(f: Fetch, c: Pick<OAuthClient, "clientId" | "clientSecret">, refreshToken: string): Promise<string> {
  return (await tokenRequest(f, { refresh_token: refreshToken, client_id: c.clientId, client_secret: c.clientSecret, grant_type: "refresh_token" })).access_token;
}

export async function revoke(f: Fetch, token: string) {
  await f(`https://oauth2.googleapis.com/revoke?token=${encodeURIComponent(token)}`, { method: "POST" }).catch(() => undefined);
}
