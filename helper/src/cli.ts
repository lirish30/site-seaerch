import { existsSync } from "node:fs";
import { pathToFileURL } from "node:url";
import { ApiClient, HELPER_VERSION, TokenRevoked, versionAtLeast } from "./api.ts";
import { configPath, loadConfig, writePairing, type Config } from "./config.ts";
import { runProcess } from "./exec.ts";
import { realMedia } from "./ffmpeg.ts";
import { careCertsHandler } from "./handlers/careCerts.ts";
import { careInventoryHandler } from "./handlers/careInventory.ts";
import { careUpdateHandler } from "./handlers/careUpdate.ts";
import { meetilySyncHandler } from "./handlers/meetilySync.ts";
import { renderHandler } from "./handlers/render.ts";
import { voiceSampleHandler } from "./handlers/voiceSample.ts";
import { voiceSegmentHandler } from "./handlers/voiceSegment.ts";
import { runLoop, type JobHandler } from "./loop.ts";
import { createEngines } from "./voice/engine.ts";

const USAGE = `Siteline Mac helper ${HELPER_VERSION}

  run                          keep asking Agency OS for work and do it (what launchd runs)
  once                         do at most one waiting job, then exit
  doctor                       check the config, the server, the voice engines and the tools
  pair <apiBase> <token>       save where Agency OS is and this Mac's token (use - as the token to read it from stdin)
`;

export interface CliDeps {
  /** The config file; defaults to ~/.siteline-helper/config.json (or SITELINE_HELPER_CONFIG). */
  configPath?: string;
  fetch?: typeof fetch;
  log?: (line: string) => void;
  error?: (line: string) => void;
  signal?: AbortSignal;
  readStdin?: () => Promise<string>;
}

const stamp = (m: string) => `${new Date().toISOString()} ${m}`;
const messageOf = (e: unknown) => (e instanceof Error ? e.message : String(e));

/** The jobs this helper can do: the cloned voice for a line, a clip of the voice test, the render, the Meetily sync, the read of a site's WordPress for care updates, the daily read of TLS certificate expiry dates, and the update of a site (backup, update, page checks, rollback). */
export function buildHandlers(cfg: Config): JobHandler[] {
  const engines = createEngines(cfg);
  const media = realMedia(cfg);
  return [voiceSegmentHandler(engines, media), voiceSampleHandler(engines, media), renderHandler(media), meetilySyncHandler(), careInventoryHandler(), careUpdateHandler(), careCertsHandler()];
}

function abortableSleep(signal?: AbortSignal): (ms: number) => Promise<void> {
  return (ms) => new Promise<void>((resolve) => {
    if (signal?.aborted) return resolve();
    const done = () => { clearTimeout(t); signal?.removeEventListener("abort", done); resolve(); };
    const t = setTimeout(done, ms);
    signal?.addEventListener("abort", done, { once: true });
  });
}

async function readAllStdin(): Promise<string> {
  let s = "";
  for await (const chunk of process.stdin) s += chunk.toString("utf8");
  return s;
}

async function pair(args: string[], d: CliDeps, say: (m: string) => void, complain: (m: string) => void): Promise<number> {
  const [apiBase, tokenArg] = args;
  if (!apiBase || !tokenArg) { complain("usage: pair <apiBase> <token>"); return 2; }
  const token = tokenArg === "-" ? (await (d.readStdin ?? readAllStdin)()).trim() : tokenArg;
  const path = d.configPath ?? configPath();
  try { writePairing(apiBase, token, path); }
  catch (e) { complain(`not paired: ${messageOf(e)}`); return 1; }
  say(`Saved to ${path}.`);
  try {
    const hello = await new ApiClient(loadConfig(path), d.fetch).hello();
    say(`The server accepted this Mac's token (server time ${hello.serverTime}). Next: run \`doctor\`, then \`run\`.`);
    return 0;
  } catch (e) {
    if (e instanceof TokenRevoked) { complain(`The server did not accept that token. ${e.message}`); return 1; }
    complain(`Saved, but the server could not be reached to check the token (${messageOf(e)}). Run \`doctor\` when you are online.`);
    return 0;
  }
}

/** First line of `<tool> <flag>`, or the reason it could not be run. */
async function versionOf(file: string, flag: string): Promise<string> {
  try { return (await runProcess(file, [flag], { timeoutMs: 15_000 })).stdout.split("\n")[0].trim() || "(no version printed)"; }
  catch (e) { return `NOT FOUND (${messageOf(e)})`; }
}

async function doctor(d: CliDeps, say: (m: string) => void): Promise<number> {
  const path = d.configPath ?? configPath();
  let cfg: Config;
  try { cfg = loadConfig(path); }
  catch (e) { say(`config: PROBLEM ${messageOf(e)}`); return 1; }
  let bad = false;
  say(`helper ${HELPER_VERSION}   config ${path}`);
  try {
    const h = await new ApiClient(cfg, d.fetch).hello();
    const fine = versionAtLeast(HELPER_VERSION, h.minHelperVersion);
    if (!fine) bad = true;
    say(`server: ${cfg.apiBase} reachable, token accepted${fine ? "" : `, BUT this helper (${HELPER_VERSION}) is older than the minimum ${h.minHelperVersion}`}`);
  } catch (e) { bad = true; say(`server: ${cfg.apiBase} PROBLEM ${messageOf(e)}`); }
  say("voice engines:");
  for (const [id, engine] of Object.entries(createEngines(cfg))) {
    const r = await engine.available();
    say(`  ${id.padEnd(13)} ${r.ok ? "available" : `NOT available: ${r.why ?? "no reason given"}`}`);
  }
  say("tools:");
  const tools: [string, string, string][] = [["ffmpeg", cfg.ffmpeg, "-version"], ["ffprobe", cfg.ffprobe, "-version"], ["hyperframes", cfg.hyperframes, "--version"]];
  for (const [name, file, flag] of tools) {
    const v = await versionOf(file, flag);
    if (v.startsWith("NOT FOUND") && name !== "hyperframes") bad = true; // ffmpeg and ffprobe are needed for every job; hyperframes only for renders
    say(`  ${name.padEnd(13)} ${v}`);
  }
  // Chrome takes the before/after screenshots of a care update. Only care updates need it, so a missing Chrome is shown but never fails the check.
  const chrome = await versionOf(cfg.chrome, "--version");
  say(`  ${"chrome".padEnd(13)} ${cfg.chrome}  ${chrome.startsWith("NOT FOUND") ? "not found (only needed for care updates)" : chrome}`);
  // Meetily is optional (only the meeting sync needs it), so a missing database is shown but never fails the check.
  say(`meetily:       ${existsSync(cfg.meetilyDb) ? `database found at ${cfg.meetilyDb}` : `database NOT found at ${cfg.meetilyDb} (only needed for the meeting sync)`}`);
  return bad ? 1 : 0;
}

async function work(once: boolean, d: CliDeps, say: (m: string) => void, complain: (m: string) => void): Promise<number> {
  let cfg: Config;
  try { cfg = loadConfig(d.configPath ?? configPath()); }
  catch (e) { complain(messageOf(e)); return 1; }
  const api = new ApiClient(cfg, d.fetch);
  try {
    const h = await api.hello();
    if (!versionAtLeast(HELPER_VERSION, h.minHelperVersion)) { complain(`This helper (${HELPER_VERSION}) is older than the server needs (${h.minHelperVersion}). Update the helper folder and start it again.`); return 1; }
  } catch (e) {
    if (e instanceof TokenRevoked) { complain(e.message); return once ? 1 : 0; }
    if (once) { complain(`cannot reach Agency OS: ${messageOf(e)}`); return 1; }
    say(`Agency OS did not answer hello (${messageOf(e)}); will keep trying.`);
  }
  say(`helper ${HELPER_VERSION} ${once ? "looking for one job" : "running"}; asking ${cfg.apiBase} every ${cfg.pollSeconds}s`);
  try {
    await runLoop({ api, handlers: buildHandlers(cfg), cfg, sleep: abortableSleep(d.signal), once, log: say, signal: d.signal });
  } catch (e) {
    if (e instanceof TokenRevoked) {
      // A revoked token never comes back. Exit 0 so launchd's KeepAlive (restart only after a failure) leaves it stopped instead of restarting it forever.
      complain(e.message);
      return once ? 1 : 0;
    }
    complain(messageOf(e));
    return 1;
  }
  return 0;
}

/** Runs one command and returns the process exit code. Nothing here ever prints the token. */
export async function main(argv: string[], d: CliDeps = {}): Promise<number> {
  const say = d.log ?? ((m: string) => console.log(stamp(m)));
  const complain = d.error ?? ((m: string) => console.error(stamp(m)));
  const [command, ...args] = argv;
  switch (command) {
    case "pair": return pair(args, d, d.log ?? ((m) => console.log(m)), d.error ?? ((m) => console.error(m)));
    case "doctor": return doctor(d, d.log ?? ((m) => console.log(m)));
    case "run": return work(false, d, say, complain);
    case "once": return work(true, d, say, complain);
    default: (command ? complain : say)(command ? `unknown command "${command}"\n${USAGE}` : USAGE); return command ? 2 : 0;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const ac = new AbortController();
  for (const sig of ["SIGINT", "SIGTERM"] as const) process.once(sig, () => ac.abort());
  main(process.argv.slice(2), { signal: ac.signal }).then((code) => process.exit(code), (e) => { console.error(messageOf(e)); process.exit(1); });
}
