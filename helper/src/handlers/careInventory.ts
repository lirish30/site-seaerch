import { WP_ARG, WpError, parseLastJson, wp, wpRaw, wpText } from "../care/wp.ts";
import { runProcess, type Exec } from "../exec.ts";
import type { JobHandler } from "../loop.ts";
import { payloadOf, textField } from "./clone.ts";

const TIMEOUT_MS = 120_000;
const MAX_PLUGINS = 300;
const MAX_THEMES = 50;
const LIST = "--fields=name,title,status,version,update_version,update_package";

type Target = { alias: string; path: string };
interface Item { slug: string; name: string; status: string; version: string; updateVersion: string | null; fromWporg: boolean }

const str = (v: unknown): string => (typeof v === "string" ? v.trim() : typeof v === "number" ? String(v) : "");
const cut = (s: string): string => s.slice(0, 200);

/** True only for an https package on downloads.wordpress.org itself (not a host that merely contains the name). */
function fromWordpressOrg(pkg: string): boolean {
  try { const u = new URL(pkg); return u.protocol === "https:" && u.hostname === "downloads.wordpress.org"; } catch { return false; }
}

/**
 * One row of `wp plugin list` or `wp theme list`. A row whose slug is not a safe slug is left out. A row with an update whose own or new version is not a safe version
 * is reported without the update: it could not be updated, or rolled back, safely.
 */
function itemOf(row: unknown): Item | null {
  if (!row || typeof row !== "object") return null;
  const r = row as Record<string, unknown>;
  const slug = str(r.name);
  if (!WP_ARG.slug.test(slug)) return null;
  const version = str(r.version);
  const to = str(r.update_version);
  const wanted = !!to && to.toLowerCase() !== "none";
  const ok = wanted && WP_ARG.version.test(to) && WP_ARG.version.test(version);
  return {
    slug, name: cut(str(r.title) || slug), status: cut(str(r.status)), version: cut(version),
    updateVersion: ok ? to : null, fromWporg: ok && fromWordpressOrg(str(r.update_package)),
  };
}

/** The rows that are safe to use, at most `max`, and how many were left out (refused by validation, or cut by the cap). */
function itemsOf(answer: unknown, max: number): { items: Item[]; dropped: number } {
  if (!Array.isArray(answer)) throw new WpError("wp-cli gave no readable answer");
  const ok = answer.map(itemOf).filter((i): i is Item => i !== null);
  return { items: ok.slice(0, max), dropped: answer.length - Math.min(ok.length, max) };
}

const UP_TO_DATE = /^Success: WordPress is at the latest version\.?$/;

/** The version wp-cli offers for core, or null. "No update" is only ever wp-cli's own up-to-date sentence (or an empty list); anything else without JSON (empty, HTML, a PHP fatal) is an error. */
async function coreUpdate(exec: Exec, t: Target): Promise<{ to: string } | null> {
  const out = await wpRaw(exec, t, ["core", "check-update", "--format=json"], { timeoutMs: TIMEOUT_MS });
  if (out.split("\n").some((l) => UP_TO_DATE.test(l.trim()))) return null;
  const answer = parseLastJson(out);
  if (!Array.isArray(answer)) throw new WpError("wp-cli gave no readable answer");
  for (const u of answer) {
    const v = str((u as Record<string, unknown> | null)?.version);
    if (WP_ARG.version.test(v)) return { to: v };
  }
  return null;
}

/**
 * Reads one site's WordPress over SSH: its versions, its plugins and themes, and the updates waiting. Five read-only wp-cli commands; `wp eval`, `wp shell` and `wp db query` are never run.
 * Everything it reads is untrusted text: cut to length here and checked again by the Worker.
 */
export function careInventoryHandler(exec: Exec = runProcess): JobHandler {
  return {
    kind: "care.inventory",
    async run({ job }) {
      const p = payloadOf(job);
      const t: Target = { alias: textField(p, "alias"), path: textField(p, "path") };
      if (!WP_ARG.alias.test(t.alias) || !WP_ARG.path.test(t.path)) throw new WpError("this site's SSH settings are not valid");
      const o = { timeoutMs: TIMEOUT_MS };
      const wpVersion = await wpText(exec, t, ["core", "version"], o);
      if (!WP_ARG.version.test(wpVersion)) throw new WpError("wp-cli gave no readable answer");
      const info = await wp(exec, t, ["cli", "info", "--format=json"], o);
      const core = await coreUpdate(exec, t);
      const pl = itemsOf(await wp(exec, t, ["plugin", "list", LIST, "--format=json"], o), MAX_PLUGINS);
      const th = itemsOf(await wp(exec, t, ["theme", "list", LIST, "--format=json"], o), MAX_THEMES);
      const php = info && typeof info === "object" ? str((info as Record<string, unknown>).php_version) : "";
      return {
        wpVersion,
        phpVersion: cut(php) || null,
        core,
        plugins: pl.items,
        themes: th.items,
        activeTheme: th.items.find((x) => x.status === "active")?.slug ?? null,
        dropped: pl.dropped + th.dropped,
      };
    },
  };
}
