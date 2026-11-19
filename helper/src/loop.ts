import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { ApiError, TokenRevoked, type ClaimedJob, type JobApi } from "./api.ts";
import type { Config } from "./config.ts";

export type { JobApi } from "./api.ts";

export interface JobContext { job: ClaimedJob; api: JobApi; cfg: Config; workDir: string }
/** One kind of work. `run` returns the job's result (sent as-is to `/complete`) or throws, and its message is what the server records as the reason. */
export interface JobHandler { kind: string; run(ctx: JobContext): Promise<unknown> }

export interface LoopDeps {
  api: JobApi;
  handlers: JobHandler[];
  cfg: Config;
  sleep(ms: number): Promise<void>;
  /** Claim at most one job, do it, and return (an empty queue returns at once). */
  once?: boolean;
  log?: (message: string) => void;
  /** When aborted, the loop stops before claiming its next job; a job already running is finished first. */
  signal?: AbortSignal;
}

const COMPLETE_TRIES = 3;
const MAX_BACKOFF_MS = 60_000;

/** The error's words, in one line and short enough for the server to keep, and never empty. */
export function reasonOf(e: unknown): string {
  const raw = e instanceof Error ? e.message : String(e);
  return raw.replace(/\s+/g, " ").trim().slice(0, 1500) || "the helper gave no reason";
}

/** Sends a result, trying again when the network or the server hiccups. A result the server will not take (422) is thrown for the caller to report; one it already has (409, 403, 404) is not an error. */
async function completeWithRetry(job: ClaimedJob, result: unknown, d: LoopDeps, log: (m: string) => void): Promise<void> {
  for (let attempt = 1; ; attempt++) {
    try { await d.api.complete(job.id, result); return; }
    catch (e) {
      if (e instanceof TokenRevoked) throw e;
      if (e instanceof ApiError && [403, 404, 409].includes(e.status)) { log(`job ${job.id}: the server did not take the result (${e.message}); leaving it`); return; }
      if (e instanceof ApiError && e.status >= 400 && e.status < 500 && e.status !== 429) throw e;
      if (attempt >= COMPLETE_TRIES) throw e;
      log(`job ${job.id}: could not send the result (${reasonOf(e)}); trying again`);
      await d.sleep(attempt * 2000);
    }
  }
}

/** Tells the server a job could not be done. A failure to tell is logged and never thrown (except a revoked token), so the loop goes on. */
async function reportFail(job: ClaimedJob, e: unknown, d: LoopDeps, log: (m: string) => void): Promise<void> {
  const reason = reasonOf(e);
  log(`job ${job.id} (${job.kind}) failed: ${reason}`);
  try { await d.api.fail(job.id, reason); }
  catch (err) { if (err instanceof TokenRevoked) throw err; log(`job ${job.id}: could not report the failure (${reasonOf(err)})`); }
}

async function processJob(job: ClaimedJob, d: LoopDeps, log: (m: string) => void): Promise<void> {
  const handler = d.handlers.find((h) => h.kind === job.kind);
  if (!handler) { await reportFail(job, new Error(`this helper cannot do ${job.kind} jobs`), d, log); return; }
  await mkdir(d.cfg.cacheDir, { recursive: true });
  const workDir = await mkdtemp(join(d.cfg.cacheDir, "job-"));
  try {
    log(`job ${job.id}: ${job.kind}${job.attempts > 1 ? ` (claim ${job.attempts})` : ""}`);
    let result: unknown;
    try { result = await handler.run({ job, api: d.api, cfg: d.cfg, workDir }); }
    catch (e) { if (e instanceof TokenRevoked) throw e; await reportFail(job, e, d, log); return; }
    try { await completeWithRetry(job, result, d, log); log(`job ${job.id}: done`); }
    catch (e) { if (e instanceof TokenRevoked) throw e; await reportFail(job, e, d, log); }
  } finally {
    await rm(workDir, { recursive: true, force: true }).catch(() => {});
  }
}

/**
 * Claims jobs and does them, one at a time, until told to stop. One job's failure (reported to the server, work dir deleted) never stops the loop;
 * only a revoked token does, by throwing `TokenRevoked`. An idle poll or a claim that errored sleeps and tries again (errors back off, to a minute).
 */
export async function runLoop(d: LoopDeps): Promise<void> {
  const log = d.log ?? (() => {});
  const kinds = d.handlers.map((h) => h.kind);
  const pollMs = d.cfg.pollSeconds * 1000;
  let errors = 0;
  while (!d.signal?.aborted) {
    let job: ClaimedJob | null;
    try { job = await d.api.claim(kinds); errors = 0; }
    catch (e) {
      if (e instanceof TokenRevoked || d.once) throw e;
      errors++;
      const wait = Math.min(pollMs * 2 ** (errors - 1), MAX_BACKOFF_MS);
      log(`could not ask for work (${reasonOf(e)}); trying again in ${Math.round(wait / 1000)} seconds`);
      await d.sleep(wait);
      continue;
    }
    if (job) {
      await processJob(job, d, log);
      if (d.once) return;
      continue;
    }
    if (d.once) return;
    await d.sleep(pollMs);
  }
}
