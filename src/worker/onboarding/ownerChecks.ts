import { cleanText } from "./templates";

/** The checks on what the owner types in the onboarding panel. Pure: the panel runs the same ones before it sends, and the server runs them again. */

export type Checked<T> = { ok: true; value: T } | { ok: false; error: string };

const VIDEO_MAX = 300;
/** A query or fragment name that carries a login: password, token, key, secret, signature and the like. */
const SECRET_NAME = /(pass|pwd|secret|token|auth|credential|session|signature|api[-_.]?key|(^|[-_.])(key|sig)($|[-_.]))/i;

/**
 * The welcome video's link, cleaned: https only, at most 300 characters, no spaces or invisible characters, no username or password in it, and no password,
 * token or key in its query or fragment (a link like that is a login, and it would go into an email). Blank clears it (null).
 */
export function checkVideoUrl(raw: string): Checked<string | null> {
  const trimmed = raw.trim();
  if (!trimmed) return { ok: true, value: null };
  if (trimmed.length > VIDEO_MAX) return { ok: false, error: `The link is longer than ${VIDEO_MAX} characters.` };
  if (cleanText(trimmed, VIDEO_MAX + 1) !== trimmed || /\s/.test(trimmed)) return { ok: false, error: "The link has spaces or hidden characters in it." };
  let u: URL;
  try { u = new URL(trimmed); } catch { return { ok: false, error: "That is not a web link." }; }
  if (u.protocol !== "https:") return { ok: false, error: "The link must start with https://." };
  if (!u.hostname.includes(".")) return { ok: false, error: "That is not a web link." };
  if (u.username || u.password) return { ok: false, error: "The link must not carry a username or password." };
  const names = [...new URLSearchParams(u.search).keys(), ...new URLSearchParams(u.hash.replace(/^#\/?/, "").replace(/^[^?=]*\?/, "")).keys()];
  if (names.some((n) => SECRET_NAME.test(n))) return { ok: false, error: "The link must not carry a password, token or key. Use a link anyone can open." };
  if (u.href.length > VIDEO_MAX) return { ok: false, error: `The link is longer than ${VIDEO_MAX} characters.` };
  return { ok: true, value: u.href };
}

const ISO = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::(\d{2})(?:\.\d{1,3})?)?(Z|[+-]\d{2}:\d{2})$/;

/** A real ISO time with a zone ("2026-12-10T10:30:00-08:00", "...Z"), as the UTC instant: a day that does not exist or an hour past 23 is refused. */
export function checkKickoff(raw: string): Checked<string> {
  const m = ISO.exec(raw);
  if (!m) return { ok: false, error: "Give the time as an ISO date and time with a zone, such as 2026-12-10T10:30:00-08:00." };
  const [y, mo, d, h, mi, s] = [m[1], m[2], m[3], m[4], m[5], m[6] ?? "0"].map(Number);
  const day = new Date(Date.UTC(y, mo - 1, d));
  const real = day.getUTCFullYear() === y && day.getUTCMonth() === mo - 1 && day.getUTCDate() === d && h <= 23 && mi <= 59 && s <= 59;
  const at = Date.parse(raw);
  if (!real || !Number.isFinite(at) || y < 2000 || y > 2100) return { ok: false, error: "That is not a real date and time." };
  return { ok: true, value: new Date(at).toISOString() };
}
