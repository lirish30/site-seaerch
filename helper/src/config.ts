import { chmodSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

export const ENGINE_IDS = ["qwen3-tts", "chatterbox", "openvoice-v2"] as const;
export type EngineId = (typeof ENGINE_IDS)[number];

export interface Config {
  apiBase: string;
  token: string;
  pollSeconds: number;
  cacheDir: string;
  python: Record<EngineId, string>;
  ffmpeg: string;
  ffprobe: string;
  hyperframes: string;
}

/** Where the helper keeps its one file and its cache. */
export const helperHome = (): string => join(homedir(), ".siteline-helper");
/** `~/.siteline-helper/config.json`, or the file named by SITELINE_HELPER_CONFIG (tests, a second helper on one Mac). */
export const configPath = (): string => process.env.SITELINE_HELPER_CONFIG || join(helperHome(), "config.json");

const DEFAULT_POLL_SECONDS = 5;
const isLocal = (host: string) => host === "localhost" || host === "127.0.0.1" || host === "[::1]" || host.endsWith(".localhost");

/** The API base as stored: no trailing slash, https (plain http only for a server on this Mac, so the token never crosses a network in the clear). Throws naming `apiBase`. */
export function normaliseApiBase(raw: unknown): string {
  if (typeof raw !== "string" || !raw.trim()) throw new Error("apiBase is missing: it is the address of your Agency OS site, such as https://agency.example.com");
  let u: URL;
  try { u = new URL(raw.trim()); } catch { throw new Error(`apiBase "${raw}" is not a web address`); }
  if (u.protocol !== "https:" && !(u.protocol === "http:" && isLocal(u.hostname))) throw new Error(`apiBase must start with https:// (got ${u.protocol}//)`);
  return u.origin + u.pathname.replace(/\/+$/, "");
}

/** A device token: `hlp_` and 43 URL-safe characters. Throws naming `token`, without ever repeating the value. */
export function checkToken(raw: unknown): string {
  if (typeof raw !== "string" || !raw) throw new Error("token is missing: run `pair <apiBase> <token>` with the token from Settings > Mac helper");
  if (!/^hlp_[A-Za-z0-9_-]{43}$/.test(raw)) throw new Error("token is not a helper token (it starts with hlp_); copy it again from Settings > Mac helper");
  return raw;
}

function text(o: Record<string, unknown>, field: string, fallback: string, label = field): string {
  const v = o[field];
  if (v === undefined) return fallback;
  if (typeof v !== "string" || !v.trim()) throw new Error(`${label} must be a non-empty string`);
  return v;
}

/** Reads and checks the config file. Any problem is thrown as a message that names the field. */
export function loadConfig(path: string = configPath()): Config {
  let raw: string;
  try { raw = readFileSync(path, "utf8"); }
  catch { throw new Error(`no helper config at ${path}. Run: node helper/src/cli.ts pair <apiBase> <token>`); }
  let o: unknown;
  try { o = JSON.parse(raw); } catch { throw new Error(`${path} is not valid JSON`); }
  if (!o || typeof o !== "object" || Array.isArray(o)) throw new Error(`${path} must hold a JSON object`);
  const c = o as Record<string, unknown>;

  const apiBase = normaliseApiBase(c.apiBase);
  const token = checkToken(c.token);
  const pollSeconds = c.pollSeconds === undefined ? DEFAULT_POLL_SECONDS : c.pollSeconds;
  if (typeof pollSeconds !== "number" || !Number.isFinite(pollSeconds) || pollSeconds < 1 || pollSeconds > 3600) throw new Error("pollSeconds must be a number from 1 to 3600");

  const pyIn = c.python;
  if (pyIn !== undefined && (!pyIn || typeof pyIn !== "object" || Array.isArray(pyIn))) throw new Error("python must be an object keyed by engine");
  const py = (pyIn ?? {}) as Record<string, unknown>;
  const python = Object.fromEntries(ENGINE_IDS.map((id) => [id, text(py, id, join(helperHome(), "venvs", id, "bin", "python"), `python.${id}`)])) as Record<EngineId, string>;

  return {
    apiBase, token, pollSeconds, python,
    cacheDir: text(c, "cacheDir", join(helperHome(), "cache")),
    ffmpeg: text(c, "ffmpeg", "ffmpeg"),
    ffprobe: text(c, "ffprobe", "ffprobe"),
    hyperframes: text(c, "hyperframes", "hyperframes"),
  };
}

/**
 * Saves a pairing: `apiBase` and `token` go into the config file (owner-only, 0600), and every other setting already in it is kept. The file is
 * written to a temporary name and moved into place, so a crash never leaves half a token on disk.
 */
export function writePairing(apiBase: string, token: string, path: string = configPath()): void {
  const base = normaliseApiBase(apiBase);
  checkToken(token);
  let existing: Record<string, unknown> = {};
  try { const parsed: unknown = JSON.parse(readFileSync(path, "utf8")); if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) existing = parsed as Record<string, unknown>; } catch { /* no usable file yet */ }
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const tmp = `${path}.${process.pid}.tmp`;
  writeFileSync(tmp, JSON.stringify({ ...existing, apiBase: base, token }, null, 2) + "\n", { mode: 0o600 });
  chmodSync(tmp, 0o600);
  renameSync(tmp, path);
}
