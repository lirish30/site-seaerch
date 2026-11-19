import { createWriteStream } from "node:fs";
import { readFile, stat } from "node:fs/promises";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import type { Config } from "./config.ts";

/** Keep in step with package.json (a test checks). The server's `minHelperVersion` is compared against this at start. */
export const HELPER_VERSION = "0.1.0";
/** The server refuses an upload over this (MAX_OUTPUT_BYTES in src/worker/routes/helper.ts). Checked here too so a big file fails before it is sent. */
export const MAX_UPLOAD_BYTES = 80 * 1024 * 1024;

/** The device token was revoked (or never was one): nothing this helper sends will ever be accepted again. */
export class TokenRevoked extends Error {
  constructor() { super("This Mac's helper token was revoked or is not valid. Pair the Mac again from Settings > Mac helper in Agency OS."); this.name = "TokenRevoked"; }
}

/** The server answered with an error status. `message` is the server's own reason when it gave one. */
export class ApiError extends Error {
  readonly status: number;
  constructor(status: number, message: string) { super(message); this.name = "ApiError"; this.status = status; }
}

/** A job as `POST /helper/jobs/claim` hands it out: what to do, and the only R2 keys it may read and write. */
export interface ClaimedJob { id: string; kind: string; attempts: number; payload: unknown; inputs: string[]; outputs: string[] }

/** The part of the client the loop and the handlers use, so tests can supply a fake. */
export interface JobApi {
  hello(): Promise<{ serverTime: string; minHelperVersion: string }>;
  claim(kinds: string[]): Promise<ClaimedJob | null>;
  download(jobId: string, key: string, toPath: string): Promise<void>;
  upload(jobId: string, key: string, fromPath: string, contentType: string): Promise<void>;
  complete(jobId: string, result: unknown): Promise<void>;
  fail(jobId: string, error: string): Promise<void>;
}

const isStrings = (v: unknown): v is string[] => Array.isArray(v) && v.every((x) => typeof x === "string");

export class ApiClient implements JobApi {
  private readonly cfg: Pick<Config, "apiBase" | "token">;
  private readonly fetchImpl: typeof fetch;

  constructor(cfg: Pick<Config, "apiBase" | "token">, fetchImpl: typeof fetch = fetch) { this.cfg = cfg; this.fetchImpl = fetchImpl; }

  /** One request. A 401 is `TokenRevoked`; any other non-2xx is an `ApiError` carrying the server's reason. The token is only ever in the header. */
  private async send(path: string, init: RequestInit = {}): Promise<Response> {
    const res = await this.fetchImpl(`${this.cfg.apiBase}/helper${path}`, { ...init, headers: { ...(init.headers as Record<string, string> | undefined), authorization: `Bearer ${this.cfg.token}` } });
    if (res.status === 401) { await res.body?.cancel().catch(() => {}); throw new TokenRevoked(); }
    if (!res.ok) {
      let reason = "";
      try { const j = (await res.json()) as { error?: unknown }; if (typeof j?.error === "string") reason = j.error; } catch { /* not JSON */ }
      throw new ApiError(res.status, reason || `the server answered ${res.status}`);
    }
    return res;
  }

  private post(path: string, body: unknown): Promise<Response> {
    return this.send(path, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
  }

  async hello(): Promise<{ serverTime: string; minHelperVersion: string }> {
    const j = (await (await this.post("/hello", {})).json()) as { serverTime?: unknown; minHelperVersion?: unknown };
    if (typeof j.serverTime !== "string" || typeof j.minHelperVersion !== "string") throw new Error("the server's hello answer was not understood");
    return { serverTime: j.serverTime, minHelperVersion: j.minHelperVersion };
  }

  async claim(kinds: string[]): Promise<ClaimedJob | null> {
    const j = (await (await this.post("/jobs/claim", { kinds })).json()) as { job?: Partial<ClaimedJob> };
    const job = j.job;
    if (!job) return null;
    if (typeof job.id !== "string" || typeof job.kind !== "string" || !isStrings(job.inputs) || !isStrings(job.outputs)) throw new Error("the server sent an unexpected job shape");
    return { id: job.id, kind: job.kind, attempts: typeof job.attempts === "number" ? job.attempts : 1, payload: job.payload, inputs: job.inputs, outputs: job.outputs };
  }

  async download(jobId: string, key: string, toPath: string): Promise<void> {
    const res = await this.send(`/jobs/${encodeURIComponent(jobId)}/input?key=${encodeURIComponent(key)}`);
    if (!res.body) throw new Error(`the server sent no data for ${key}`);
    await pipeline(Readable.fromWeb(res.body as import("node:stream/web").ReadableStream), createWriteStream(toPath));
  }

  async upload(jobId: string, key: string, fromPath: string, contentType: string): Promise<void> {
    const size = (await stat(fromPath)).size;
    if (size > MAX_UPLOAD_BYTES) throw new ApiError(413, `An upload may be at most ${MAX_UPLOAD_BYTES / 1024 / 1024} MB; this file is ${(size / 1024 / 1024).toFixed(1)} MB`);
    // Read whole: a Buffer body carries its own length, which the server streams straight into storage. Even a long render is well under 80 MB.
    const body = await readFile(fromPath);
    await this.send(`/jobs/${encodeURIComponent(jobId)}/output?key=${encodeURIComponent(key)}`, { method: "PUT", headers: { "content-type": contentType }, body });
  }

  async complete(jobId: string, result: unknown): Promise<void> {
    await this.post(`/jobs/${encodeURIComponent(jobId)}/complete`, { result });
  }

  async fail(jobId: string, error: string): Promise<void> {
    await this.post(`/jobs/${encodeURIComponent(jobId)}/fail`, { error });
  }
}

/** True when `have` is the same version as `need` or newer (dotted numbers, as in "0.1.0"). */
export function versionAtLeast(have: string, need: string): boolean {
  const a = have.split(".").map(Number);
  const b = need.split(".").map(Number);
  for (let i = 0; i < Math.max(a.length, b.length); i++) {
    const x = a[i] ?? 0, y = b[i] ?? 0;
    if (x !== y) return x > y;
  }
  return true;
}
