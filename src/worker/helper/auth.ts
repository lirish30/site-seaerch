import type { Context, MiddlewareHandler } from "hono";
import type { Env } from "../env";
import { loginThrottled } from "../auth";

export interface HelperDevice { id: string; name: string; created_at: string; last_seen_at: string | null; revoked_at: string | null }
type DeviceRow = HelperDevice & { token_hash: string };

export const TOKEN_PREFIX = "hlp_";
/** A device that is seen again sooner than this is not written to again, so a helper polling every few seconds costs one write a while, not one per poll. */
const SEEN_EVERY_MS = 20_000;

const enc = new TextEncoder();
const b64url = (b: Uint8Array) => btoa(String.fromCharCode(...b)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");

/** `hlp_` and 32 random bytes, base64url: 43 characters after the prefix. */
export const newToken = (): string => TOKEN_PREFIX + b64url(crypto.getRandomValues(new Uint8Array(32)));

/** The SHA-256 of a token, as hex: the only form of it that is ever stored. */
export async function hashToken(token: string): Promise<string> {
  const d = new Uint8Array(await crypto.subtle.digest("SHA-256", enc.encode(token)));
  return [...d].map((x) => x.toString(16).padStart(2, "0")).join("");
}

/** Equal-length strings compared without stopping at the first difference. */
function sameHash(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

const publicDevice = ({ token_hash: _hash, ...d }: DeviceRow): HelperDevice => d;

/** Pairs a new device. The token is returned here and nowhere else: only its hash is kept. */
export async function createDevice(db: D1Database, name: string): Promise<{ device: HelperDevice; token: string }> {
  const token = newToken();
  const row: DeviceRow = { id: crypto.randomUUID(), name: name.trim(), token_hash: await hashToken(token), created_at: new Date().toISOString(), last_seen_at: null, revoked_at: null };
  await db.prepare(`INSERT INTO helper_devices (id, name, token_hash, created_at) VALUES (?,?,?,?)`).bind(row.id, row.name, row.token_hash, row.created_at).run();
  return { device: publicDevice(row), token };
}

/** Paired devices, newest first. Revoked ones are left out. Never the token or its hash. */
export async function listDevices(db: D1Database): Promise<HelperDevice[]> {
  return (await db.prepare(`SELECT id, name, created_at, last_seen_at, revoked_at FROM helper_devices WHERE revoked_at IS NULL ORDER BY created_at DESC, rowid DESC`).all<HelperDevice>()).results;
}

/** Revokes a device: its token stops working at once. False when there is no such live device. */
export async function revokeDevice(db: D1Database, id: string): Promise<boolean> {
  const r = await db.prepare(`UPDATE helper_devices SET revoked_at = ? WHERE id = ? AND revoked_at IS NULL`).bind(new Date().toISOString(), id).run();
  return (r.meta.changes ?? 0) > 0;
}

/** The live device a bearer header belongs to, or null. The token is matched by its hash, and the hashes are then compared in constant time. */
export async function deviceForHeader(db: D1Database, header: string | undefined): Promise<HelperDevice | null> {
  const m = /^Bearer (hlp_[A-Za-z0-9_-]{43})$/.exec(header ?? "");
  if (!m) return null;
  const hash = await hashToken(m[1]);
  const row = await db.prepare(`SELECT * FROM helper_devices WHERE token_hash = ?`).bind(hash).first<DeviceRow>();
  if (!row || !sameHash(row.token_hash, hash) || row.revoked_at) return null;
  return publicDevice(row);
}

/** Notes that a device was just seen, unless it was seen a moment ago (`force` always writes). */
export async function touchDevice(db: D1Database, id: string, now: Date, force = false): Promise<void> {
  const now_ = now.toISOString();
  const before = new Date(now.getTime() - (force ? 0 : SEEN_EVERY_MS)).toISOString();
  await db.prepare(`UPDATE helper_devices SET last_seen_at = ? WHERE id = ? AND (last_seen_at IS NULL OR last_seen_at < ?)`).bind(now_, id, before).run();
}

export type HelperEnv = { Bindings: Env; Variables: { device: HelperDevice } };
export const deviceOf = (c: Context<HelperEnv>): HelperDevice => c.get("device");

/**
 * Guards every /helper route: a valid, unrevoked device token and nothing else. The login cookie is not looked at, so it can never open these
 * routes. Failed attempts spend the per-IP budget (as /mcp does), so a valid token is never throttled.
 */
export const requireHelper: MiddlewareHandler<HelperEnv> = async (c, next) => {
  const device = await deviceForHeader(c.env.DB, c.req.header("authorization"));
  if (!device) {
    if (await loginThrottled(c as unknown as Context<{ Bindings: Env }>)) return c.json({ error: "too many attempts" }, 429);
    return c.json({ error: "unauthorized" }, 401, { "www-authenticate": "Bearer" });
  }
  c.set("device", device);
  await touchDevice(c.env.DB, device.id, new Date(), c.req.path === "/helper/hello");
  return next();
};
