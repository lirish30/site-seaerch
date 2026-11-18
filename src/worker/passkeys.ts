import type { Context } from "hono";
import type { Env } from "./env";

export type ChallengePurpose = "register" | "login";
const CHALLENGE_TTL_MS = 5 * 60_000;

export function toBase64Url(bytes: Uint8Array): string {
  let s = "";
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

export function fromBase64Url(s: string): Uint8Array<ArrayBuffer> {
  const bin = atob(s.replace(/-/g, "+").replace(/_/g, "/"));
  const out = new Uint8Array(new ArrayBuffer(bin.length));
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

/** A fresh random challenge (base64url), valid for 5 minutes. Expired rows are swept on the way in. */
export async function createChallenge(db: D1Database, purpose: ChallengePurpose, now: Date): Promise<string> {
  const challenge = toBase64Url(crypto.getRandomValues(new Uint8Array(32)));
  await db.batch([
    db.prepare("DELETE FROM auth_challenges WHERE expires_at <= ?").bind(now.toISOString()),
    db.prepare("INSERT INTO auth_challenges (challenge, purpose, expires_at) VALUES (?, ?, ?)")
      .bind(challenge, purpose, new Date(now.getTime() + CHALLENGE_TTL_MS).toISOString()),
  ]);
  return challenge;
}

/**
 * Single use: the row is deleted atomically whatever the outcome, so any attempt (right purpose or not, in time or not)
 * burns the challenge. True only when it existed, matched `purpose` and had not expired.
 */
export async function consumeChallenge(db: D1Database, challenge: string, purpose: ChallengePurpose, now: Date): Promise<boolean> {
  const row = await db.prepare("DELETE FROM auth_challenges WHERE challenge = ? RETURNING purpose, expires_at")
    .bind(challenge).first<{ purpose: string; expires_at: string }>();
  return !!row && row.purpose === purpose && row.expires_at > now.toISOString();
}

/** The challenge a browser signed, read from its clientDataJSON. Null when the payload is not well-formed. */
export function challengeFromClientData(clientDataJSON: unknown): string | null {
  if (typeof clientDataJSON !== "string" || !/^[A-Za-z0-9_-]+$/.test(clientDataJSON)) return null;
  try {
    const parsed: unknown = JSON.parse(new TextDecoder().decode(fromBase64Url(clientDataJSON)));
    const ch = parsed && typeof parsed === "object" ? (parsed as { challenge?: unknown }).challenge : undefined;
    return typeof ch === "string" && ch ? ch : null;
  } catch { return null; }
}

/** RP ID and origin: the optional env overrides, else this request's own host. */
export function relyingParty(c: Context<{ Bindings: Env }>): { rpID: string; origin: string } {
  const url = new URL(c.req.url);
  return { rpID: c.env.WEBAUTHN_RP_ID || url.hostname, origin: c.env.WEBAUTHN_ORIGIN || url.origin };
}
