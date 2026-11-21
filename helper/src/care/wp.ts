import type { Exec } from "../exec.ts";

/**
 * The fixed shapes of every value that can reach a remote shell (Plan 12). A copy of src/worker/care/args.ts: the helper has no dependency on the Worker, and
 * both sides check every value, so a bad site record is stopped twice. No space, quote, `$`, backtick, `;`, `|`, `&`, newline or `..` can match any of them.
 */
export const WP_ARG = {
  alias: /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/,
  path: /^\/(?!.*\.\.)[A-Za-z0-9._/-]{1,200}$/,
  slug: /^[A-Za-z0-9][A-Za-z0-9._-]{0,99}$/,
  version: /^[0-9][0-9A-Za-z.+-]{0,30}$/,
  checkPath: /^\/(?!.*\.\.)[A-Za-z0-9._~/%-]{0,200}$/,
} as const;

/** One word of a wp-cli command line: a command name, a flag, or a flag with a value. Wider than a slug (it holds `--fields=a,b`), still no shell syntax and no `..`. */
const WORD = /^(?!.*\.\.)[A-Za-z0-9_./=,:+@%-]{1,300}$/;

export class WpError extends Error {}

/** Wraps a word in single quotes for the remote shell; a single quote inside becomes `'\''`. */
export const quoteRemote = (word: string): string => `'${word.replace(/'/g, `'\\''`)}'`;

/** The last line of the output that is JSON (wp-cli may print PHP notices or a plugin's banner before it). */
export function parseLastJson(stdout: string): unknown {
  const lines = stdout.split("\n");
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i].trim();
    if (!/^[[{"]/.test(line)) continue;
    try { return JSON.parse(line); } catch { /* not JSON: keep looking up */ }
  }
  throw new WpError("wp-cli gave no readable answer");
}

/**
 * Runs `wp <args>` in the install at `t.path` on the host `t.alias` over SSH and returns its whole stdout. The alias, the path and every word are checked first and nothing is spawned
 * if one is not valid. `ssh` is started with an argument list (no local shell), `BatchMode` so a missing key fails instead of asking, and each remote word is single-quoted.
 */
export async function wpRaw(exec: Exec, t: { alias: string; path: string }, args: string[], o: { timeoutMs: number }): Promise<string> {
  if (!WP_ARG.alias.test(t.alias) || !WP_ARG.path.test(t.path) || !args.every((a) => WORD.test(a))) throw new WpError("this site's SSH settings are not valid");
  try {
    return (await exec(
      "ssh",
      ["-o", "BatchMode=yes", "-o", "ConnectTimeout=15", t.alias, "--", "wp", `--path=${quoteRemote(t.path)}`, ...args.map(quoteRemote)],
      { timeoutMs: o.timeoutMs },
    )).stdout;
  } catch (e) {
    throw new WpError((e instanceof Error ? e.message : String(e)).slice(0, 300));
  }
}

/** `wpRaw`, and the last line of it that is JSON. */
export async function wp(exec: Exec, t: { alias: string; path: string }, args: string[], o: { timeoutMs: number }): Promise<unknown> {
  return parseLastJson(await wpRaw(exec, t, args, o));
}

/** `wpRaw`, and the last non-empty line, trimmed: for a command that prints plain text (`wp core version`). */
export async function wpText(exec: Exec, t: { alias: string; path: string }, args: string[], o: { timeoutMs: number }): Promise<string> {
  const line = (await wpRaw(exec, t, args, o)).split("\n").map((l) => l.trim()).filter(Boolean).pop();
  if (!line) throw new WpError("wp-cli gave no readable answer");
  return line;
}
